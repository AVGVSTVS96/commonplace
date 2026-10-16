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
  "viewed",
  "navigated",
] as const;

export type Verb = (typeof onceVerbs)[number] | (typeof repeatVerbs)[number];

export const verbs: ReadonlyArray<string> = [...onceVerbs, ...repeatVerbs];

export const isOnce = (verb: Verb): boolean => (onceVerbs as ReadonlyArray<string>).includes(verb);

export const rels = ["part_of", "replies_to", "quotes", "reposts", "mentions"] as const;

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

export interface Ref {
  readonly id: string;
  readonly kind: string;
}

const web = (href: string): URL | null => {
  const url = URL.parse(href.trim());

  return url?.protocol === "http:" || url?.protocol === "https:" ? url : null;
};

const bareHost = (url: URL): string => url.hostname.toLowerCase().replace(/^www\./, "");

const tweetHosts = new Set(["x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com"]);
const youtubeHosts = new Set(["youtube.com", "m.youtube.com"]);
const numeric = /^\d+$/;

/**
 * What a link points at, named the same whichever source saw it: a post, video, repo or pull request
 * when it is one, else the page, `url:<host><path>` without `www.`, tracking parameters, a fragment or a
 * trailing slash. Google's `/url?q=` redirect is followed first. Null for anything but an http(s) URL.
 */
export const urlRef = (href: string): Ref | null => {
  const found = web(href);

  if (found === null) {
    return null;
  }

  const url =
    bareHost(found) === "google.com" && found.pathname === "/url"
      ? (web(found.searchParams.get("q") ?? "") ?? found)
      : found;
  const host = bareHost(url);
  const [first, second, third, fourth] = url.pathname.split("/").filter((part) => part !== "");
  const watched = url.searchParams.get("v");

  if (tweetHosts.has(host) && second === "status" && numeric.test(third ?? "")) {
    return { id: `x:tweet:${third}`, kind: "tweet" };
  }
  if (host === "youtu.be" && first !== undefined) {
    return { id: `yt:video:${first}`, kind: "video" };
  }
  if (youtubeHosts.has(host) && first === "watch" && watched !== null && watched !== "") {
    return { id: `yt:video:${watched}`, kind: "video" };
  }
  if (youtubeHosts.has(host) && first === "shorts" && second !== undefined) {
    return { id: `yt:video:${second}`, kind: "video" };
  }
  if (host === "github.com" && first !== undefined && second !== undefined) {
    const repo = `${first}/${second}`.toLowerCase();

    if (third === "pull" && numeric.test(fourth ?? "")) {
      return { id: `gh:pr:${repo}#${Number(fourth)}`, kind: "pr" };
    }
    if (third === undefined) {
      return { id: `gh:repo:${repo}`, kind: "repo" };
    }
  }

  const query = [...url.searchParams].filter(([key]) => !key.startsWith("utm_") && key !== "s");
  const search = query.length > 0 ? `?${new URLSearchParams(query).toString()}` : "";

  return { id: `url:${host}${url.pathname.replace(/\/+$/, "")}${search}`, kind: "url" };
};

/** `sha1` of the fields joined with `|`, null as empty: an ID for a record with no ID of its own. */
export const digest = (...fields: ReadonlyArray<string | null>): string =>
  new Bun.CryptoHasher("sha1").update(fields.map((field) => field ?? "").join("|")).digest("hex");

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
