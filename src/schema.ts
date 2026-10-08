export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type Extra = Record<string, Json>;

/** Happens at most once per thing, so every source that saw it merges into one event: `saved:url:example.com`. */
export const onceVerbs = ["saved", "liked", "followed", "posted", "opened"] as const;

/** Can happen any number of times. Each one is its own event. */
export const repeatVerbs = [
  "prompted",
  "charged",
  "paid",
  "sent",
  "received",
  "committed",
  "reviewed",
  "commented",
  "watched",
  "searched",
  "visited",
] as const;

export type Verb = (typeof onceVerbs)[number] | (typeof repeatVerbs)[number];

export const verbs: ReadonlyArray<string> = [...onceVerbs, ...repeatVerbs];

export const isOnce = (verb: Verb): boolean => (onceVerbs as ReadonlyArray<string>).includes(verb);

export const rels = ["part_of", "replies_to", "quotes", "mentions"] as const;

export type Rel = (typeof rels)[number];

/** Something you made, saved, or touched. Its ID comes from its content, so every source names it the same way. */
export interface Thing {
  readonly id: string;
  readonly kind: string;
  readonly title: string | null;
  readonly text: string | null;
  readonly url: string | null;
  readonly author: string | null;
  readonly created_at: string | null;
  readonly extra: Extra;
}

/** Something you did to a thing. `ts` is set only when the source recorded it; nothing is estimated. */
export interface Event {
  readonly verb: Verb;
  readonly thing: string;
  readonly ts: string | null;
  readonly text: string | null;
  readonly collections: ReadonlyArray<string>;
  readonly extra: Extra;
  /** Names a repeatable event within its source. Defaults to a hash of the event. */
  readonly key: string | null;
}

export interface Link {
  readonly from: string;
  readonly rel: Rel;
  readonly to: string;
}

export type Row =
  | ({ readonly type: "thing" } & Thing)
  | ({ readonly type: "event" } & Event)
  | ({ readonly type: "link" } & Link);

type Optional<T, K extends keyof T> = Pick<T, K> & Partial<Omit<T, K>>;

export const thing = (t: Optional<Thing, "id" | "kind">): Row => ({
  type: "thing",
  title: null,
  text: null,
  url: null,
  author: null,
  created_at: null,
  extra: {},
  ...t,
});

export const event = (e: Optional<Event, "verb" | "thing">): Row => ({
  type: "event",
  ts: null,
  text: null,
  collections: [],
  extra: {},
  key: null,
  ...e,
});

export const link = (from: string, rel: Rel, to: string): Row => ({ type: "link", from, rel, to });

/** ISO 8601 in UTC, or null when the source has no real time. */
export const iso = (value: string | number | null | undefined): string | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** `url:<host><path>`: one ID per page, whichever source saw it. */
export const urlId = (href: string): string => {
  const url = new URL(href);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const query = [...url.searchParams].filter(([key]) => !key.startsWith("utm_"));
  const search = query.length > 0 ? `?${new URLSearchParams(query).toString()}` : "";

  return `url:${host}${url.pathname.replace(/\/+$/, "")}${search}`;
};

const idPattern = /^[a-z][\w-]*(:[\w-]+)*:\S/;
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const badTime = (value: string | null): boolean => value !== null && !isoPattern.test(value);

/** Why a row can't go into the archive, or null when it can. */
export const problem = (row: Row): string | null => {
  switch (row.type) {
    case "thing":
      return !idPattern.test(row.id)
        ? `thing id ${JSON.stringify(row.id)} is not <scheme>:<id>`
        : badTime(row.created_at)
          ? `created_at ${JSON.stringify(row.created_at)} is not ISO UTC (use iso())`
          : null;
    case "event":
      return !verbs.includes(row.verb)
        ? `unknown verb ${JSON.stringify(row.verb)}`
        : !idPattern.test(row.thing)
          ? `event thing ${JSON.stringify(row.thing)} is not <scheme>:<id>`
          : badTime(row.ts)
            ? `ts ${JSON.stringify(row.ts)} is not ISO UTC (use iso())`
            : null;
    case "link":
      return (rels as ReadonlyArray<string>).includes(row.rel)
        ? null
        : `unknown rel ${JSON.stringify(row.rel)}`;
  }
};
