import { existsSync, readdirSync, readFileSync } from "node:fs";

import { digest, event, type Extra, link, type Ref, type Row, thing, urlRef } from "../src/schema.ts";
import { csv as records, defineSource } from "../src/source.ts";

/** A thing to point an event at, and the URL that best opens it. */
interface Target extends Ref {
  readonly url: string | null;
}

interface ThingFields {
  readonly title?: string | null;
  readonly text?: string | null;
  readonly author?: string | null;
  readonly created_at?: string | null;
  readonly extra?: Extra;
}

interface EventFields {
  readonly ts: string | null;
  readonly text?: string | null;
  readonly collections?: ReadonlyArray<string>;
  readonly extra?: Extra;
}

const put = (target: Target, fields: ThingFields): Row =>
  thing({ id: target.id, kind: target.kind, url: target.url, ...fields });

const happened = (verb: "saved" | "liked" | "followed" | "posted", target: Target, fields: EventFields) =>
  event({ verb, thing: target.id, ...fields, collections: [...(fields.collections ?? [])] });

const fail = (file: string, at: string, reason: string): never => {
  throw new Error(`${file} (${at}): ${reason}`);
};

/** A recorded instant as ISO UTC. Times without a zone are refused rather than read as local. */
const utc = (raw: string, file: string, at: string): string => {
  const date = new Date(raw);

  return /(Z|[+-]\d{2}:\d{2})$/.test(raw) && !Number.isNaN(date.getTime())
    ? date.toISOString()
    : fail(file, at, `not a zoned time: ${raw}`);
};

const listed = (dir: string, pattern: RegExp): Array<string> =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => pattern.test(name))
        .toSorted()
        .map((name) => `${dir}/${name}`)
    : [];

const baseName = (path: string): string => path.split("/").at(-1) ?? path;

/** Where a link really goes: Google's `/url?q=` redirect is unwrapped. */
const destination = (raw: string): string => {
  const url = URL.parse(raw);

  return url !== null && /^(www\.)?google\.[a-z.]+$/.test(url.hostname) && url.pathname === "/url"
    ? (url.searchParams.get("q") ?? raw)
    : raw;
};

const page = (raw: string): Target | null => {
  const ref = urlRef(raw);

  return ref === null ? null : { ...ref, url: destination(raw) };
};

/** Takeout writes some titles as a URL, some without the scheme (`site.com/path`); those aren't titles. */
const titleUnlessUrl = (title: string, target: Target): string | null =>
  /^https?:\/\//.test(title) || urlRef(`https://${title}`)?.id === target.id ? null : title;

const video = (id: string): Target => ({
  id: `yt:video:${id}`,
  kind: "video",
  url: `https://www.youtube.com/watch?v=${id}`,
});

const channelId = (raw: string | undefined): string | null =>
  raw === undefined ? null : (/\/channel\/([\w-]+)/.exec(raw)?.[1] ?? null);

// Places. Google Maps names a place by its feature ID `0x<cell>:0x<cid>`; the second half is the CID that
// `?cid=` URLs carry in decimal, so every form below lands on the same `place:<cid>`.

const featureId = /0x[0-9a-f]+:(0x[0-9a-f]+)/i;

const cidFromFeature = (feature: string): string | null => {
  const hex = featureId.exec(feature)?.[1];
  const cid = hex === undefined ? null : BigInt(hex).toString();

  return cid === "0" ? null : cid;
};

const byCid = (cid: string): Target => ({
  id: `place:${cid}`,
  kind: "place",
  url: `https://maps.google.com/?cid=${cid}`,
});

/** No CID: the name and the coordinates, rounded to 4 decimals. */
const placeAt = (name: string, [lat, lng]: readonly [number, number], url: string | null): Target => ({
  id: `place:${name}@${lat.toFixed(4)},${lng.toFixed(4)}`,
  kind: "place",
  url,
});

const only = <A>(values: ReadonlyArray<A>): A | null => (values.length === 1 ? (values[0] ?? null) : null);

/** `"40.92,-73.80"` → `[40.92, -73.80]` */
const parseCoords = (text: string): readonly [number, number] | null => {
  const match = /^\s*'?(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)'?\s*$/.exec(text);

  return match === null ? null : [Number(match[1]), Number(match[2])];
};

const allCids = (raw: string): ReadonlyArray<string> => [
  ...new Set(
    [...raw.matchAll(new RegExp(featureId.source, "gi"))].flatMap(([feature]) => {
      const cid = cidFromFeature(feature);

      return cid === null ? [] : [cid];
    }),
  ),
];

const explicitCid = (url: URL): string | null => {
  const ftid = url.searchParams.get("ftid");
  const cid =
    url.searchParams.get("cid") ??
    (ftid === null ? null : cidFromFeature(ftid)) ??
    (url.hostname === "local.google.com" ? url.searchParams.get("id") : null);

  return cid !== null && /^\d+$/.test(cid) && cid !== "0" ? cid : null;
};

const pinned = (raw: string): readonly [number, number] | null =>
  only(
    [...raw.matchAll(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/g)].map(
      ([, lat, lng]) => [Number(lat), Number(lng)] as const,
    ),
  );

const searchedCoords = (url: URL): readonly [number, number] | null => {
  const segment = /\/maps\/(?:search|place)\/([^/@]+)/.exec(url.pathname)?.[1];
  const q = url.searchParams.get("q");

  return (
    (segment === undefined ? null : parseCoords(decodeURIComponent(segment))) ??
    (q === null ? null : parseCoords(q))
  );
};

/**
 * The place a Google Maps URL is about: its CID when the URL carries one (as `cid`, `ftid`,
 * local.google.com `id`, or a single feature ID in the data blob), else the pinned coordinates.
 */
const placeRef = (raw: string, name: string): Target | null => {
  const url = URL.parse(raw);

  if (url === null) {
    return null;
  }

  const cid = explicitCid(url) ?? only(allCids(raw));

  if (cid !== null) {
    return byCid(cid);
  }

  const at = pinned(raw) ?? searchedCoords(url);

  return at === null ? null : placeAt(name, at, raw);
};

/**
 * Directions URLs list their stops in order as `!1m<n>` groups of the data blob: after `!4m<n>!4m<n>`
 * in `/maps/dir/` URLs, after `!4m<n>!3m<n>` in the older `/maps/preview#!data=` ones. A stop holds a
 * feature ID (`1s0x…` or `2s0x…`), its coordinates (`3d`, `4d`), or neither when it was typed text.
 */
const stops = (raw: string): ReadonlyArray<ReadonlyArray<string>> => {
  const tokens = raw.split("!");
  const start = tokens.findIndex(
    (token, i) => /^4m\d+$/.test(token) && /^[34]m\d+$/.test(tokens[i + 1] ?? ""),
  );
  const found: Array<ReadonlyArray<string>> = [];

  if (start < 0) {
    return found;
  }

  for (let i = start + 2; i < tokens.length;) {
    const size = /^1m(\d+)$/.exec(tokens[i] ?? "")?.[1];

    if (size === undefined) {
      break;
    }

    found.push(tokens.slice(i + 1, i + 1 + Number(size)));
    i += 1 + Number(size);
  }

  return found;
};

const stopRef = (stop: ReadonlyArray<string>, name: string, raw: string): Target | null => {
  const value = (key: string) => stop.find((token) => token.startsWith(key))?.slice(key.length);
  const cid = only(
    stop.flatMap((token) => (/^[12]s/.test(token) ? [cidFromFeature(token)] : [])).filter((c) => c !== null),
  );
  const [lat, lng] = [value("3d"), value("4d")];

  return cid !== null
    ? byCid(cid)
    : lat !== undefined && lng !== undefined && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
      ? placeAt(name, [Number(lat), Number(lng)], raw)
      : null;
};

/** The last `/maps/dir/` path segment, when it's typed coordinates. */
const pathDestination = (raw: string): readonly [number, number] | null => {
  const url = URL.parse(raw);
  const segment = url?.pathname.includes("/maps/dir/")
    ? url.pathname.split("/").findLast((part) => part !== "" && !part.startsWith("@"))
    : undefined;

  return segment === undefined ? null : parseCoords(decodeURIComponent(segment));
};

/**
 * The destination of a "Directions to" URL: the last stop's CID or coordinates, else coordinates typed
 * as the destination. Routes to typed addresses or "Current Location" have neither.
 */
const destinationRef = (raw: string, name: string): Target | null => {
  const last = stops(raw).at(-1);
  const stop = last === undefined ? null : stopRef(last, name, raw);

  if (stop !== null) {
    return stop;
  }

  const typed = parseCoords(name) ?? pathDestination(raw);

  return typed === null ? null : placeAt(name, typed, raw);
};

// My Activity: every product shares one record format, and the verb is the title's prefix.

interface Activity {
  readonly title: string;
  readonly titleUrl?: string;
  readonly time: string;
  readonly description?: string;
  readonly subtitles?: ReadonlyArray<{ readonly name: string; readonly url?: string }>;
  readonly details?: ReadonlyArray<{ readonly name: string }>;
}

type Action =
  | "searched"
  | "visited"
  | "watched"
  | "viewed"
  | "navigated"
  | "liked"
  | "saved"
  | "followed"
  | null;

/**
 * Every title prefix in the export, in match order, and what it means; `null` is left out on purpose,
 * and a title that matches none fails the snapshot rather than default. A rule marked "without link"
 * applies only to entries that have no `titleUrl`.
 */
const rules: ReadonlyArray<readonly [RegExp, Action] | readonly [RegExp, Action, "without link"]> = [
  [/^Searched for (.+)$/s, "searched"],
  [/^Searched with Google Lens$/, null], // image search, the export keeps no query
  [/^Visited (.+)$/s, "visited"],
  [/^Shopped for (.+)$/s, "visited"],
  [/^Opened My Maps map: (.+)$/s, "visited"],
  [/^Confirmed delivery info and viewed menu for (.+)$/s, "visited"],
  [/^Watched https:\/\/www\.youtube\.com\/watch\?v=$/, null], // an ad with an empty video id
  [/^Watched (.+)$/s, "watched"],
  [/^Viewed area (in|around) /, null], // map panned, no place
  [/^Viewed your Timeline$/, null],
  [/^Viewed (?!https?:)/, null, "without link"], // a search result card with neither link nor location
  [/^Viewed (.+)$/s, "viewed"],
  [/^Directions to (.+)$/s, "navigated"],
  [/^Liked (.+)$/s, "liked"],
  [/^Saved (.+)$/s, "saved"],
  [/^Subscribed to (.+)$/s, "followed"],
  [/^Joined YouTube Premium$/, null],
  [/^Joined (.+)$/s, "followed"],
  [/^Disliked /, null],
  [/^Rented /, null], // a purchase; the viewing is its own Watched entry
  [/^Called /, null],
  [/^Shared /, null],
  [/^Used /, null],
  [/^Explored on Google Maps$/, null],
  [/^Ran internet speed test$/, null],
  [/^Answered survey question$/, null],
  [/^Dismissed /, null],
  [/^Voted on /, null],
  [/^Tracked flight prices$/, null],
  [/^Defined /, null], // a dictionary card for a search that's logged on its own
  [/^\d+ notifications?$/, null],
  [/^Google (automatically added|will now automatically add) /, null],
  [/^Set Food Preferences$/, null],
];

const classify = (product: string, record: Activity): readonly [Action, string] | undefined => {
  for (const [pattern, action, when] of rules) {
    const match = when === undefined || record.titleUrl === undefined ? pattern.exec(record.title) : null;

    if (match !== null) {
      return [action, match[1] ?? record.title];
    }
  }

  // Old Maps clients logged a place view as the bare place name with its Maps URL.
  return product === "Maps" && record.titleUrl !== undefined ? ["viewed", record.title] : undefined;
};

function* activityRows(file: string, product: string, record: Activity, at: string): Generator<Row> {
  const [action, rest] =
    classify(product, record) ?? fail(file, at, `no verb for title ${JSON.stringify(record.title)}`);

  if (action === null) {
    return;
  }

  const ts = utc(record.time, file, at);
  const titleUrl = record.titleUrl;
  const fields = {
    ts,
    text: record.description ?? null,
    extra:
      record.details === undefined
        ? { product }
        : { product, details: record.details.map((detail) => detail.name) },
  };
  const uploader = record.subtitles?.[0];
  const channel = channelId(uploader?.url);
  const byUploader = channel === null ? {} : { author: uploader?.name ?? null, extra: { channel } };
  const linked = (target: Target | null): Target =>
    target ?? fail(file, at, `no thing to point ${JSON.stringify(record.title)} at`);
  const visited = () => (titleUrl === undefined ? null : page(titleUrl)) ?? page(rest);
  const repeat = (verb: "searched" | "visited" | "watched" | "viewed" | "navigated", target: Target) =>
    event({
      verb,
      thing: target.id,
      key: digest(ts, record.title, titleUrl ?? null, record.description ?? null),
      ...fields,
    });

  switch (action) {
    case "searched": {
      const query: Target = {
        id: `query:${rest.replace(/\s+/g, " ").trim().toLowerCase()}`,
        kind: "query",
        url: null,
      };
      yield put(query, { title: rest.trim() });
      yield repeat("searched", query);
      return;
    }
    case "visited":
    case "watched": {
      const target = linked(visited());
      yield put(target, { title: titleUnlessUrl(rest, target), ...byUploader });
      yield repeat(action, target);
      return;
    }
    case "viewed": {
      const target = linked((titleUrl === undefined ? null : placeRef(titleUrl, rest)) ?? visited());
      yield put(target, { title: titleUnlessUrl(rest, target), ...byUploader });
      yield repeat("viewed", target);
      return;
    }
    case "navigated": {
      const target = linked((titleUrl === undefined ? null : destinationRef(titleUrl, rest)) ?? visited());
      yield put(target, { title: rest });
      yield repeat("navigated", target);
      return;
    }
    case "liked":
    case "saved": {
      const target = linked(visited());
      yield put(target, { title: titleUnlessUrl(rest, target), ...byUploader });
      yield happened(action, target, fields);
      return;
    }
    case "followed": {
      const id = channelId(titleUrl);
      const target = linked(
        id === null ? null : { id: `yt:channel:${id}`, kind: "channel", url: titleUrl ?? null },
      );
      yield put(target, { title: rest });
      yield happened("followed", target, fields);
    }
  }
}

function* myActivity(dir: string): Generator<Row> {
  const root = `${dir}/My Activity`;
  const files = existsSync(root)
    ? readdirSync(root)
        .map((product) => `${root}/${product}/MyActivity.json`)
        .filter((file) => existsSync(file))
        .toSorted()
    : [];

  for (const file of files) {
    const product = file.split("/").at(-2) ?? file;

    for (const [i, record] of (JSON.parse(readFileSync(file, "utf8")) as ReadonlyArray<Activity>).entries()) {
      yield* activityRows(file, product, record, `record ${i + 1}`);
    }
  }
}

// CSV files: Maps lists and YouTube.

/**
 * Rows of a CSV file by column name, with the row's place in the file. Takeout prefixes a space to cells
 * that start with `-`, `=`, `+` or `@` against spreadsheet formulas, and pads some files with empty rows.
 */
function* csv<Column extends string>(
  file: string,
  required: ReadonlyArray<Column>,
): Generator<readonly [Record<Column, string> & Record<string, string | undefined>, string]> {
  if (!existsSync(file)) {
    return;
  }

  const [header = [], ...body] = records(file);

  for (const [i, cells] of body.entries()) {
    if (cells.some((cell) => cell !== "")) {
      const at = `row ${i + 1}`;
      const row = Object.fromEntries(header.map((name, c) => [name, cells[c]?.replace(/^ (?=[-=+@])/, "")]));
      const missing = required.find((column) => row[column] === undefined);

      if (missing !== undefined) {
        fail(file, at, `no ${missing} column`);
      }

      yield [row as Record<Column, string>, at];
    }
  }
}

const nonEmpty = (value: string): string | null => (value.trim() === "" ? null : value);

/** `Saved/<list>.csv`: one Maps list per file, named by the file. Lists can hold web pages too. No save time is recorded. */
function* savedLists(dir: string): Generator<Row> {
  for (const file of listed(`${dir}/Saved`, /\.csv$/)) {
    const list = baseName(file).replace(/\.csv$/, "");

    for (const [row, at] of csv(file, ["Title", "Note", "URL", "Tags", "Comment"])) {
      const target =
        placeRef(row.URL, row.Title) ??
        page(row.URL) ??
        fail(file, at, `no place for ${JSON.stringify(row.Title)}`);
      const note = [row.Note, row.Comment].filter((part) => part.trim() !== "");
      const tags = nonEmpty(row.Tags);

      yield put(target, { title: nonEmpty(row.Title) });
      yield happened("saved", target, {
        ts: null,
        text: note.length === 0 ? null : note.join("\n"),
        collections: [list],
        extra: tags === null ? {} : { tags },
      });
    }
  }
}

interface Feature<P> {
  readonly geometry: { readonly coordinates: readonly [number, number] };
  readonly properties: P;
}

interface Location {
  readonly name?: string;
  readonly address?: string;
}

function* features<P>(file: string): Generator<readonly [Feature<P>, string]> {
  if (existsSync(file)) {
    const { features: all } = JSON.parse(readFileSync(file, "utf8")) as {
      features: ReadonlyArray<Feature<P>>;
    };

    for (const [i, feature] of all.entries()) {
      yield [feature, `features[${i}]`];
    }
  }
}

/** GeoJSON is `[lng, lat]`; Takeout writes `[0, 0]` when it has no location. */
const pointOf = ([lng, lat]: readonly [number, number]): readonly [number, number] | null =>
  lng === 0 && lat === 0 ? null : [lat, lng];

const placeFields = (location: Location | undefined): ThingFields => ({
  title: location?.name ?? null,
  extra: location?.address === undefined ? {} : { address: location.address },
});

function* places(dir: string): Generator<Row> {
  const saved = `${dir}/Maps (your places)/Saved Places.json`;
  const reviews = `${dir}/Maps (your places)/Reviews.json`;
  const labeled = `${dir}/Maps/My labeled places/Labeled places.json`;

  for (const [{ geometry, properties }, at] of features<{
    date: string;
    google_maps_url: string;
    location?: Location;
  }>(saved)) {
    const name = properties.location?.name ?? properties.google_maps_url;
    const point = pointOf(geometry.coordinates);
    const target =
      placeRef(properties.google_maps_url, name) ??
      (point === null ? null : placeAt(name, point, properties.google_maps_url)) ??
      fail(saved, at, `no place for ${JSON.stringify(name)}`);

    yield put(target, placeFields(properties.location));
    yield happened("saved", target, { ts: utc(properties.date, saved, at), collections: ["Saved Places"] });
  }

  for (const [{ properties }, at] of features<{
    date: string;
    google_maps_url: string;
    location: Location;
    five_star_rating_published?: number;
    review_text_published?: string;
  }>(reviews)) {
    const name = properties.location.name ?? properties.google_maps_url;
    const target =
      placeRef(properties.google_maps_url, name) ?? fail(reviews, at, `no place for ${JSON.stringify(name)}`);

    yield put(target, placeFields(properties.location));
    yield happened("posted", target, {
      ts: utc(properties.date, reviews, at),
      text: properties.review_text_published ?? null,
      extra:
        properties.five_star_rating_published === undefined
          ? {}
          : { rating: properties.five_star_rating_published },
    });
  }

  // Places given a private label (Home, Work, …). No CID, so they're keyed by coordinates.
  for (const [{ geometry, properties }, at] of features<{ name: string; address?: string }>(labeled)) {
    const name = properties.address ?? properties.name;
    const point = pointOf(geometry.coordinates) ?? fail(labeled, at, `no place for ${JSON.stringify(name)}`);
    const target = placeAt(name, point, null);

    yield put(target, { title: name });
    yield happened("saved", target, { ts: null, text: properties.name, collections: ["Labeled places"] });
  }
}

function* youtube(dir: string): Generator<Row> {
  const root = `${dir}/YouTube and YouTube Music`;

  // No subscribe time here; the `Subscribed to` activity entries carry it and merge into the same event.
  for (const [row] of csv(`${root}/subscriptions/subscriptions.csv`, [
    "Channel Id",
    "Channel Url",
    "Channel Title",
  ])) {
    const target: Target = {
      id: `yt:channel:${row["Channel Id"]}`,
      kind: "channel",
      url: row["Channel Url"],
    };

    yield put(target, { title: row["Channel Title"] });
    yield happened("followed", target, { ts: null });
  }

  for (const file of listed(`${root}/playlists`, /-videos\.csv$/)) {
    const playlist = baseName(file).replace(/-videos\.csv$/, "");

    for (const [row, at] of csv(file, ["Video ID", "Playlist Video Creation Timestamp"])) {
      const target = video(row["Video ID"]);

      yield put(target, {});
      yield happened("saved", target, {
        ts: utc(row["Playlist Video Creation Timestamp"], file, at),
        collections: [playlist],
      });
    }
  }

  // Each comment is its own thing, posted once, replying to the video or community post it's on.
  // Older comment files lack the `Parent Comment ID` and `Post ID` columns.
  for (const file of listed(`${root}/comments`, /\.csv$/)) {
    for (const [row, at] of csv(file, [
      "Comment ID",
      "Comment Create Timestamp",
      "Video ID",
      "Comment Text",
    ])) {
      const ts = utc(row["Comment Create Timestamp"], file, at);
      const segments = JSON.parse(`[${row["Comment Text"]}]`) as ReadonlyArray<{ text?: string }>;
      const post = row["Post ID"] ?? "";
      const on =
        (row["Video ID"] !== ""
          ? video(row["Video ID"])
          : post !== ""
            ? page(`https://www.youtube.com/post/${post}`)
            : null) ?? fail(file, at, "comment on neither a video nor a post");
      const parent = row["Parent Comment ID"] ?? "";
      const comment: Target = {
        id: `yt:comment:${row["Comment ID"]}`,
        kind: "comment",
        url: on.kind === "video" ? `${on.url}&lc=${row["Comment ID"]}` : on.url,
      };

      yield put(on, {});
      yield put(comment, {
        text: segments.map((segment) => segment.text ?? "").join(""),
        created_at: ts,
        extra: parent === "" ? {} : { parent },
      });
      yield link(comment.id, "replies_to", on.id);
      yield happened("posted", comment, { ts });
    }
  }

  const uploads = `${root}/video metadata/videos.csv`;

  for (const [row, at] of csv(uploads, [
    "Video ID",
    "Video Title (Original)",
    "Video Description (Original)",
    "Channel ID",
    "Privacy",
    "Video Create Timestamp",
  ])) {
    const ts = utc(row["Video Create Timestamp"], uploads, at);

    yield put(video(row["Video ID"]), {
      title: row["Video Title (Original)"],
      text: row["Video Description (Original)"] === "" ? null : row["Video Description (Original)"],
      created_at: ts,
      extra: { channel: row["Channel ID"], privacy: row.Privacy },
    });
    yield happened("posted", video(row["Video ID"]), { ts });
  }
}

/**
 * A Google Takeout export, unzipped into the snapshot, its `Takeout/` folder or what's in it, with
 * My Activity exported as JSON: searches, visits, watches and views from My Activity, Maps lists, saved and labeled places and reviews, YouTube subscriptions, playlists,
 * comments and uploads. Products you didn't export are simply absent.
 *
 * Left out on purpose: `YouTube and YouTube Music/history` (the same watches and searches as
 * My Activity), and Calendar, Play Store, Discover and Timeline settings, which no verb fits.
 */
export default defineSource({
  name: "takeout",
  rows: function* ({ dir }) {
    const root = existsSync(`${dir}/Takeout`) ? `${dir}/Takeout` : dir;

    yield* myActivity(root);
    yield* savedLists(root);
    yield* places(root);
    yield* youtube(root);
  },
});
