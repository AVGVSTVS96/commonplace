import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { build, errorMessage, paths, snapshotsOf } from "./build.ts";
import type { Built } from "./build.ts";
import type { Config } from "./config.ts";

const FETCH_LIMIT_MS = 30 * 60_000;

const within = async <T>(ms: number, work: Promise<T>): Promise<T> => {
  const timer = new AbortController();

  const timeout = async () => {
    await sleep(ms, undefined, { signal: timer.signal });
    throw new Error(`still running after ${ms / 60_000} minutes`);
  };

  try {
    return await Promise.race([work, timeout()]);
  } finally {
    timer.abort();
  }
};

const today = (): string => new Date().toLocaleDateString("sv");

const days = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / 86_400_000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const locked = async <T>(data: string, work: () => Promise<T>): Promise<T | null> => {
  const lock = `${data}/sync.lock`;

  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch {
    if (alive(Number(readFileSync(lock, "utf-8")))) {
      return null;
    }

    rmSync(lock, { force: true });

    return await locked(data, work);
  }

  try {
    return await work();
  } finally {
    rmSync(lock, { force: true });
  }
};

const readOnly = (dir: string): void => {
  for (const name of readdirSync(dir, { recursive: true, encoding: "utf-8" })) {
    const path = `${dir}/${name}`;
    chmodSync(path, statSync(path).isDirectory() ? 0o555 : 0o444);
  }

  chmodSync(dir, 0o555);
};

export interface Synced {
  readonly fetched: readonly string[];
  readonly failed: readonly { readonly source: string; readonly error: string }[];
  readonly built: Built | null;
}

export const sync = async (
  config: Config,
  data: string,
  log: (line: string) => void,
  limit = FETCH_LIMIT_MS,
): Promise<Synced | null> => {
  mkdirSync(data, { recursive: true });

  return await locked(data, async () => {
    const { raw, db } = paths(data);
    const date = today();
    const fetched: string[] = [];
    const failed: { source: string; error: string }[] = [];

    for (const source of config.sources) {
      const previous = snapshotsOf(raw, source.name).at(-1);
      const every = source.every ?? 1;

      const waited =
        previous === undefined ||
        (every < 1
          ? previous.date < date ||
            Date.now() - statSync(previous.dir).mtimeMs >= every * 86_400_000
          : days(previous.date, date) >= every);

      if (source.fetch === undefined || !waited) {
        continue;
      }

      const name =
        previous?.date === date
          ? `${date}.${new Date().toTimeString().slice(0, 5).replace(":", "")}`
          : date;

      const final = `${raw}/${source.name}/${name}`;
      const partial = `${raw}/${source.name}/.${name}.partial`;
      rmSync(partial, { recursive: true, force: true });
      mkdirSync(partial, { recursive: true });
      log(`fetch ${source.name}`);

      try {
        await within(
          limit,
          source.fetch({
            dir: partial,
            since: previous?.date ?? null,
            state: `${data}/state/${source.name}`,
          }),
        );
        readOnly(partial);
        renameSync(partial, final);
        fetched.push(source.name);
      } catch (error) {
        rmSync(partial, { recursive: true, force: true });
        failed.push({ source: source.name, error: errorMessage(error) });
        log(`${source.name} failed: ${errorMessage(error)}`);
      }
    }

    const builtAt = existsSync(db) ? statSync(db).mtimeMs : null;

    const stale =
      builtAt === null ||
      config.sources.some((source) =>
        snapshotsOf(raw, source.name).some((snapshot) => statSync(snapshot.dir).mtimeMs > builtAt),
      );

    return { fetched, failed, built: stale ? await build(config, data) : null };
  });
};
