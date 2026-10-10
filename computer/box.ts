import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, watch } from "node:fs";
import { basename, dirname } from "node:path";

import type { ServerWebSocket, Socket } from "bun";

const token = process.env["BOX_TOKEN"] ?? "";
const display = ":1";
const vncPort = 5901;
const profile = `${process.env["HOME"]}/profile`;
const novnc = "/opt/novnc";

if (token.length < 32) {
  throw new Error("BOX_TOKEN must be at least 32 characters");
}

const appears = (path: string): Promise<void> =>
  new Promise((resolve) => {
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
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--hide-crash-restore-bubble",
      "--disable-dev-shm-usage",
      "--window-position=0,0",
      "--window-size=1440,900",
    ],
    { env: { ...process.env, DISPLAY: display }, stdio: ["ignore", "inherit", "inherit"] },
  ),
  "chrome",
);
await appears(`${profile}/DevToolsActivePort`);

const [port, path] = readFileSync(`${profile}/DevToolsActivePort`, "utf8").split("\n");
const devtools = `ws://127.0.0.1:${port}${path}`;

const allowed = (url: URL): boolean => {
  const given = Buffer.from(url.searchParams.get("token") ?? "");

  return given.length === token.length && timingSafeEqual(given, Buffer.from(token));
};

interface Pipe {
  readonly kind: "cdp" | "vnc";
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

    if (url.pathname === "/cdp" || url.pathname === "/websockify") {
      if (!allowed(url)) {
        return new Response("Forbidden", { status: 403 });
      }

      const kind = url.pathname === "/cdp" ? "cdp" : "vnc";

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
      if (ws.data.kind === "cdp") {
        controllers += 1;
        const upstream = new WebSocket(devtools);
        upstream.addEventListener("message", (event) => ws.send(event.data as string));
        upstream.addEventListener("close", () => ws.close());
        upstream.addEventListener("open", () =>
          open(ws, (pipe) => {
            pipe.send = (message) => upstream.send(message);
            pipe.close = () => upstream.close();
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
      if (ws.data.kind === "cdp" && --controllers === 0) {
        process.exit(0);
      }
    },
  },
});

console.log("computer ready on :8080");
