import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { digest, event, link, thing, urlRef } from "../src/schema.ts";
import type { Extra, Ref, Row } from "../src/schema.ts";
import { csv as records, defineSource, json } from "../src/source.ts";

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
  readonly collections?: readonly string[];
  readonly extra?: Extra;
}

const put = (target: Target, fields: ThingFields): Row =>
  thing({ id: target.id, kind: target.kind, url: target.url, ...fields });

const happened = (
  verb: "saved" | "liked" | "followed" | "posted",
  target: Target,
  fields: EventFields,
) => event({ verb, thing: target.id, ...fields, collections: [...(fields.collections ?? [])] });

const fail = (file: string, at: string, reason: string): never => {
  throw new Error(`${file} (${at}): ${reason}`);
};

const utc = (raw: string, file: string, at: string): string => {
  const date = new Date(raw);

  return /(?:Z|[+-]\d{2}:\d{2})$/u.test(raw) && !Number.isNaN(date.getTime())
    ? date.toISOString()
    : fail(file, at, `not a zoned time: ${raw}`);
};

const listed = (dir: string, pattern: RegExp): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => pattern.test(name))
        .toSorted()
        .map((name) => `${dir}/${name}`)
    : [];

const unwrapGoogleRedirect = (raw: string): string => {
  const url = URL.parse(raw);

  return url !== null &&
    /^(?:www\.)?google\.[a-z.]+$/u.test(url.hostname) &&
    url.pathname === "/url"
    ? (url.searchParams.get("q") ?? raw)
    : raw;
};

const page = (raw: string): Target | null => {
  const ref = urlRef(raw);

  return ref === null ? null : { ...ref, url: unwrapGoogleRedirect(raw) };
};

const titleUnlessUrl = (title: string, target: Target): string | null =>
  /^https?:\/\//u.test(title) || urlRef(`https://${title}`)?.id === target.id ? null : title;

const video = (id: string): Target => ({
  id: `yt:video:${id}`,
  kind: "video",
  url: `https://www.youtube.com/watch?v=${id}`,
});

const channelId = (raw: string | undefined): string | null =>
  raw === undefined ? null : (/\/channel\/(?<id>[\w-]+)/u.exec(raw)?.groups?.["id"] ?? null);

const channel = (url: string | undefined): Target | null => {
  const id = channelId(url);

  return id === null ? null : { id: `yt:channel:${id}`, kind: "channel", url: url ?? null };
};

const featureId = /0x[0-9a-f]+:(?<cid>0x[0-9a-f]+)/iu;

const cidFromFeature = (feature: string): string | null => {
  const hex = featureId.exec(feature)?.groups?.["cid"];
  const cid = hex === undefined ? null : BigInt(hex).toString();

  return cid === "0" ? null : cid;
};

const byCid = (cid: string): Target => ({
  id: `place:${cid}`,
  kind: "place",
  url: `https://maps.google.com/?cid=${cid}`,
});

const placeAt = (
  name: string,
  [lat, lng]: readonly [number, number],
  url: string | null,
): Target => ({
  id: `place:${name}@${lat.toFixed(4)},${lng.toFixed(4)}`,
  kind: "place",
  url,
});

const only = <A>(values: readonly A[]): A | null =>
  values.length === 1 ? (values[0] ?? null) : null;

const parseCoords = (text: string): readonly [number, number] | null => {
  const match = /^\s*'?(?<lat>-?\d{1,2}\.\d+),\s*(?<lng>-?\d{1,3}\.\d+)'?\s*$/u.exec(text)?.groups;

  return match === undefined ? null : [Number(match["lat"]), Number(match["lng"])];
};

const allCids = (raw: string): readonly string[] => [
  ...new Set(
    [...raw.matchAll(new RegExp(featureId.source, "giu"))].flatMap(([feature]) => {
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

  return cid !== null && /^\d+$/u.test(cid) && cid !== "0" ? cid : null;
};

const pinned = (raw: string): readonly [number, number] | null =>
  only(
    [...raw.matchAll(/!3d(?<lat>-?\d+\.\d+)!4d(?<lng>-?\d+\.\d+)/gu)].map(
      ({ groups }) => [Number(groups?.["lat"]), Number(groups?.["lng"])] as const,
    ),
  );

const searchedCoords = (url: URL): readonly [number, number] | null => {
  const match = /\/maps\/(?:search|place)\/(?<segment>[^/@]+)/u.exec(url.pathname);
  const segment = match?.groups?.["segment"];
  const q = url.searchParams.get("q");

  return (
    (segment === undefined ? null : parseCoords(decodeURIComponent(segment))) ??
    (q === null ? null : parseCoords(q))
  );
};

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

const directionStops = (raw: string): readonly (readonly string[])[] => {
  const tokens = raw.split("!");

  const start = tokens.findIndex(
    (token, i) => /^4m\d+$/u.test(token) && /^[34]m\d+$/u.test(tokens[i + 1] ?? ""),
  );

  const found: (readonly string[])[] = [];

  if (start === -1) {
    return found;
  }

  for (let i = start + 2; i < tokens.length;) {
    const size = /^1m(?<size>\d+)$/u.exec(tokens[i] ?? "")?.groups?.["size"];

    if (size === undefined) {
      break;
    }

    found.push(tokens.slice(i + 1, i + 1 + Number(size)));
    i += 1 + Number(size);
  }

  return found;
};

const stopRef = (stop: readonly string[], name: string, raw: string): Target | null => {
  const value = (key: string) => stop.find((token) => token.startsWith(key))?.slice(key.length);

  const cid = only(
    stop
      .flatMap((token) => (/^[12]s/u.test(token) ? [cidFromFeature(token)] : []))
      .filter((c) => c !== null),
  );

  if (cid !== null) {
    return byCid(cid);
  }

  const [lat, lng] = [Number(value("3d")), Number(value("4d"))];

  return Number.isFinite(lat) && Number.isFinite(lng) ? placeAt(name, [lat, lng], raw) : null;
};

const pathDestination = (raw: string): readonly [number, number] | null => {
  const url = URL.parse(raw);

  const segment =
    url?.pathname.includes("/maps/dir/") === true
      ? url.pathname.split("/").findLast((part) => part !== "" && !part.startsWith("@"))
      : undefined;

  return segment === undefined ? null : parseCoords(decodeURIComponent(segment));
};

const destinationRef = (raw: string, name: string): Target | null => {
  const last = directionStops(raw).at(-1);
  const stop = last === undefined ? null : stopRef(last, name, raw);

  if (stop !== null) {
    return stop;
  }

  const typed = parseCoords(name) ?? pathDestination(raw);

  return typed === null ? null : placeAt(name, typed, raw);
};

interface Activity {
  readonly title: string;
  readonly titleUrl?: string;
  readonly time: string;
  readonly description?: string;
  readonly subtitles?: readonly { readonly name: string; readonly url?: string }[];
  readonly details?: readonly { readonly name: string }[];
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

const rules: readonly (readonly [RegExp, Action] | readonly [RegExp, Action, "without link"])[] = [
  [/^Searched for (?<rest>.+)$/su, "searched"],
  [/^Searched with Google Lens$/u, null],
  [/^Visited (?<rest>.+)$/su, "visited"],
  [/^Shopped for (?<rest>.+)$/su, "visited"],
  [/^Opened My Maps map: (?<rest>.+)$/su, "visited"],
  [/^Confirmed delivery info and viewed menu for (?<rest>.+)$/su, "visited"],
  [/^Watched https:\/\/www\.youtube\.com\/watch\?v=$/u, null],
  [/^Watched (?<rest>.+)$/su, "watched"],
  [/^Viewed area (?:in|around) /u, null],
  [/^Viewed your Timeline$/u, null],
  [/^Viewed (?!https?:)/u, null, "without link"],
  [/^Viewed (?<rest>.+)$/su, "viewed"],
  [/^Directions to (?<rest>.+)$/su, "navigated"],
  [/^Liked (?<rest>.+)$/su, "liked"],
  [/^Saved (?<rest>.+)$/su, "saved"],
  [/^Subscribed to (?<rest>.+)$/su, "followed"],
  [/^Joined YouTube Premium$/u, null],
  [/^Joined (?<rest>.+)$/su, "followed"],
  [/^Disliked /u, null],
  [/^Rented /u, null],
  [/^Called /u, null],
  [/^Shared /u, null],
  [/^Used /u, null],
  [/^Explored on Google Maps$/u, null],
  [/^Ran internet speed test$/u, null],
  [/^Answered survey question$/u, null],
  [/^Dismissed /u, null],
  [/^Voted on /u, null],
  [/^Tracked flight prices$/u, null],
  [/^Defined /u, null],
  [/^\d+ notifications?$/u, null],
  [/^Google (?:automatically added|will now automatically add) /u, null],
  [/^Set Food Preferences$/u, null],
];

const classify = (product: string, record: Activity): readonly [Action, string] | undefined => {
  for (const [pattern, action, when] of rules) {
    const match =
      when === undefined || record.titleUrl === undefined ? pattern.exec(record.title) : null;

    if (match !== null) {
      return [action, match.groups?.["rest"] ?? record.title];
    }
  }

  const isOldMapsPlaceView = product === "Maps" && record.titleUrl !== undefined;

  return isOldMapsPlaceView ? ["viewed", record.title] : undefined;
};

const uploaderFields = (record: Activity): ThingFields => {
  const uploader = record.subtitles?.[0];
  const id = channelId(uploader?.url);

  return id === null ? {} : { author: uploader?.name ?? null, extra: { channel: id } };
};

const activityRows = function* activityRows(
  file: string,
  product: string,
  record: Activity,
  at: string,
): Generator<Row> {
  const [action, rest] =
    classify(product, record) ??
    fail(file, at, `no verb for title ${JSON.stringify(record.title)}`);

  if (action === null) {
    return;
  }

  const ts = utc(record.time, file, at);
  const { titleUrl } = record;

  const fields = {
    ts,
    text: record.description ?? null,
    extra:
      record.details === undefined
        ? { product }
        : { product, details: record.details.map((detail) => detail.name) },
  };

  const byUploader = uploaderFields(record);

  const linked = (target: Target | null): Target =>
    target ?? fail(file, at, `no thing to point ${JSON.stringify(record.title)} at`);

  const visited = () => (titleUrl === undefined ? null : page(titleUrl)) ?? page(rest);

  const repeat = (
    verb: "searched" | "visited" | "watched" | "viewed" | "navigated",
    target: Target,
  ) =>
    event({
      verb,
      thing: target.id,
      key: digest(ts, record.title, titleUrl ?? null, record.description ?? null),
      ...fields,
    });

  // oxlint-disable-next-line eslint/default-case -- the cases cover every non-null Action
  switch (action) {
    case "searched": {
      const query: Target = {
        id: `query:${rest.replaceAll(/\s+/gu, " ").trim().toLowerCase()}`,
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
      const target = linked(
        (titleUrl === undefined ? null : placeRef(titleUrl, rest)) ?? visited(),
      );

      yield put(target, { title: titleUnlessUrl(rest, target), ...byUploader });
      yield repeat("viewed", target);

      return;
    }

    case "navigated": {
      const target = linked(
        (titleUrl === undefined ? null : destinationRef(titleUrl, rest)) ?? visited(),
      );

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
      const target = linked(channel(titleUrl));

      yield put(target, { title: rest });
      yield happened("followed", target, fields);
    }
  }
};

const myActivity = async function* myActivity(dir: string): AsyncGenerator<Row> {
  const root = `${dir}/My Activity`;

  const files = existsSync(root)
    ? readdirSync(root)
        .map((product) => `${root}/${product}/MyActivity.json`)
        .filter((file) => existsSync(file))
        .toSorted()
    : [];

  for (const file of files) {
    const product = file.split("/").at(-2) ?? file;
    const activity = await json<readonly Activity[]>(file);

    for (const [i, record] of activity.entries()) {
      yield* activityRows(file, product, record, `record ${i + 1}`);
    }
  }
};

const csv = function* csv<Column extends string>(
  file: string,
  required: readonly Column[],
): Generator<readonly [Record<Column, string> & Record<string, string | undefined>, string]> {
  if (!existsSync(file)) {
    return;
  }

  const [header = [], ...body] = records(file);

  for (const [i, cells] of body.entries()) {
    if (cells.some((cell) => cell !== "")) {
      const at = `row ${i + 1}`;

      const row = Object.fromEntries(
        header.map((name, c) => [name, cells[c]?.replace(/^ (?=[-=+@])/u, "")]),
      );

      const missing = required.find((column) => row[column] === undefined);

      if (missing !== undefined) {
        fail(file, at, `no ${missing} column`);
      }

      // SAFETY: every required column was checked present just above.
      yield [row as Record<Column, string>, at];
    }
  }
};

const nonEmpty = (value: string): string | null => (value.trim() === "" ? null : value);

const savedLists = function* savedLists(dir: string): Generator<Row> {
  for (const file of listed(`${dir}/Saved`, /\.csv$/u)) {
    const list = path.basename(file, ".csv");

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
};

interface Feature<P> {
  readonly geometry: { readonly coordinates: readonly [number, number] };
  readonly properties: P;
}

interface Location {
  readonly name?: string;
  readonly address?: string;
}

const features = async function* features<P>(
  file: string,
): AsyncGenerator<readonly [Feature<P>, string]> {
  if (existsSync(file)) {
    const { features: all } = await json<{ features: readonly Feature<P>[] }>(file);

    for (const [i, feature] of all.entries()) {
      yield [feature, `features[${i}]`];
    }
  }
};

const latLngOfGeoJson = ([lng, lat]: readonly [number, number]): readonly [number, number] | null =>
  lng === 0 && lat === 0 ? null : [lat, lng];

const placeFields = (location: Location | undefined): ThingFields => ({
  title: location?.name ?? null,
  extra: location?.address === undefined ? {} : { address: location.address },
});

const places = async function* places(dir: string): AsyncGenerator<Row> {
  const saved = `${dir}/Maps (your places)/Saved Places.json`;
  const reviews = `${dir}/Maps (your places)/Reviews.json`;
  const labeled = `${dir}/Maps/My labeled places/Labeled places.json`;

  for await (const [{ geometry, properties }, at] of features<{
    date: string;
    google_maps_url: string;
    location?: Location;
  }>(saved)) {
    const name = properties.location?.name ?? properties.google_maps_url;
    const point = latLngOfGeoJson(geometry.coordinates);

    const target =
      placeRef(properties.google_maps_url, name) ??
      (point === null ? null : placeAt(name, point, properties.google_maps_url)) ??
      fail(saved, at, `no place for ${JSON.stringify(name)}`);

    yield put(target, placeFields(properties.location));
    yield happened("saved", target, {
      ts: utc(properties.date, saved, at),
      collections: ["Saved Places"],
    });
  }

  for await (const [{ properties }, at] of features<{
    date: string;
    google_maps_url: string;
    location: Location;
    five_star_rating_published?: number;
    review_text_published?: string;
  }>(reviews)) {
    const name = properties.location.name ?? properties.google_maps_url;

    const target =
      placeRef(properties.google_maps_url, name) ??
      fail(reviews, at, `no place for ${JSON.stringify(name)}`);

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

  for await (const [{ geometry, properties }, at] of features<{ name: string; address?: string }>(
    labeled,
  )) {
    const name = properties.address ?? properties.name;

    const point =
      latLngOfGeoJson(geometry.coordinates) ??
      fail(labeled, at, `no place for ${JSON.stringify(name)}`);

    const target = placeAt(name, point, null);

    yield put(target, { title: name });
    yield happened("saved", target, {
      ts: null,
      text: properties.name,
      collections: ["Labeled places"],
    });
  }
};

const youtube = function* youtube(dir: string): Generator<Row> {
  const root = `${dir}/YouTube and YouTube Music`;

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

  for (const file of listed(`${root}/playlists`, /-videos\.csv$/u)) {
    const playlist = path.basename(file, "-videos.csv");

    for (const [row, at] of csv(file, ["Video ID", "Playlist Video Creation Timestamp"])) {
      const target = video(row["Video ID"]);

      yield put(target, {});
      yield happened("saved", target, {
        ts: utc(row["Playlist Video Creation Timestamp"], file, at),
        collections: [playlist],
      });
    }
  }

  for (const file of listed(`${root}/comments`, /\.csv$/u)) {
    for (const [row, at] of csv(file, [
      "Comment ID",
      "Comment Create Timestamp",
      "Video ID",
      "Comment Text",
    ])) {
      const ts = utc(row["Comment Create Timestamp"], file, at);

      // SAFETY: Takeout writes a comment's text as comma-separated `{"text": …}` JSON objects.
      const segments = JSON.parse(`[${row["Comment Text"]}]`) as readonly { text?: string }[];

      const post = row["Post ID"] ?? "";
      const postPage = post === "" ? null : page(`https://www.youtube.com/post/${post}`);

      const on =
        (row["Video ID"] === "" ? postPage : video(row["Video ID"])) ??
        fail(file, at, "comment on neither a video nor a post");

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
};

export default defineSource({
  name: "takeout",
  async *rows({ dir }) {
    const root = existsSync(`${dir}/Takeout`) ? `${dir}/Takeout` : dir;

    yield* myActivity(root);
    yield* savedLists(root);
    yield* places(root);
    yield* youtube(root);
  },
});
