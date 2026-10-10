import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** A running box: Chrome on a private screen, behind a gateway that only answers to its token. */
export interface Box {
  readonly url: string;
  readonly token: string;
  readonly alive: () => Promise<boolean>;
  readonly stop: () => Promise<void>;
}

/** Where boxes run. One box per user at a time: `start` replaces any box still running. */
export interface Provider {
  readonly start: (token: string) => Promise<Box>;
}

const image = "commonplace-computer";
const context = new URL("../computer", import.meta.url).pathname;

export interface LocalOptions {
  readonly engine?: string;
  /** Where the box listens. Keep it private: a tailnet address, never a public one. */
  readonly address?: string;
}

/** Docker or Podman on this machine, so the box browses from your own connection. */
export const local = ({
  engine = Bun.which("docker") === null ? "podman" : "docker",
  address = "127.0.0.1",
}: LocalOptions = {}): Provider => ({
  start: async (token) => {
    await $`${engine} rm -f ${image}`.quiet().nothrow();
    if ((await $`${engine} image inspect ${image}`.quiet().nothrow()).exitCode !== 0) {
      await $`${engine} build -t ${image} ${context}`;
    }
    await $`${engine} run -d --rm --init --name ${image} -p ${address}::8080 -e BOX_TOKEN=${token} ${image}`.quiet();
    const port = (await $`${engine} port ${image} 8080`.text()).trim().split(":").at(-1);

    return {
      url: `http://${address}:${port}`,
      token,
      alive: async () => (await $`${engine} container inspect ${image}`.quiet().nothrow()).exitCode === 0,
      stop: async () => void (await $`${engine} rm -f ${image}`.quiet().nothrow()),
    };
  },
});

export interface FlyOptions {
  /** A Fly app of your own with a shared IPv4 and an IPv6, made once with `fly apps create`. */
  readonly app: string;
  /** Any registry path Fly can pull. Defaults to the image built from `computer/` in commonplace's repo. */
  readonly image?: string;
  readonly region?: string;
  readonly token?: string;
}

/** Fly Machines: a fresh VM for every run, destroyed when the run ends. */
export const fly = (options: FlyOptions): Provider => {
  const api = `https://api.machines.dev/v1/apps/${options.app}/machines`;
  const headers = {
    authorization: `Bearer ${options.token ?? process.env["FLY_API_TOKEN"] ?? ""}`,
    "content-type": "application/json",
  };
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${api}${path}`, { ...init, headers });
    if (!response.ok) {
      throw new Error(
        `fly ${init.method ?? "GET"} ${path || "/"}: ${response.status} ${await response.text()}`,
      );
    }

    return response.json() as Promise<T>;
  };
  const destroy = (id: string) => call(`/${id}?force=true`, { method: "DELETE" }).catch(() => undefined);

  return {
    start: async (token) => {
      for (const machine of await call<ReadonlyArray<{ id: string }>>("")) {
        await destroy(machine.id);
      }
      const { id } = await call<{ id: string }>("", {
        method: "POST",
        body: JSON.stringify({
          ...(options.region === undefined ? {} : { region: options.region }),
          config: {
            image: options.image ?? "ghcr.io/avgvstvs96/commonplace-computer:latest",
            env: { BOX_TOKEN: token },
            guest: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 },
            auto_destroy: true,
            restart: { policy: "no" },
            services: [
              {
                protocol: "tcp",
                internal_port: 8080,
                autostop: "off",
                ports: [{ port: 443, handlers: ["tls", "http"] }],
              },
            ],
          },
        }),
      });
      await call(`/${id}/wait?state=started&timeout=60`);

      return {
        url: `https://${options.app}.fly.dev`,
        token,
        alive: async () => (await call<{ state: string }>(`/${id}`).catch(() => null))?.state === "started",
        stop: () => destroy(id).then(() => undefined),
      };
    },
  };
};

export interface Cookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expires: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite?: string;
}

export interface Response {
  readonly url: string;
  readonly status: number;
  readonly body: string;
}

/** Chrome DevTools Protocol over the box's gateway, attached to its one tab. */
export interface Computer {
  /** A link a person can open to watch and use the box's screen. */
  readonly view: string;
  /** The DevTools WebSocket, for any agent that drives Chrome. */
  readonly cdp: string;
  readonly send: <T = unknown>(method: string, params?: object) => Promise<T>;
  readonly on: (method: string, listener: (params: any) => void) => () => void;
  readonly goto: (url: string) => Promise<void>;
  readonly evaluate: <T>(expression: string) => Promise<T>;
  /** Every response whose URL matches, in order, from now until `stop`. */
  readonly capture: (match: RegExp) => { readonly responses: Array<Response>; readonly stop: () => void };
  /** Resolves with the next response whose URL matches. */
  readonly next: (match: RegExp) => Promise<Response>;
  readonly wheel: (deltaY: number) => Promise<void>;
  readonly cookies: () => Promise<ReadonlyArray<Cookie>>;
  readonly setCookies: (cookies: ReadonlyArray<Cookie>) => Promise<void>;
}

const connect = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error(`could not connect to ${url.split("?")[0]}`)));
  });

const attach = async (box: Box): Promise<{ computer: Computer; ws: WebSocket }> => {
  const cdp = `${box.url.replace(/^http/, "ws")}/cdp?token=${box.token}`;
  let ws: WebSocket | undefined;
  while (ws === undefined) {
    ws = await connect(cdp).catch(async (error: unknown) => {
      if (!(await box.alive())) {
        throw error;
      }
      await Bun.sleep(250);

      return undefined;
    });
  }
  const socket = ws;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const listeners = new Map<string, Set<(params: any) => void>>();
  let sessionId: string | undefined;
  let id = 0;

  socket.addEventListener("message", (message) => {
    const data = JSON.parse(String(message.data));
    if (data.id !== undefined) {
      const call = pending.get(data.id);
      pending.delete(data.id);
      if (data.error === undefined) {
        call?.resolve(data.result);
      } else {
        call?.reject(new Error(`${data.error.message} (${data.error.code})`));
      }
    } else {
      for (const listener of listeners.get(data.method) ?? []) {
        listener(data.params);
      }
    }
  });
  socket.addEventListener("close", () => {
    for (const call of pending.values()) {
      call.reject(new Error("the box closed"));
    }
  });

  const raw = <T>(method: string, params: object = {}, session = sessionId): Promise<T> =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      socket.send(
        JSON.stringify({ id, method, params, ...(session === undefined ? {} : { sessionId: session }) }),
      );
    });

  const on = (method: string, listener: (params: any) => void) => {
    const set = listeners.get(method) ?? new Set();
    listeners.set(method, set.add(listener));

    return () => void set.delete(listener);
  };

  const { targetInfos } = await raw<{ targetInfos: ReadonlyArray<{ targetId: string; type: string }> }>(
    "Target.getTargets",
  );
  const tab = targetInfos.find((target) => target.type === "page");
  if (tab === undefined) {
    throw new Error("the box has no tab open");
  }
  ({ sessionId } = await raw<{ sessionId: string }>("Target.attachToTarget", {
    targetId: tab.targetId,
    flatten: true,
  }));
  await raw("Page.enable");
  await raw("Network.enable");
  await raw("Runtime.enable");

  const capture = (match: RegExp, each?: (response: Response) => void) => {
    const responses: Array<Response> = [];
    const seen = new Map<string, { url: string; status: number }>();
    const offs = [
      on("Network.responseReceived", ({ requestId, response }) => {
        if (match.test(response.url)) {
          seen.set(requestId, { url: response.url, status: response.status });
        }
      }),
      on("Network.loadingFinished", ({ requestId }) => {
        const meta = seen.get(requestId);
        if (meta !== undefined) {
          seen.delete(requestId);
          void raw<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", { requestId }).then(
            ({ body, base64Encoded }) => {
              const response = { ...meta, body: base64Encoded ? atob(body) : body };
              responses.push(response);
              each?.(response);
            },
          );
        }
      }),
    ];

    return { responses, stop: () => offs.forEach((off) => off()) };
  };

  const computer: Computer = {
    view: `${box.url}/vnc.html?autoconnect=1&resize=scale&path=${encodeURIComponent(`websockify?token=${box.token}`)}`,
    cdp,
    send: raw,
    on,
    goto: async (url) => {
      const loaded = new Promise<void>((resolve) => {
        const off = on("Page.loadEventFired", () => {
          off();
          resolve();
        });
      });
      await raw("Page.navigate", { url });
      await loaded;
    },
    evaluate: async <T>(expression: string) => {
      const { result, exceptionDetails } = await raw<{ result: { value: T }; exceptionDetails?: unknown }>(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
      );
      if (exceptionDetails !== undefined) {
        throw new Error(`evaluate: ${JSON.stringify(exceptionDetails)}`);
      }

      return result.value;
    },
    capture,
    next: (match) =>
      new Promise((resolve) => {
        const { stop } = capture(match, (response) => {
          stop();
          resolve(response);
        });
      }),
    wheel: async (deltaY) => {
      await raw("Input.dispatchMouseEvent", { type: "mouseWheel", x: 720, y: 450, deltaX: 0, deltaY });
    },
    cookies: async () =>
      (await raw<{ cookies: ReadonlyArray<Cookie> }>("Storage.getCookies", {}, undefined)).cookies,
    setCookies: async (cookies) => void (await raw("Storage.setCookies", { cookies }, undefined)),
  };

  return { computer, ws: socket };
};

/** Starts a box, runs `work` on it, and destroys it however `work` ends. */
export const withComputer = async <T>(
  provider: Provider,
  work: (computer: Computer) => Promise<T>,
): Promise<T> => {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const box = await provider.start(token);
  try {
    const { computer, ws } = await attach(box);
    try {
      return await work(computer);
    } finally {
      ws.close();
    }
  } finally {
    await box.stop();
  }
};

/** The signed-in browser session for one site, kept in the source's private state directory. */
export const session = (state: string) => {
  const path = `${state}/session.json`;

  return {
    load: (): ReadonlyArray<Cookie> | null =>
      existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ReadonlyArray<Cookie>) : null,
    save: (cookies: ReadonlyArray<Cookie>) => {
      mkdirSync(state, { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify(cookies), { mode: 0o600 });
    },
  };
};

export interface Site {
  readonly name: string;
  readonly login: string;
  readonly signedIn: (cookies: ReadonlyArray<Cookie>) => boolean;
}

/** Sign-in and signed-in runs for one website, on boxes from `provider`. */
export const site = (provider: Provider, { name, login, signedIn }: Site) => ({
  signin: ({ state }: { readonly state: string }) =>
    withComputer(provider, async (computer) => {
      const cookieSet = new Promise<void>((resolve) => {
        const off = computer.on("Network.responseReceivedExtraInfo", ({ headers }) => {
          if (Object.keys(headers).some((header) => header.toLowerCase() === "set-cookie")) {
            void computer.cookies().then((cookies) => {
              if (signedIn(cookies)) {
                off();
                resolve();
              }
            });
          }
        });
      });
      await computer.goto(login);
      console.log(`Sign in to ${name} on the remote computer's screen:\n  ${computer.view}`);
      console.log(`Agents can drive it over Chrome DevTools at:\n  ${computer.cdp}`);
      await cookieSet;
      session(state).save(await computer.cookies());
      console.log(`Signed in to ${name}.`);
    }),

  run: <T>(state: string, work: (computer: Computer) => Promise<T>): Promise<T> =>
    withComputer(provider, async (computer) => {
      const saved = session(state).load();
      if (saved === null || !signedIn(saved)) {
        throw new Error(`not signed in to ${name}: run \`commonplace signin ${name}\``);
      }
      await computer.setCookies(saved);
      const result = await work(computer);
      const cookies = await computer.cookies();
      if (!signedIn(cookies)) {
        throw new Error(`${name} signed the session out: run \`commonplace signin ${name}\``);
      }
      session(state).save(cookies);

      return result;
    }),
});
