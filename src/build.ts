import { Database } from "bun:sqlite";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import type { Config } from "./config.ts";
import { isOnce, problem } from "./schema.ts";
import type { Event, Extra, Link, Row, Thing } from "./schema.ts";
import type { Snapshot, Source } from "./source.ts";

const datePattern = /^\d{4}-\d{2}-\d{2}(?:\.[\w-]+)?$/u;

export const paths = (data: string) => ({ raw: `${data}/raw`, db: `${data}/commonplace.db` });

export const snapshotsOf = (raw: string, source: string): Snapshot[] => {
  const dir = `${raw}/${source}`;

  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => datePattern.test(name))
        .toSorted()
        .map((name) => ({ source, date: name.slice(0, 10), dir: `${dir}/${name}` }))
    : [];
};

type Sourced<T> = T & { readonly sources: readonly string[] };

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
  readonly outcomes: readonly Outcome[];
  readonly things: number;
  readonly events: number;
  readonly links: number;
  readonly orphans: number;
}

const hash = (fields: readonly (string | null)[]): string =>
  new Bun.CryptoHasher("sha1").update(JSON.stringify(fields)).digest("hex").slice(0, 16);

const eventId = (source: string, event: Event): string =>
  isOnce(event.verb)
    ? `${event.verb}:${event.thing}`
    : `${source}:${event.key ?? hash([event.verb, event.thing, event.ts, event.text])}`;

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

const present = <T extends object>(fields: T): Partial<T> =>
  // SAFETY: every entry comes from `fields` itself, only the nulls are left out.
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null)) as Partial<T>;

const merge = <T extends Sourced<{ readonly extra: Extra }>>(held: T | undefined, offered: T): T =>
  held === undefined
    ? offered
    : {
        ...held,
        ...present(offered),
        sources: union(held.sources, offered.sources),
        extra: { ...offered.extra, ...held.extra, ...present(offered.extra) },
      };

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a catch clause hands over unknown, and this is where it's read
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const load = async (
  source: Source,
  snapshot: Snapshot,
): Promise<{ rows: readonly Row[]; error: string | null }> => {
  const rows: Row[] = [];

  const failed = (why: string) => ({
    rows: [],
    error: `${snapshot.dir}: row ${rows.length + 1}: ${why}`,
  });

  try {
    for await (const row of source.rows(snapshot)) {
      const issue = problem(row);

      if (issue !== null) {
        return failed(issue);
      }

      rows.push(row);
    }
  } catch (error) {
    return failed(errorMessage(error));
  }

  return { rows, error: null };
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
  readonly things: readonly Sourced<Thing>[];
  readonly events: readonly Stored[];
  readonly links: readonly Sourced<Link>[];
  readonly outcomes: readonly Outcome[];
}

const write = (file: string, corpus: Corpus): void => {
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });

  const db = new Database(tmp, { create: true, strict: true });
  const json = JSON.stringify;

  db.run("PRAGMA journal_mode = OFF");
  db.run(schema);
  db.transaction(() => {
    const thing = db.prepare(
      "INSERT INTO things VALUES ($id, $kind, $title, $text, $url, $author, $created_at, $sources, $extra)",
    );

    const event = db.prepare(
      "INSERT INTO events VALUES ($id, $verb, $ts, $thing, $text, $collections, $sources, $extra)",
    );

    const link = db.prepare("INSERT INTO links VALUES ($from, $rel, $to, $sources)");

    const snapshot = db.prepare(
      "INSERT INTO snapshots VALUES ($source, $snapshot, $date, $things, $events, $links, $redacted, $error)",
    );

    for (const t of corpus.things) {
      thing.run({ ...t, sources: json(t.sources), extra: json(t.extra) });
    }

    for (const e of corpus.events) {
      event.run({
        ...e,
        collections: json(e.collections),
        sources: json(e.sources),
        extra: json(e.extra),
      });
    }

    for (const l of corpus.links) {
      link.run({ ...l, sources: json(l.sources) });
    }

    for (const o of corpus.outcomes) {
      snapshot.run({ ...o });
    }
  })();
  db.run(indexes);
  db.close();

  renameSync(tmp, file);
};

export const build = async (config: Config, data: string): Promise<Built> => {
  const { raw, db } = paths(data);
  const rank = (source: string) => config.sources.findIndex(({ name }) => name === source);
  const things = new Map<string, Sourced<Thing>>();
  const events = new Map<string, Stored>();
  const links = new Map<string, Sourced<Link>>();
  const outcomes: Outcome[] = [];

  for (const source of config.sources.toReversed()) {
    for (const snapshot of snapshotsOf(raw, source.name)) {
      const { rows, error } = await load(source, snapshot);
      const counts = { things: 0, events: 0, links: 0, redacted: 0 };
      const sources = [source.name];

      for (const row of rows) {
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
        snapshot: path.basename(snapshot.dir),
        date: snapshot.date,
        ...counts,
        error,
      });
    }
  }

  const byRank = (a: string, b: string) => rank(a) - rank(b);

  const ranked = <T extends Sourced<object>>(row: T): T => ({
    ...row,
    sources: row.sources.toSorted(byRank),
  });

  const kept = {
    events: events
      .values()
      .filter((e) => things.has(e.thing))
      .map(ranked)
      .toArray(),
    links: links
      .values()
      .filter((l) => things.has(l.from))
      .map(ranked)
      .toArray(),
  };

  write(db, {
    things: [...things.values()].map(ranked),
    ...kept,
    outcomes: outcomes.toSorted(
      (a, b) => byRank(a.source, b.source) || a.snapshot.localeCompare(b.snapshot),
    ),
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

const cell = (cells: readonly string[]): string =>
  cells.map((c, i) => (i < 2 ? c.padEnd(18) : c.padStart(9))).join("");

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
      ? [
          `${failed.length} snapshot(s) failed and were skipped:`,
          ...failed.map((o) => `  ${o.error}`),
        ]
      : []),
  ].join("\n");
};
