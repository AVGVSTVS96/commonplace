import { Database } from "bun:sqlite";
import { createDecipheriv, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, watch } from "node:fs";
import { basename, dirname } from "node:path";

import type { ServerWebSocket, Socket } from "bun";

const token = process.env["BOX_TOKEN"] ?? "";
/**
 * A login page to open for a person. Sites refuse sign-ins from a browser DevTools controls, so a sign-in
 * box runs Chrome without it and reads the session from Chrome's own cookie store instead.
 */
const signin = process.env["BOX_SIGNIN"];
const display = ":1";
const vncPort = 5901;
const profile = `${process.env["HOME"]}/profile`;
const novnc = "/opt/novnc";

if (token.length < 32) {
  throw new Error("BOX_TOKEN must be at least 32 characters");
}

const appears = async (path: string): Promise<void> => {
  if (!existsSync(dirname(path))) {
    await appears(dirname(path));
  }

  return new Promise((resolve) => {
    const watcher = watch(dirname(path), (_, name) => {
      if (name === basename(path) && existsSync(path)) {
        watcher.close();
        resolve();
      }
    });
    if (existsSync(path)) {
      watcher.close();
      resolve();
    }
  });
};

const must = (child: Bun.Subprocess, name: string) =>
  void child.exited.then((code) => {
    console.error(`${name} exited with ${code}`);
    process.exit(1);
  });

must(
  Bun.spawn(
    ["Xvnc", display, "-geometry", "1440x900", "-depth", "24", "-SecurityTypes", "None", "-localhost", "yes"],
    { stdio: ["ignore", "inherit", "inherit"] },
  ),
  "Xvnc",
);
await appears(`/tmp/.X11-unix/X${display.slice(1)}`);
mkdirSync(profile, { recursive: true });

must(
  Bun.spawn(
    [
      "google-chrome-stable",
      `--user-data-dir=${profile}`,
      ...(signin === undefined ? ["--remote-debugging-port=0"] : []),
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--hide-crash-restore-bubble",
      "--disable-dev-shm-usage",
      "--window-position=0,0",
      "--window-size=1440,900",
      ...(signin === undefined ? [] : [signin]),
    ],
    { env: { ...process.env, DISPLAY: display }, stdio: ["ignore", "inherit", "inherit"] },
  ),
  "chrome",
);

const devtools = async (): Promise<string> => {
  await appears(`${profile}/DevToolsActivePort`);
  const [port, path] = readFileSync(`${profile}/DevToolsActivePort`, "utf8").split("\n");

  return `ws://127.0.0.1:${port}${path}`;
};
const upstream = signin === undefined ? await devtools() : null;

/** Chrome's "basic" password store encrypts cookies with this fixed key, so only the file's permissions guard them. */
const cookieKey = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
const cookieStore = `${profile}/Default/Cookies`;
const sameSite = ["None", "Lax", "Strict"];

interface StoredCookie {
  readonly host_key: string;
  readonly name: string;
  readonly path: string;
  readonly encrypted_value: Uint8Array;
  readonly expires_utc: number;
  readonly has_expires: number;
  readonly is_httponly: number;
  readonly is_secure: number;
  readonly samesite: number;
}

/** Every saved cookie, in the shape DevTools uses. Values carry a SHA-256 of their host in front. */
const cookies = () => {
  const db = new Database(cookieStore, { readonly: true });
  try {
    return db
      .query<StoredCookie, []>("SELECT * FROM cookies")
      .all()
      .map((cookie) => {
        const decipher = createDecipheriv("aes-128-cbc", cookieKey, Buffer.alloc(16, " "));
        const value = Buffer.concat([
          decipher.update(cookie.encrypted_value.subarray(3)),
          decipher.final(),
        ]).subarray(32);

        return {
          name: cookie.name,
          value: value.toString(),
          domain: cookie.host_key,
          path: cookie.path,
          expires: cookie.has_expires === 1 ? cookie.expires_utc / 1e6 - 11_644_473_600 : -1,
          httpOnly: cookie.is_httponly === 1,
          secure: cookie.is_secure === 1,
          sameSite: sameSite[cookie.samesite],
        };
      });
  } finally {
    db.close();
  }
};

const allowed = (url: URL): boolean => {
  const given = Buffer.from(url.searchParams.get("token") ?? "");

  return given.length === token.length && timingSafeEqual(given, Buffer.from(token));
};

interface Pipe {
  readonly kind: "cdp" | "cookies" | "vnc";
  pending: Array<string | Buffer>;
  send?: (message: string | Buffer) => void;
  close?: () => void;
}

let controllers = 0;

const open = (ws: ServerWebSocket<Pipe>, connect: (pipe: Pipe) => void) => {
  connect(ws.data);
  for (const message of ws.data.pending.splice(0)) {
    ws.data.send?.(message);
  }
};

Bun.serve<Pipe>({
  port: 8080,
  idleTimeout: 0,

  fetch: (request, server) => {
    const url = new URL(request.url);

    const kind = ({ "/cdp": "cdp", "/cookies": "cookies", "/websockify": "vnc" } as const)[url.pathname];

    if (kind === "vnc" || kind === (signin === undefined ? "cdp" : "cookies")) {
      if (!allowed(url)) {
        return new Response("Forbidden", { status: 403 });
      }

      return server.upgrade(request, { data: { kind, pending: [] } })
        ? undefined
        : new Response("Expected a WebSocket", { status: 426 });
    }

    const file = Bun.file(`${novnc}${url.pathname === "/" ? "/vnc.html" : url.pathname}`);

    return url.pathname.includes("..") ? new Response("Not found", { status: 404 }) : new Response(file);
  },

  error: () => new Response("Not found", { status: 404 }),

  websocket: {
    open: (ws) => {
      if (ws.data.kind === "cookies") {
        controllers += 1;
        void appears(cookieStore).then(() => {
          const send = () => {
            try {
              ws.send(JSON.stringify(cookies()));
            } catch {
              // Chrome is mid-write; its next write fires again.
            }
          };
          const watcher = watch(dirname(cookieStore), (_, name) => name === basename(cookieStore) && send());
          send();
          open(ws, (pipe) => {
            pipe.close = () => watcher.close();
          });
        });

        return;
      }

      if (ws.data.kind === "cdp" && upstream !== null) {
        controllers += 1;
        const chrome = new WebSocket(upstream);
        chrome.addEventListener("message", (event) => ws.send(event.data as string));
        chrome.addEventListener("close", () => ws.close());
        chrome.addEventListener("open", () =>
          open(ws, (pipe) => {
            pipe.send = (message) => chrome.send(message);
            pipe.close = () => chrome.close();
          }),
        );

        return;
      }

      void Bun.connect({
        hostname: "127.0.0.1",
        port: vncPort,
        socket: {
          data: (_: Socket, chunk: Buffer) => void ws.send(chunk),
          close: () => ws.close(),
        },
      }).then((socket) =>
        open(ws, (pipe) => {
          pipe.send = (message) => socket.write(message);
          pipe.close = () => socket.end();
        }),
      );
    },

    message: (ws, message) => {
      if (ws.data.send === undefined) {
        ws.data.pending.push(message);
      } else {
        ws.data.send(message);
      }
    },

    close: (ws) => {
      ws.data.close?.();
      if (ws.data.kind !== "vnc" && --controllers === 0) {
        process.exit(0);
      }
    },
  },
});

console.log("computer ready on :8080");
