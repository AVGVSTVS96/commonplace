import { readFileSync } from "node:fs";

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
  /** Files whose change means there's something new, for the LaunchAgent `commonplace install` sets up. */
  readonly watch?: ReadonlyArray<string>;
  /** Gets this source signed in, for `commonplace signin <name>`. */
  readonly signin?: (context: Pick<FetchContext, "state">) => Promise<void>;
  /** Turns one snapshot into rows. Pure: reads only the snapshot, no clock, no network. */
  readonly rows: (snapshot: Snapshot) => AsyncIterable<Row> | Iterable<Row>;
}

export const defineSource = (source: Source): Source => source;

/** Non-empty lines, split on `\n` only: JSON text may hold U+2028, which readline would also split on. */
export async function* lines(path: string): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending: Array<string> = [];

  for await (const bytes of Bun.file(path).stream()) {
    const text = decoder.decode(bytes, { stream: true });
    let start = 0;

    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
      pending.push(text.slice(start, end));
      const line = pending.join("").replace(/\r$/, "");
      pending = [];
      start = end + 1;

      if (line.trim() !== "") {
        yield line;
      }
    }
    pending.push(text.slice(start));
  }

  const last = pending.join("") + decoder.decode();

  if (last.trim() !== "") {
    yield last.replace(/\r$/, "");
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

/** The records of a CSV file, header first. RFC 4180: quoted fields may hold commas, doubled quotes and newlines. */
export const csv = (path: string): Array<Array<string>> => {
  const input = readFileSync(path, "utf8");
  const rows: Array<Array<string>> = [];
  let row: Array<string> = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") {
        i++;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
};
