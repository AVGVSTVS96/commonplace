import { Database } from "bun:sqlite";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename } from "node:path";

import type { Config } from "./config.ts";
import { type Event, type Extra, isOnce, type Link, problem, type Row, type Thing } from "./schema.ts";
import type { Snapshot, Source } from "./source.ts";

/** `<YYYY-MM-DD>`, or `<YYYY-MM-DD>.<label>` for a second snapshot of one day, like an archive merged in from elsewhere. */
export const datePattern = /^\d{4}-\d{2}-\d{2}(\.[\w-]+)?$/;

export const paths = (data: string) => ({ raw: `${data}/raw`, db: `${data}/commonplace.db` });

/** Every finished snapshot of one source, oldest first. In-progress `.partial` dirs never match. */
export const snapshotsOf = (raw: string, source: string): Array<Snapshot> => {
  const dir = `${raw}/${source}`;

  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => datePattern.test(name))
        .toSorted()
        .map((name) => ({ source, date: name.slice(0, 10), dir: `${dir}/${name}` }))
    : [];
};

type Sourced<T> = T & { readonly sources: ReadonlyArray<string> };
type Stored = Sourced<Omit<Event, "key"> & { readonly id: string }>;

export interface Outcome {
  readonly source: string;
  readonly snapshot: string;
  readonly date: string;
  readonly things: number;
  readonly events: number;
  readonly links: number;
  readonly redacted: number;
  readonly error: string | null;
}

export interface Built {
  readonly outcomes: ReadonlyArray<Outcome>;
  readonly things: number;
  readonly events: number;
  readonly links: number;
  readonly orphans: number;
}

const hash = (value: unknown): string =>
  new Bun.CryptoHasher("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);

const eventId = (source: string, event: Event): string =>
  isOnce(event.verb)
    ? `${event.verb}:${event.thing}`
    : `${source}:${event.key ?? hash([event.verb, event.thing, event.ts, event.text])}`;

const union = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): Array<string> => [
  ...new Set([...a, ...b]),
];

const present = (extra: Extra): Extra =>
  Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== null));

/** Fields the newcomer has replace the held ones; nulls never erase, but do fill a key the held row lacks. */
const merge = <T extends Sourced<{ readonly extra: Extra }>>(held: T | undefined, offered: T): T => {
  if (held === undefined) {
    return offered;
  }

  const next: Record<string, unknown> = { ...held };

  for (const [key, value] of Object.entries(offered)) {
    if (value !== null) {
      next[key] = value;
    }
  }

  return {
    ...(next as T),
    sources: union(held.sources, offered.sources),
    extra: { ...offered.extra, ...held.extra, ...present(offered.extra) },
  };
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** All of a snapshot's rows, or why it failed. Never half a snapshot. */
const load = async (source: Source, snapshot: Snapshot): Promise<Array<Row> | string> => {
  const rows: Array<Row> = [];

  try {
    for await (const row of source.rows(snapshot)) {
      const issue = problem(row);

      if (issue !== null) {
        return `row ${rows.length + 1}: ${issue}`;
      }

      rows.push(row);
    }
  } catch (error) {
    return `row ${rows.length + 1}: ${message(error)}`;
  }

  return rows;
};

const schema = `
  CREATE TABLE things (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, text TEXT, url TEXT, author TEXT,
    created_at TEXT, sources TEXT NOT NULL, extra TEXT NOT NULL
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY, verb TEXT NOT NULL, ts TEXT, thing_id TEXT NOT NULL, text TEXT,
    collections TEXT NOT NULL, sources TEXT NOT NULL, extra TEXT NOT NULL
  );
  CREATE TABLE links (
    from_id TEXT NOT NULL, rel TEXT NOT NULL, to_id TEXT NOT NULL, sources TEXT NOT NULL,
    PRIMARY KEY (from_id, rel, to_id)
  ) WITHOUT ROWID;
  CREATE TABLE snapshots (
    source TEXT NOT NULL, snapshot TEXT NOT NULL, date TEXT NOT NULL, things INTEGER NOT NULL,
    events INTEGER NOT NULL, links INTEGER NOT NULL, redacted INTEGER NOT NULL, error TEXT,
    PRIMARY KEY (source, snapshot)
  );
  CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED, tbl UNINDEXED, title, text, url, tokenize = 'porter unicode61');
`;

const indexes = `
  CREATE INDEX things_kind ON things (kind);
  CREATE INDEX events_thing ON events (thing_id);
  CREATE INDEX events_verb ON events (verb);
  CREATE INDEX events_ts ON events (ts);
  CREATE INDEX links_to ON links (to_id);
  INSERT INTO search SELECT id, 'things', title, text, url FROM things WHERE coalesce(title, text, url) IS NOT NULL;
  INSERT INTO search SELECT id, 'events', NULL, text, NULL FROM events WHERE text IS NOT NULL;
`;

interface Corpus {
  readonly things: ReadonlyArray<Sourced<Thing>>;
  readonly events: ReadonlyArray<Stored>;
  readonly links: ReadonlyArray<Sourced<Link>>;
  readonly outcomes: ReadonlyArray<Outcome>;
}

/** Writes beside `file` and renames over it, so readers see the old archive or the new one, never half of one. */
const write = (file: string, corpus: Corpus): void => {
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });

  const db = new Database(tmp, { create: true, strict: true });
  const json = JSON.stringify;

  db.run("PRAGMA journal_mode = OFF");
  db.exec(schema);
  db.transaction(() => {
    const thing = db.prepare("INSERT INTO things VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const event = db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const link = db.prepare("INSERT INTO links VALUES (?, ?, ?, ?)");
    const snapshot = db.prepare("INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?)");

    for (const t of corpus.things) {
      thing.run(t.id, t.kind, t.title, t.text, t.url, t.author, t.created_at, json(t.sources), json(t.extra));
    }
    for (const e of corpus.events) {
      event.run(e.id, e.verb, e.ts, e.thing, e.text, json(e.collections), json(e.sources), json(e.extra));
    }
    for (const l of corpus.links) {
      link.run(l.from, l.rel, l.to, json(l.sources));
    }
    for (const o of corpus.outcomes) {
      snapshot.run(o.source, o.snapshot, o.date, o.things, o.events, o.links, o.redacted, o.error);
    }
  })();
  db.exec(indexes);
  db.close();

  renameSync(tmp, file);
};

/**
 * Replays every snapshot into a fresh database. Weaker sources replay first and each source
 * replays oldest first, so the strongest, newest value of every field lands last and wins.
 */
export const build = async (config: Config, data: string): Promise<Built> => {
  const { raw, db } = paths(data);
  const rank = (source: string) => config.sources.findIndex(({ name }) => name === source);
  const things = new Map<string, Sourced<Thing>>();
  const events = new Map<string, Stored>();
  const links = new Map<string, Sourced<Link>>();
  const outcomes: Array<Outcome> = [];

  for (const source of config.sources.toReversed()) {
    for (const snapshot of snapshotsOf(raw, source.name)) {
      const rows = await load(source, snapshot);
      const counts = { things: 0, events: 0, links: 0, redacted: 0 };
      const sources = [source.name];

      for (const row of typeof rows === "string" ? [] : rows) {
        if (config.redact?.(row, source.name) === true) {
          counts.redacted += 1;
          continue;
        }

        if (row.type === "thing") {
          const { type: _, ...rest } = row;
          things.set(row.id, merge(things.get(row.id), { ...rest, sources }));
          counts.things += 1;
        } else if (row.type === "event") {
          const { type: _, key: __, ...rest } = row;
          const id = eventId(source.name, row);
          const held = events.get(id);
          const merged = merge(held, { ...rest, id, sources });
          events.set(id, {
            ...merged,
            collections: union(held?.collections ?? [], row.collections),
          });
          counts.events += 1;
        } else {
          const { type: _, ...rest } = row;
          const id = JSON.stringify([row.from, row.rel, row.to]);
          links.set(id, { ...rest, sources: union(links.get(id)?.sources ?? [], sources) });
          counts.links += 1;
        }
      }

      outcomes.push({
        source: source.name,
        snapshot: basename(snapshot.dir),
        date: snapshot.date,
        ...counts,
        error: typeof rows === "string" ? `${snapshot.dir}: ${rows}` : null,
      });
    }
  }

  const byRank = (a: string, b: string) => rank(a) - rank(b);
  const ranked = <T extends Sourced<object>>(row: T): T => ({
    ...row,
    sources: row.sources.toSorted(byRank),
  });
  const kept = {
    events: [...events.values()].filter((e) => things.has(e.thing)).map(ranked),
    links: [...links.values()].filter((l) => things.has(l.from)).map(ranked),
  };

  write(db, {
    things: [...things.values()].map(ranked),
    ...kept,
    outcomes: outcomes.toSorted((a, b) => byRank(a.source, b.source) || a.snapshot.localeCompare(b.snapshot)),
  });

  return {
    outcomes,
    things: things.size,
    events: kept.events.length,
    links: kept.links.length,
    orphans: events.size - kept.events.length + (links.size - kept.links.length),
  };
};

const n = (value: number): string => value.toLocaleString("en-US");

const cell = (cells: ReadonlyArray<string>): string =>
  cells.map((c, i) => (i < 2 ? c.padEnd(18) : c.padStart(9))).join("");

/** The coverage report: what each snapshot gave, what the archive holds, and what failed. */
export const report = (built: Built): string => {
  const failed = built.outcomes.filter((o) => o.error !== null);

  return [
    cell(["source", "snapshot", "things", "events", "links", "redacted"]),
    ...built.outcomes.map((o) =>
      o.error === null
        ? cell([o.source, o.snapshot, n(o.things), n(o.events), n(o.links), n(o.redacted)])
        : `${cell([o.source, o.snapshot])}  failed`,
    ),
    "",
    `commonplace.db  ${n(built.things)} things · ${n(built.events)} events · ${n(built.links)} links`,
    ...(built.orphans > 0
      ? [`  dropped ${n(built.orphans)} events/links from a thing no source defined`]
      : []),
    ...(failed.length > 0
      ? [`${failed.length} snapshot(s) failed and were skipped:`, ...failed.map((o) => `  ${o.error}`)]
      : []),
  ].join("\n");
};
