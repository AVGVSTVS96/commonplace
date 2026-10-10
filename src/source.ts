import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import type { Row } from "./schema.ts";

/** One dated, read-only snapshot: `data/raw/<source>/<YYYY-MM-DD>/`. */
export interface Snapshot {
  readonly source: string;
  readonly date: string;
  readonly dir: string;
}

export interface FetchContext {
  /** An empty directory that becomes today's snapshot once fetch resolves. */
  readonly dir: string;
  /** The date of this source's last snapshot, so fetch can take only what's new. Null on the first run. */
  readonly since: string | null;
  /** A private directory this source keeps between runs, for things like a signed-in session. Never in a snapshot. */
  readonly state: string;
}

export interface Source {
  readonly name: string;
  /** Copies what the service gives you into `dir`, as close to raw as you can. Omit for one-time exports you drop in by hand. */
  readonly fetch?: (context: FetchContext) => Promise<void>;
  /** Days between snapshots. Defaults to 1. */
  readonly every?: number;
  /** Gets this source signed in, for `commonplace signin <name>`. */
  readonly signin?: (context: Pick<FetchContext, "state">) => Promise<void>;
  /** Turns one snapshot into rows. Pure: reads only the snapshot, no clock, no network. */
  readonly rows: (snapshot: Snapshot) => AsyncIterable<Row> | Iterable<Row>;
}

export const defineSource = (source: Source): Source => source;

export async function* lines(path: string): AsyncGenerator<string> {
  for await (const line of createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  })) {
    if (line.trim() !== "") {
      yield line;
    }
  }
}

export async function* jsonl<T>(path: string): AsyncGenerator<T> {
  for await (const line of lines(path)) {
    yield JSON.parse(line) as T;
  }
}

export const json = <T>(path: string): Promise<T> => Bun.file(path).json() as Promise<T>;

export const writeJsonl = (path: string, items: Iterable<unknown>): Promise<number> =>
  Bun.write(path, Array.from(items, (item) => `${JSON.stringify(item)}\n`).join(""));
