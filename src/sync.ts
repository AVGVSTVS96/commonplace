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

import { build, type Built, paths, snapshotsOf } from "./build.ts";
import type { Config } from "./config.ts";

const today = (): string => new Date().toLocaleDateString("sv");

const days = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / 86_400_000;

export const stateOf = (data: string, source: string): string => `${data}/state/${source}`;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

/** Holds `data/sync.lock` while `work` runs. Returns null when another live sync holds it. */
const locked = async <T>(data: string, work: () => Promise<T>): Promise<T | null> => {
  const lock = `${data}/sync.lock`;

  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch {
    if (alive(Number(readFileSync(lock, "utf8")))) {
      return null;
    }

    rmSync(lock, { force: true });

    return locked(data, work);
  }

  try {
    return await work();
  } finally {
    rmSync(lock, { force: true });
  }
};

const readOnly = (dir: string): void => {
  for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const path = `${dir}/${name}`;
    chmodSync(path, statSync(path).isDirectory() ? 0o555 : 0o444);
  }
  chmodSync(dir, 0o555);
};

export interface Synced {
  readonly fetched: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<{ readonly source: string; readonly error: string }>;
  readonly built: Built | null;
}

/**
 * Takes today's snapshot of every source that fetches and is due, then rebuilds.
 * Safe to call from as many hooks as you like: a running sync makes the others return null.
 */
export const sync = (config: Config, data: string, log: (line: string) => void): Promise<Synced | null> => {
  mkdirSync(data, { recursive: true });

  return locked(data, async () => {
    const { raw, db } = paths(data);
    const date = today();
    const fetched: Array<string> = [];
    const failed: Array<{ source: string; error: string }> = [];

    for (const source of config.sources) {
      const previous = snapshotsOf(raw, source.name).at(-1);

      if (
        source.fetch === undefined ||
        (previous !== undefined && days(previous.date, date) < (source.every ?? 1))
      ) {
        continue;
      }

      const final = `${raw}/${source.name}/${date}`;
      const partial = `${raw}/${source.name}/.${date}.partial`;
      rmSync(partial, { recursive: true, force: true });
      mkdirSync(partial, { recursive: true });
      log(`fetch ${source.name}`);

      try {
        await source.fetch({
          dir: partial,
          since: previous?.date ?? null,
          state: stateOf(data, source.name),
        });
        readOnly(partial);
        renameSync(partial, final);
        fetched.push(source.name);
      } catch (error) {
        rmSync(partial, { recursive: true, force: true });
        failed.push({
          source: source.name,
          error: error instanceof Error ? error.message : String(error),
        });
        log(`${source.name} failed: ${failed.at(-1)?.error}`);
      }
    }

    const stale = fetched.length > 0 || !existsSync(db);

    return { fetched, failed, built: stale ? await build(config, data) : null };
  });
};
