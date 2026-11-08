import { Database, SQLiteError } from "bun:sqlite";

import { iso } from "./schema.ts";

export interface Hit {
  readonly id: string;
  readonly what: string;
  readonly at: string | null;
  readonly title: string | null;
  readonly url: string | null;
  readonly text: string | null;
}

type Columns = Readonly<Record<string, string | number | null>>;

const clip = (column: string, length: number) =>
  `CASE WHEN length(${column}) > ${length} THEN substr(${column}, 1, ${length}) || '…' ELSE ${column} END`;

const parsed = (row: Columns | null) =>
  row === null
    ? null
    : Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          ["sources", "extra", "collections"].includes(key) ? JSON.parse(String(value)) : value,
        ]),
      );

const at = (value: string | undefined): string | null =>
  value === undefined ? null : (iso(value) ?? value);

const quoted = (q: string) =>
  q
    .split(/\s+/u)
    .filter(Boolean)
    .map((word) => `"${word.replaceAll('"', '""')}"`)
    .join(" ");

export const open = (file: string) => {
  const db = new Database(file, { readonly: true, strict: true });

  const searchQuery = db.query<Hit, { q: string; limit: number }>(`
    SELECT s.id,
      coalesce(t.kind, e.verb) AS what,
      coalesce(e.ts, t.created_at, et.created_at,
        (SELECT max(l.ts) FROM events l WHERE l.thing_id = t.id)) AS at,
      coalesce(t.title, et.title) AS title,
      coalesce(t.url, et.url) AS url,
      snippet(search, -1, '«', '»', '…', 24) AS text
    FROM search s
    LEFT JOIN things t ON s.tbl = 'things' AND t.id = s.id
    LEFT JOIN events e ON s.tbl = 'events' AND e.id = s.id
    LEFT JOIN things et ON et.id = e.thing_id
    WHERE search MATCH $q
    ORDER BY rank
    LIMIT $limit
  `);

  const timelineQuery = db.query<
    Hit,
    { since: string | null; until: string | null; verb: string | null; limit: number }
  >(`
    SELECT e.id, e.verb AS what, coalesce(e.ts, t.created_at) AS at, t.title, t.url, ${clip("coalesce(e.text, t.text)", 300)} AS text
    FROM events e JOIN things t ON t.id = e.thing_id
    WHERE ($verb IS NULL OR e.verb = $verb)
      AND ($since IS NULL OR coalesce(e.ts, t.created_at) >= $since)
      AND ($until IS NULL OR coalesce(e.ts, t.created_at) < $until)
    ORDER BY at DESC
    LIMIT $limit
  `);

  const thingQuery = db.query<Columns, { id: string }>(`SELECT * FROM things t WHERE id = $id`);

  const eventQuery = db.query<Columns, { id: string }>(`SELECT * FROM events e WHERE id = $id`);

  const eventsOfQuery = db.query<
    { id: string; verb: string; ts: string | null; text: string | null },
    { id: string }
  >(`
    SELECT e.id, e.verb, e.ts, ${clip("e.text", 300)} AS text
    FROM events e WHERE thing_id = $id
    ORDER BY e.ts DESC LIMIT 100
  `);

  const linksQuery = db.query<
    { rel: string; direction: string; id: string; title: string | null },
    { id: string }
  >(`
    SELECT l.rel, 'to' AS direction, l.to_id AS id, t.title FROM links l LEFT JOIN things t ON t.id = l.to_id
      WHERE l.from_id = $id
    UNION ALL
    SELECT l.rel, 'from' AS direction, t.id, t.title FROM links l JOIN things t ON t.id = l.from_id
      WHERE l.to_id = $id
    LIMIT 200
  `);

  const snapshotsQuery = db.query<
    {
      source: string;
      snapshots: number;
      latest: string;
      things: number;
      events: number;
      failed: number;
    },
    []
  >(`
    SELECT s.source, s.snapshots, s.latest, coalesce(t.n, 0) AS things, coalesce(e.n, 0) AS events, s.failed
    FROM (
      SELECT source, count(*) AS snapshots, max(date) AS latest, sum(error IS NOT NULL) AS failed FROM snapshots
      GROUP BY source
    ) s
    LEFT JOIN (SELECT j.value AS source, count(*) AS n FROM things, json_each(things.sources) j GROUP BY 1) t USING (source)
    LEFT JOIN (SELECT j.value AS source, count(*) AS n FROM events, json_each(events.sources) j GROUP BY 1) e USING (source)
    ORDER BY s.source
  `);

  const verbsQuery = db.query<{ verb: string; n: number }, []>(
    `SELECT verb, count(*) AS n FROM events GROUP BY verb ORDER BY n DESC`,
  );

  const kindsQuery = db.query<{ kind: string; n: number }, []>(
    `SELECT kind, count(*) AS n FROM things GROUP BY kind ORDER BY n DESC`,
  );

  return {
    search: (q: string, limit: number | undefined = 20): Hit[] => {
      try {
        return searchQuery.all({ q, limit });
      } catch (error) {
        if (error instanceof SQLiteError) {
          return searchQuery.all({ q: quoted(q), limit });
        }

        throw error;
      }
    },

    timeline: (options: {
      since?: string | undefined;
      until?: string | undefined;
      verb?: string | undefined;
      limit?: number | undefined;
    }): Hit[] =>
      timelineQuery.all({
        since: at(options.since),
        until: at(options.until),
        verb: options.verb ?? null,
        limit: options.limit ?? 50,
      }),

    show: (id: string) => {
      const event = parsed(eventQuery.get({ id }));
      const thingId = event === null ? id : String(event["thing_id"]);
      const thing = parsed(thingQuery.get({ id: thingId }));

      if (thing === null) {
        return null;
      }

      return event === null
        ? { thing, events: eventsOfQuery.all({ id }), links: linksQuery.all({ id }) }
        : { event, thing };
    },

    stats: () => ({
      sources: snapshotsQuery.all(),
      kinds: kindsQuery.all(),
      verbs: verbsQuery.all(),
    }),

    close: () => {
      db.close();
    },
  };
};

export type Store = ReturnType<typeof open>;
