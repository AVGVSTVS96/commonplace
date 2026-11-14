import { Database, SQLiteError } from "bun:sqlite";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { Json } from "./schema.ts";
import { locked } from "./sync.ts";

export interface Pointer {
  readonly id: string;
  readonly at: string | null;
  readonly agent: string;
  readonly role: string;
  readonly project: string | null;
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

interface Part {
  readonly type?: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly name?: string;
  readonly input?: Json;
  readonly arguments?: Json;
  readonly content?: Content;
}

type Content = string | readonly Part[];

interface Entry {
  readonly type?: string;
  readonly timestamp?: string;
  readonly cwd?: string;
  readonly isMeta?: boolean;
  readonly message?: { readonly role?: string; readonly content?: Content };
  readonly payload?: {
    readonly type?: string;
    readonly role?: string;
    readonly cwd?: string;
    readonly name?: string;
    readonly input?: Json;
    readonly arguments?: Json;
    readonly output?: Json;
    readonly content?: Content;
    readonly summary?: readonly Part[];
  };
}

type Role = "user" | "agent" | "tool";

interface Said {
  readonly role: Role;
  readonly text: string;
}

const LONGEST = 4000;

const clip = (text: string, length = LONGEST): string =>
  text.length <= length
    ? text
    : `${text.slice(0, length * 0.75)} … ${text.slice(text.length - length / 4)}`;

const leaves = (value: Json | undefined): string => {
  if (value === undefined || value === null) {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map(leaves).join(" ");
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- tool inputs are arbitrary JSON, read here for their words
  return typeof value === "object" ? Object.values(value).map(leaves).join(" ") : String(value);
};

const call = (name: string | undefined, input: Json | undefined): string =>
  `${name ?? ""} ${clip(leaves(input))}`;

const isParts = (content: Content | undefined): content is readonly Part[] =>
  Array.isArray(content);

const textOf = (content: Content | undefined): string => {
  if (!isParts(content)) {
    return content ?? "";
  }

  return content
    .map((part) => {
      switch (part.type ?? "") {
        case "text":
        case "input_text":
        case "output_text":
        case "summary_text": {
          return part.text ?? "";
        }

        case "thinking": {
          return part.thinking ?? "";
        }

        case "tool_use": {
          return call(part.name, part.input);
        }

        case "toolCall": {
          return call(part.name, part.arguments);
        }

        case "tool_result": {
          return clip(textOf(part.content), LONGEST / 2);
        }

        default: {
          return "";
        }
      }
    })
    .join("\n");
};

const reminders = /<system-reminder>[\s\S]*?<\/system-reminder>/gu;

const codexSaid = (payload: NonNullable<Entry["payload"]>): Said | null => {
  const { type, role } = payload;

  if (type === "message" && (role === "user" || role === "assistant")) {
    return { role: role === "user" ? "user" : "agent", text: textOf(payload.content) };
  }

  if (type === "reasoning") {
    return { role: "agent", text: textOf(payload.summary) };
  }

  if (type === "function_call" || type === "custom_tool_call") {
    return { role: "agent", text: call(payload.name, payload.arguments ?? payload.input) };
  }

  if (type === "function_call_output" || type === "custom_tool_call_output") {
    return { role: "tool", text: clip(leaves(payload.output), LONGEST / 2) };
  }

  return null;
};

const roles = new Map<string | undefined, Role>([
  ["user", "user"],
  ["assistant", "agent"],
  ["toolResult", "tool"],
]);

const said = (entry: Entry): Said | null => {
  if (entry.type === "response_item" && entry.payload !== undefined) {
    return codexSaid(entry.payload);
  }

  const role = roles.get(entry.message?.role);
  const content = entry.message?.content;

  if (role === undefined || entry.isMeta === true) {
    return null;
  }

  if (role === "user") {
    const result = isParts(content) && content.some((part) => part.type === "tool_result");

    return { role: result ? "tool" : "user", text: textOf(content).replaceAll(reminders, "") };
  }

  return { role, text: role === "tool" ? clip(textOf(content), LONGEST / 2) : textOf(content) };
};

const parse = (line: string): Entry | null => {
  try {
    // SAFETY: every field of Entry is optional, and said() allows for a line that lacks any of them.
    return JSON.parse(line) as Entry;
  } catch {
    return null;
  }
};

const shelves = () => {
  const home = homedir();
  const codex = process.env["CODEX_HOME"] ?? `${home}/.codex`;

  return [
    { agent: "claude", dir: `${process.env["CLAUDE_CONFIG_DIR"] ?? `${home}/.claude`}/projects` },
    { agent: "codex", dir: `${codex}/sessions` },
    { agent: "codex", dir: `${codex}/archived_sessions` },
    { agent: "pi", dir: `${process.env["PI_CODING_AGENT_DIR"] ?? `${home}/.pi/agent`}/sessions` },
  ];
};

const uuid = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/gu;

const sessionOf = (file: string): string =>
  file.match(uuid)?.at(-1) ?? path.basename(file, ".jsonl");

const schema = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, agent TEXT NOT NULL, session TEXT NOT NULL,
    cwd TEXT, read INTEGER NOT NULL, lines INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lines (
    id INTEGER PRIMARY KEY, file INTEGER NOT NULL, line INTEGER NOT NULL, start INTEGER NOT NULL,
    bytes INTEGER NOT NULL, ts TEXT, role TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS lines_file ON lines (file);
  CREATE VIRTUAL TABLE IF NOT EXISTS words USING fts5(
    text, content = '', contentless_delete = 1, tokenize = 'porter unicode61'
  );
`;

interface Held {
  readonly id: number;
  readonly read: number;
  readonly lines: number;
  readonly cwd: string | null;
}

type Line = Readonly<{
  id: number;
  line: number;
  start: number;
  bytes: number;
  ts: string | null;
  role: Role;
}>;

const writer = (db: Database) => {
  const held = db.query<Held, { path: string }>(
    "SELECT id, read, lines, cwd FROM files WHERE path = $path",
  );

  const add = db.query<{ id: number }, { path: string; agent: string; session: string }>(
    "INSERT INTO files (path, agent, session, read, lines) VALUES ($path, $agent, $session, 0, 0) RETURNING id",
  );

  const line = db.query<{ id: number }, Line>(
    "INSERT INTO lines (file, line, start, bytes, ts, role) VALUES ($id, $line, $start, $bytes, $ts, $role) RETURNING id",
  );

  const word = db.query("INSERT INTO words (rowid, text) VALUES ($rowid, $text)");

  const mark = db.query("UPDATE files SET read = $read, lines = $lines, cwd = $cwd WHERE id = $id");

  const forget = db.query(
    "DELETE FROM words WHERE rowid IN (SELECT id FROM lines WHERE file = $id)",
  );

  const drop = db.query("DELETE FROM lines WHERE file = $id");
  const remove = db.query("DELETE FROM files WHERE id = $id");

  return {
    held: (file: string) => held.get({ path: file }),
    add: (file: string, agent: string) =>
      add.get({ path: file, agent, session: sessionOf(file) })?.id ?? 0,
    line: (row: Line, text: string) => {
      const id = line.get(row)?.id;

      if (id !== undefined) {
        word.run({ rowid: id, text });
      }
    },
    mark: (id: number, read: number, lines: number, cwd: string | null) =>
      mark.run({ id, read, lines, cwd }),
    clear: (id: number) => {
      forget.run({ id });
      drop.run({ id });
    },
    remove: (id: number) => {
      forget.run({ id });
      drop.run({ id });
      remove.run({ id });
    },
  };
};

const NEWLINE = 10;

const indexFile = async (
  db: Database,
  write: ReturnType<typeof writer>,
  agent: string,
  file: string,
) => {
  const { size } = statSync(file);
  const held = write.held(file);

  if (held?.read === size) {
    return;
  }

  db.run("BEGIN");

  const kept = held !== null && held.read < size ? held : null;

  if (held !== null && kept === null) {
    write.clear(held.id);
  }

  const id = held?.id ?? write.add(file, agent);
  let read = kept?.read ?? 0;
  let lines = kept?.lines ?? 0;
  let cwd = kept?.cwd ?? null;
  let pending = new Uint8Array(0);
  const decoder = new TextDecoder();

  const take = (bytes: Uint8Array, begin: number, end: number) => {
    lines += 1;
    const entry = parse(decoder.decode(bytes.subarray(begin, end)));
    cwd ??= entry?.cwd ?? entry?.payload?.cwd ?? null;
    const words = entry === null ? null : said(entry);

    if (words !== null && words.text.trim() !== "") {
      write.line(
        {
          id,
          line: lines,
          start: read + begin,
          bytes: end - begin,
          ts: entry?.timestamp ?? null,
          role: words.role,
        },
        words.text,
      );
    }
  };

  try {
    for await (const chunk of Bun.file(file).slice(read, size).stream()) {
      const bytes = new Uint8Array(pending.length + chunk.length);
      bytes.set(pending);
      bytes.set(chunk, pending.length);
      let begin = 0;

      for (let end = bytes.indexOf(NEWLINE); end !== -1; end = bytes.indexOf(NEWLINE, begin)) {
        take(bytes, begin, end);
        begin = end + 1;
      }

      read += begin;
      pending = bytes.slice(begin);
    }

    write.mark(id, read, lines, cwd);
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
};

const connect = (file: string) => {
  const db = new Database(file, { create: true, strict: true });
  db.run("PRAGMA busy_timeout = 60000");
  db.run(schema);

  return db;
};

export const refresh = async (file: string): Promise<boolean> =>
  (await locked(`${file}.lock`, async () => {
    const db = connect(file);
    const write = writer(db);
    const seen = new Set<string>();

    for (const { agent, dir } of shelves()) {
      const found = await Array.fromAsync(
        new Bun.Glob("**/*.jsonl").scan({ cwd: dir, absolute: true }),
      ).catch(() => []);

      for (const transcript of found) {
        seen.add(transcript);
        await indexFile(db, write, agent, transcript);
      }
    }

    db.transaction(() => {
      for (const { id, path: indexed } of db
        .query<{ id: number; path: string }, []>("SELECT id, path FROM files")
        .all()) {
        if (!seen.has(indexed)) {
          write.remove(id);
        }
      }
    })();
    db.close();

    return true;
  })) ?? false;

const quoted = (q: string) =>
  q
    .split(/\s+/u)
    .filter(Boolean)
    .map((word) => `"${word.replaceAll('"', '""')}"`)
    .join(" ");

interface Match {
  readonly agent: string;
  readonly session: string;
  readonly cwd: string | null;
  readonly path: string;
  readonly line: number;
  readonly start: number;
  readonly bytes: number;
  readonly ts: string | null;
  readonly role: string;
}

const AROUND = 240;

const excerpt = async (match: Match, q: string): Promise<string> => {
  const raw = await Bun.file(match.path)
    .slice(match.start, match.start + match.bytes)
    .text()
    .catch(() => "");

  const entry = parse(raw);
  const text = (entry === null ? "" : (said(entry)?.text ?? "")).replaceAll(/\s+/gu, " ");
  const lower = text.toLowerCase();

  const hits = (q.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [])
    .map((term) => lower.indexOf(term))
    .filter((i) => i >= 0);

  const from = Math.max(0, Math.min(text.length, ...hits) - AROUND / 3);
  const to = from + AROUND;

  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
};

const projectOf = (cwd: string | null): string | null => {
  if (cwd === null) {
    return null;
  }

  return cwd === homedir() ? "~" : path.basename(cwd);
};

export interface RecallOptions {
  readonly limit?: number | undefined;
  readonly since?: string | undefined;
  readonly until?: string | undefined;
}

export const recall = async (
  file: string,
  q: string,
  { limit = 10, since, until }: RecallOptions = {},
): Promise<Pointer[]> => {
  await refresh(file);
  const db = new Database(file, { readonly: true, strict: true });

  const query = db.query<
    Match,
    { q: string; since: string | null; until: string | null; limit: number }
  >(`
    SELECT f.agent, f.session, f.cwd, f.path, l.line, l.start, l.bytes, l.ts, l.role
    FROM words JOIN lines l ON l.id = words.rowid JOIN files f ON f.id = l.file
    WHERE words MATCH $q AND ($since IS NULL OR l.ts >= $since) AND ($until IS NULL OR l.ts < $until)
    ORDER BY rank LIMIT $limit
  `);

  const run = (match: string) =>
    query.all({ q: match, since: since ?? null, until: until ?? null, limit: limit * 20 });

  const matches = (() => {
    try {
      return run(q);
    } catch (error) {
      if (error instanceof SQLiteError) {
        return run(quoted(q));
      }

      throw error;
    }
  })();

  db.close();

  const best = [...Map.groupBy(matches, (m) => m.session).values()]
    .flatMap(([first]) => (first === undefined ? [] : [first]))
    .slice(0, limit);

  return await Promise.all(
    best.map(async (match) => ({
      id: `session:${match.agent}:${match.session}`,
      at: match.ts,
      agent: match.agent,
      role: match.role,
      project: projectOf(match.cwd),
      file: match.path,
      line: match.line,
      text: await excerpt(match, q),
    })),
  );
};
