export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type Extra = Record<string, Json>;

export const onceVerbs = ["saved", "liked", "followed", "posted", "opened"] as const;

export const repeatVerbs = [
  "prompted",
  "charged",
  "paid",
  "sent",
  "typed",
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

export const verbs: readonly string[] = [...onceVerbs, ...repeatVerbs];

const once: ReadonlySet<Verb> = new Set(onceVerbs);

export const isOnce = (verb: Verb): boolean => once.has(verb);

export const rels = ["part_of", "replies_to", "quotes", "reposts", "mentions"] as const;

export type Rel = (typeof rels)[number];

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

export interface Event {
  readonly verb: Verb;
  readonly thing: string;
  readonly ts: string | null;
  readonly text: string | null;
  readonly collections: readonly string[];
  readonly extra: Extra;
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

const bareHost = (url: URL): string => url.hostname.toLowerCase().replace(/^www\./u, "");

const tweetHosts = new Set(["x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com"]);
const youtubeHosts = new Set(["youtube.com", "m.youtube.com"]);
const numeric = /^\d+$/u;

const githubRef = ([owner, name, section, number]: readonly string[]): Ref | null => {
  if (owner === undefined || name === undefined) {
    return null;
  }

  const repo = `${owner}/${name}`.toLowerCase();

  if (section === "pull" && numeric.test(number ?? "")) {
    return { id: `gh:pr:${repo}#${Number(number)}`, kind: "pr" };
  }

  return section === undefined ? { id: `gh:repo:${repo}`, kind: "repo" } : null;
};

const named = (host: string, url: URL): Ref | null => {
  const parts = url.pathname.split("/").filter((part) => part !== "");
  const [first, second, third] = parts;
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

  return host === "github.com" ? githubRef(parts) : null;
};

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
  const query = [...url.searchParams].filter(([key]) => !key.startsWith("utm_") && key !== "s");
  const search = query.length > 0 ? `?${new URLSearchParams(query).toString()}` : "";

  return (
    named(host, url) ?? {
      id: `url:${host}${url.pathname.replace(/\/+$/u, "")}${search}`,
      kind: "url",
    }
  );
};

export const digest = (...fields: readonly (string | null)[]): string =>
  new Bun.CryptoHasher("sha1").update(fields.map((field) => field ?? "").join("|")).digest("hex");

const idPattern = /^[a-z][\w-]*(?::[\w-]+)*:\S/u;
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const badTime = (value: string | null): boolean => value !== null && !isoPattern.test(value);

export const problem = (row: Row): string | null => {
  if (row.type === "link") {
    return rels.includes(row.rel) ? null : `unknown rel ${JSON.stringify(row.rel)}`;
  }

  if (row.type === "event" && !verbs.includes(row.verb)) {
    return `unknown verb ${JSON.stringify(row.verb)}`;
  }

  const [what, id, field, time] =
    row.type === "thing"
      ? ["thing id", row.id, "created_at", row.created_at]
      : ["event thing", row.thing, "ts", row.ts];

  if (!idPattern.test(id)) {
    return `${what} ${JSON.stringify(id)} is not <scheme>:<id>`;
  }

  return badTime(time) ? `${field} ${JSON.stringify(time)} is not ISO UTC (use iso())` : null;
};
