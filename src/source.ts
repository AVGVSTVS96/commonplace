import { readFileSync } from "node:fs";

import type { Row } from "./schema.ts";

export interface Snapshot {
  readonly source: string;
  readonly date: string;
  readonly dir: string;
}

export interface FetchContext {
  readonly dir: string;
  readonly since: string | null;
  readonly state: string;
}

export interface Source {
  readonly name: string;
  readonly fetch?: (context: FetchContext) => Promise<void>;
  readonly every?: number;
  readonly watch?: readonly string[];
  readonly rows: (snapshot: Snapshot) => AsyncIterable<Row> | Iterable<Row>;
}

export const defineSource = (source: Source): Source => source;

export const lines = async function* lines(path: string): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending: string[] = [];

  for await (const bytes of Bun.file(path).stream()) {
    const text = decoder.decode(bytes, { stream: true });
    let start = 0;

    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
      pending.push(text.slice(start, end));
      const line = pending.join("").replace(/\r$/u, "");
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
    yield last.replace(/\r$/u, "");
  }
};

export const jsonl = async function* jsonl<T>(path: string): AsyncGenerator<T> {
  for await (const line of lines(path)) {
    // SAFETY: a source reads only files its own fetch or export wrote, so it knows their shape.
    yield JSON.parse(line) as T;
  }
};

export const json = async <T>(path: string): Promise<T> => {
  const parsed: unknown = await Bun.file(path).json();

  // SAFETY: a source reads only files its own fetch or export wrote, so it knows their shape.
  return parsed as T;
};

export const writeJsonl = async (path: string, items: Iterable<unknown>): Promise<number> =>
  await Bun.write(path, Array.from(items, (item) => `${JSON.stringify(item)}\n`).join(""));

export const csv = (path: string): string[][] => {
  const input = readFileSync(path, "utf-8");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
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
        i += 1;
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
