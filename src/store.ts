import { Database, SQLiteError } from "bun:sqlite";

/** One line of a search result or timeline. `id` is citable: pass it to `show`. */
export interface Hit {
  readonly id: string;
  readonly what: string;
  readonly at: string | null;
  readonly title: string | null;
  readonly url: string | null;
  readonly text: string | null;
}

const visible = (column: string) =>
  `NOT EXISTS (SELECT 1 FROM json_each(${column}) WHERE value NOT IN (SELECT value FROM json_each($allowed)))`;

const clip = (column: string, length: number) =>
  `CASE WHEN length(${column}) > ${length} THEN substr(${column}, 1, ${length}) || '…' ELSE ${column} END`;

const parsed = (row: Record<string, unknown> | null) =>
  row === null
    ? null
    : Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          ["sources", "extra", "collections"].includes(key) ? JSON.parse(String(value)) : value,
        ]),
      );

/** Users type words, not FTS5 syntax. When their query doesn't parse, search for the words themselves. */
const quoted = (q: string) =>
  q
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `"${word.replaceAll('"', '""')}"`)
    .join(" ");

/**
 * Read-only view of the archive that only ever returns rows from `sources`.
 * A row is visible when every source that contributed to it is, so a hidden source can't leak through a merge.
 */
export const open = (file: string, sources: ReadonlyArray<string>) => {
  const db = new Database(file, { readonly: true, strict: true });
  const allowed = JSON.stringify(sources);

  const searchQuery = db.query<Hit, { allowed: string; q: string; limit: number }>(`
    SELECT s.id,
      coalesce(t.kind, e.verb) AS what,
      coalesce(e.ts, t.created_at, et.created_at) AS at,
      coalesce(t.title, et.title) AS title,
      coalesce(t.url, et.url) AS url,
      snippet(search, -1, '«', '»', '…', 24) AS text
    FROM search s
    LEFT JOIN things t ON s.tbl = 'things' AND t.id = s.id
    LEFT JOIN events e ON s.tbl = 'events' AND e.id = s.id
    LEFT JOIN things et ON et.id = e.thing_id
    WHERE search MATCH $q
      AND ${visible("coalesce(t.sources, e.sources)")}
      AND (et.id IS NULL OR ${visible("et.sources")})
    ORDER BY rank
    LIMIT $limit
  `);

  const timelineQuery = db.query<
    Hit,
    {
      allowed: string;
      since: string | null;
      until: string | null;
      verb: string | null;
      limit: number;
    }
  >(`
    SELECT e.id, e.verb AS what, coalesce(e.ts, t.created_at) AS at, t.title, t.url, ${clip("e.text", 300)} AS text
    FROM events e JOIN things t ON t.id = e.thing_id
    WHERE ${visible("e.sources")} AND ${visible("t.sources")}
      AND ($verb IS NULL OR e.verb = $verb)
      AND ($since IS NULL OR coalesce(e.ts, t.created_at) >= $since)
      AND ($until IS NULL OR coalesce(e.ts, t.created_at) < $until)
    ORDER BY at DESC
    LIMIT $limit
  `);

  const thingQuery = db.query<Record<string, unknown>, { allowed: string; id: string }>(
    `SELECT * FROM things t WHERE id = $id AND ${visible("t.sources")}`,
  );
  const eventQuery = db.query<Record<string, unknown>, { allowed: string; id: string }>(
    `SELECT * FROM events e WHERE id = $id AND ${visible("e.sources")}`,
  );
  const eventsOfQuery = db.query<
    { id: string; verb: string; ts: string | null; text: string | null },
    { allowed: string; id: string }
  >(`
    SELECT e.id, e.verb, e.ts, ${clip("e.text", 300)} AS text
    FROM events e WHERE thing_id = $id AND ${visible("e.sources")}
    ORDER BY e.ts DESC LIMIT 100
  `);
  const linksQuery = db.query<
    { rel: string; direction: string; id: string; title: string | null },
    { allowed: string; id: string }
  >(`
    SELECT l.rel, 'to' AS direction, l.to_id AS id, t.title FROM links l LEFT JOIN things t ON t.id = l.to_id
      WHERE l.from_id = $id AND ${visible("l.sources")} AND (t.id IS NULL OR ${visible("t.sources")})
    UNION ALL
    SELECT l.rel, 'from' AS direction, t.id, t.title FROM links l JOIN things t ON t.id = l.from_id
      WHERE l.to_id = $id AND ${visible("l.sources")} AND ${visible("t.sources")}
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
    { allowed: string }
  >(`
    SELECT s.source, s.snapshots, s.latest, coalesce(t.n, 0) AS things, coalesce(e.n, 0) AS events, s.failed
    FROM (
      SELECT source, count(*) AS snapshots, max(date) AS latest, sum(error IS NOT NULL) AS failed FROM snapshots
      WHERE source IN (SELECT value FROM json_each($allowed)) GROUP BY source
    ) s
    LEFT JOIN (SELECT j.value AS source, count(*) AS n FROM things, json_each(things.sources) j GROUP BY 1) t USING (source)
    LEFT JOIN (SELECT j.value AS source, count(*) AS n FROM events, json_each(events.sources) j GROUP BY 1) e USING (source)
    ORDER BY s.source
  `);
  const verbsQuery = db.query<{ verb: string; n: number }, { allowed: string }>(
    `SELECT verb, count(*) AS n FROM events e WHERE ${visible("e.sources")} GROUP BY verb ORDER BY n DESC`,
  );
  const kindsQuery = db.query<{ kind: string; n: number }, { allowed: string }>(
    `SELECT kind, count(*) AS n FROM things t WHERE ${visible("t.sources")} GROUP BY kind ORDER BY n DESC`,
  );

  return {
    search: (q: string, limit: number | undefined = 20): Array<Hit> => {
      try {
        return searchQuery.all({ allowed, q, limit });
      } catch (error) {
        if (error instanceof SQLiteError) {
          return searchQuery.all({ allowed, q: quoted(q), limit });
        }
        throw error;
      }
    },

    timeline: (options: {
      since?: string | undefined;
      until?: string | undefined;
      verb?: string | undefined;
      limit?: number | undefined;
    }): Array<Hit> =>
      timelineQuery.all({
        allowed,
        since: options.since ?? null,
        until: options.until ?? null,
        verb: options.verb ?? null,
        limit: options.limit ?? 50,
      }),

    show: (id: string) => {
      const event = parsed(eventQuery.get({ allowed, id }));
      const thingId = event === null ? id : String(event["thing_id"]);
      const thing = parsed(thingQuery.get({ allowed, id: thingId }));

      if (thing === null) {
        return null;
      }

      return event === null
        ? {
            thing,
            events: eventsOfQuery.all({ allowed, id }),
            links: linksQuery.all({ allowed, id }),
          }
        : { event, thing };
    },

    stats: () => ({
      sources: snapshotsQuery.all({ allowed }),
      kinds: kindsQuery.all({ allowed }),
      verbs: verbsQuery.all({ allowed }),
    }),

    close: () => db.close(),
  };
};

export type Store = ReturnType<typeof open>;
