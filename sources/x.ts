import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { event, iso, link, thing, urlRef } from "../src/schema.ts";
import type { Json, Row } from "../src/schema.ts";
import { defineSource, json, lines } from "../src/source.ts";

interface User {
  readonly rest_id: string;
  readonly core?: { readonly screen_name?: string; readonly name?: string };
  readonly legacy?: { readonly screen_name?: string; readonly name?: string };
}

interface Url {
  readonly expanded_url?: string;
  readonly url: string;
}

interface Tweet {
  readonly rest_id?: string;
  readonly tweet?: Tweet;
  readonly core?: { readonly user_results?: { readonly result?: User } };
  readonly note_tweet?: {
    readonly note_tweet_results?: {
      readonly result?: {
        readonly text?: string;
        readonly entity_set?: { readonly urls?: readonly Url[] };
      };
    };
  };
  readonly quoted_status_result?: { readonly result?: Tweet };
  readonly views?: { readonly count?: string };
  readonly legacy?: {
    readonly full_text: string;
    readonly created_at: string;
    readonly conversation_id_str?: string;
    readonly in_reply_to_status_id_str?: string;
    readonly retweeted_status_result?: { readonly result?: Tweet };
    readonly entities?: { readonly urls?: readonly Url[] };
    readonly extended_entities?: { readonly media?: Json[] };
    readonly favorite_count?: number;
    readonly reply_count?: number;
    readonly retweet_count?: number;
    readonly quote_count?: number;
    readonly bookmark_count?: number;
  };
}

interface Content {
  readonly entryType?: string;
  readonly cursorType?: string;
  readonly value?: string;
  readonly itemContent?: { readonly tweet_results?: { readonly result?: Tweet } };
  readonly items?: readonly { readonly item: { readonly itemContent?: Content["itemContent"] } }[];
}

interface Entry {
  readonly entryId: string;
  readonly content: Content;
}

interface Instruction {
  readonly type: string;
  readonly entries?: readonly Entry[];
  readonly entry?: Entry;
}

interface Instructions {
  readonly timeline?: { readonly instructions?: readonly Instruction[] };
}

interface Timeline {
  readonly data?: {
    readonly bookmark_timeline_v2?: Instructions;
    readonly bookmark_collection_timeline?: Instructions;
    readonly user?: {
      readonly result?: { readonly timeline?: Instructions; readonly timeline_v2?: Instructions };
    };
  };
}

interface Folders {
  readonly data: {
    readonly viewer: {
      readonly user_results: {
        readonly result: {
          readonly bookmark_collections_slice: {
            readonly items: readonly { readonly id: string; readonly name: string }[];
          };
        };
      };
    };
  };
}

interface Viewer {
  readonly id: string;
}

type Heads = Record<string, readonly string[]>;

type Variables = Record<string, Json | undefined>;

interface RateLimited {
  readonly status: number;
  readonly remaining: number;
  readonly reset: number;
  readonly retryAfter: number;
  readonly body: string;
}

const unwrap = (tweet: Tweet | undefined): Tweet | undefined => tweet?.tweet ?? tweet;

const instructionsOf = (timeline: Timeline): readonly Instruction[] =>
  (
    timeline.data?.bookmark_timeline_v2 ??
    timeline.data?.bookmark_collection_timeline ??
    timeline.data?.user?.result?.timeline_v2 ??
    timeline.data?.user?.result?.timeline
  )?.timeline?.instructions ?? [];

const entriesOf = (timeline: Timeline): readonly Entry[] =>
  instructionsOf(timeline).flatMap(
    (instruction) =>
      instruction.entries ?? (instruction.entry === undefined ? [] : [instruction.entry]),
  );

const tweetsOf = (entry: Entry): readonly Tweet[] =>
  (entry.content.items?.map(({ item }) => item.itemContent) ?? [entry.content.itemContent]).flatMap(
    (item) => {
      const tweet = unwrap(item?.tweet_results?.result);

      return tweet?.rest_id === undefined ? [] : [tweet];
    },
  );

const addedIdsOf = (timeline: Timeline): readonly string[] =>
  instructionsOf(timeline)
    .flatMap((instruction) =>
      instruction.type === "TimelineAddEntries" ? (instruction.entries ?? []) : [],
    )
    .flatMap((entry) => tweetsOf(entry).map((tweet) => tweet.rest_id ?? ""));

const metricsOf = ({ legacy, views }: Tweet) => ({
  likes: legacy?.favorite_count ?? null,
  replies: legacy?.reply_count ?? null,
  retweets: legacy?.retweet_count ?? null,
  quotes: legacy?.quote_count ?? null,
  bookmarks: legacy?.bookmark_count ?? null,
  impressions: views?.count === undefined ? null : Number(views.count),
});

const namesOf = (user: User | undefined) => ({
  handle: user?.core?.screen_name ?? user?.legacy?.screen_name ?? null,
  name: user?.core?.name ?? user?.legacy?.name ?? null,
});

const urlsOf = ({ note_tweet, legacy }: Tweet): readonly Url[] => [
  ...(note_tweet?.note_tweet_results?.result?.entity_set?.urls ?? []),
  ...(legacy?.entities?.urls ?? []),
];

const tweetThing = (tweet: Tweet): Row => {
  const { handle, name } = namesOf(tweet.core?.user_results?.result);

  return thing({
    id: `x:tweet:${tweet.rest_id}`,
    kind: "tweet",
    text: tweet.note_tweet?.note_tweet_results?.result?.text ?? tweet.legacy?.full_text ?? null,
    url: handle === null ? null : `https://x.com/${handle}/status/${tweet.rest_id}`,
    author: handle,
    created_at: iso(tweet.legacy?.created_at),
    extra: {
      author_name: name,
      conversation_id: tweet.legacy?.conversation_id_str ?? null,
      media: tweet.legacy?.extended_entities?.media ?? null,
      metrics: metricsOf(tweet),
    },
  });
};

const postRows = function* postRows(tweet: Tweet): Generator<Row> {
  const id = `x:tweet:${tweet.rest_id}`;
  const quoted = unwrap(tweet.quoted_status_result?.result);

  yield tweetThing(tweet);

  const original = unwrap(tweet.legacy?.retweeted_status_result?.result);
  const related = new Set([id]);

  if (tweet.legacy?.in_reply_to_status_id_str !== undefined) {
    related.add(`x:tweet:${tweet.legacy.in_reply_to_status_id_str}`);
    yield link(id, "replies_to", `x:tweet:${tweet.legacy.in_reply_to_status_id_str}`);
  }

  for (const [rel, other] of [
    ["quotes", quoted],
    ["reposts", original],
  ] as const) {
    if (other?.rest_id !== undefined) {
      related.add(`x:tweet:${other.rest_id}`);
      yield* postRows(other);
      yield link(id, rel, `x:tweet:${other.rest_id}`);
    }
  }

  for (const url of urlsOf(tweet)) {
    const href = url.expanded_url ?? url.url;
    const target = urlRef(href);

    if (target !== null && !related.has(target.id)) {
      if (target.kind !== "tweet") {
        yield thing({ ...target, url: href });
      }

      yield link(id, "mentions", target.id);
    }
  }
};

interface Operation {
  readonly queryId: string;
  readonly features: readonly string[];
  readonly toggles: readonly string[];
}

const operation =
  /queryId:"(?<queryId>[^"]+)",operationName:"(?<name>\w+)",operationType:"\w+",metadata:\{featureSwitches:\[(?<features>[^\]]*)\],fieldToggles:\[(?<toggles>[^\]]*)\]/gu;

const strings = (list: string) =>
  Array.from(list.matchAll(/"[^"]+"/gu), ([quoted]) => quoted.slice(1, -1));

const bundles = "https://abs.twimg.com/responsive-web/client-web/";

const bundle = async (file: string): Promise<string> => {
  const response = await fetch(bundles + file);

  return await response.text();
};

const discover = async (html: string) => {
  const chunks = (pattern: RegExp) =>
    new Map(
      Array.from(html.matchAll(pattern), ({ groups }) => [groups?.["id"], groups?.["value"]]),
    );

  const names = chunks(/(?<id>\d+):"(?<value>(?:bundle|ondemand|loader|shared~|vendor)[^"]*)"/gu);
  const hashes = chunks(/(?<id>\d+):"(?<value>[0-9a-f]{16})"/gu);
  const main = /client-web\/(?<main>main\.[0-9a-f]+\.js)/u.exec(html)?.groups?.["main"];

  if (main === undefined) {
    throw new Error("x: x.com's page names no main bundle, so X has changed how it loads");
  }

  const queue = Array.from(names, ([id, name]) =>
    hashes.has(id) ? `${name}.${hashes.get(id)}a.js` : "",
  ).filter((file) => file !== "");

  const code = [await bundle(main)];

  await Promise.all(
    Array.from({ length: 16 }, async () => {
      for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
        code.push(await bundle(file));
      }
    }),
  );

  return {
    bearer: /AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]+/u.exec(code[0] ?? "")?.[0],
    operations: new Map<string, Operation>(
      code.flatMap((js) =>
        Array.from(
          js.matchAll(operation),
          ({ groups: { queryId = "", name = "", features = "", toggles = "" } = {} }) => [
            name,
            { queryId, features: strings(features), toggles: strings(toggles) },
          ],
        ),
      ),
    ),
  };
};

const agentBrowser = (
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
) => {
  const run = Bun.spawnSync(["agent-browser", ...args], { env });

  if (run.exitCode !== 0) {
    throw new Error(
      `x: agent-browser ${args.join(" ").slice(0, 80)}: ${run.stderr.toString().trim()}`,
    );
  }

  return run.stdout.toString();
};

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names the JSON it expects, so this one assertion serves every read
const parsed = <T>(text: string): T => {
  const value: unknown = JSON.parse(text);

  // SAFETY: x.com or agent-browser sent this text, or this source's own fetch wrote it.
  return value as T;
};

interface Evaluated<T> {
  readonly success: boolean;
  readonly error?: string;
  readonly data: { readonly result: T };
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names what its script returns
const evaluate = <T>(
  session: readonly string[],
  js: string,
  env?: Record<string, string | undefined>,
): T => {
  const out = parsed<Evaluated<T>>(
    agentBrowser([...session, "eval", "--json", "-b", Buffer.from(js).toString("base64")], env),
  );

  if (!out.success) {
    throw new Error(`x: ${out.error}`);
  }

  return out.data.result;
};

const headedUserAgent = (): string => {
  const probe = ["--session", "commonplace-user-agent"];
  agentBrowser([...probe, "open", "about:blank"]);

  try {
    return evaluate<string>(probe, "navigator.userAgent").replace("HeadlessChrome", "Chrome");
  } finally {
    agentBrowser([...probe, "close"]);
  }
};

export interface XOptions {
  readonly session?: string;
}

export const x = ({ session = "x" }: XOptions = {}) => {
  const signin = `agent-browser --session ${session} --restore --headed open https://x.com/login`;

  return defineSource({
    name: "x",

    fetch: async ({ dir, since, state }) => {
      if (Bun.which("agent-browser") === null) {
        throw new Error("x: needs agent-browser (npm i -g agent-browser && agent-browser install)");
      }

      const signedIn = ["--session", session, "--restore"];
      const env = { ...process.env, AGENT_BROWSER_USER_AGENT: headedUserAgent() };

      try {
        agentBrowser([...signedIn, "open", "https://x.com/i/bookmarks"], env);

        const { cookie, html } = evaluate<{ cookie: string; html: string }>(
          signedIn,
          "({ cookie: document.cookie, html: document.documentElement.outerHTML })",
          env,
        );

        const viewer = /(?:^|; )twid=u%3D(?<id>\d+)/u.exec(cookie)?.groups?.["id"];

        if (viewer === undefined) {
          throw new Error(
            `x: the agent-browser session isn't signed in to X. Sign in once with: ${signin}`,
          );
        }

        const { bearer, operations } = await discover(html);

        const graphql = async (name: string, variables: Variables): Promise<string> => {
          const op = operations.get(name);

          if (op === undefined) {
            throw new Error(`x: x.com's bundles no longer have a ${name} operation`);
          }

          const params = new URLSearchParams({
            variables: JSON.stringify(variables),
            features: JSON.stringify(Object.fromEntries(op.features.map((key) => [key, true]))),
            fieldToggles: JSON.stringify(Object.fromEntries(op.toggles.map((key) => [key, false]))),
          });

          const request = {
            url: `https://x.com/i/api/graphql/${op.queryId}/${name}?${params.toString()}`,
            bearer,
          };

          const { status, remaining, reset, retryAfter, body } = evaluate<RateLimited>(
            signedIn,
            `(async ({ url, bearer }) => {
              const csrf = document.cookie.match(/(?:^|; )ct0=([^;]+)/)?.[1];
              const res = await fetch(url, { headers: {
                authorization: "Bearer " + bearer, "x-csrf-token": csrf,
                "x-twitter-active-user": "yes", "x-twitter-auth-type": "OAuth2Session",
              } });
              const header = (name) => Number(res.headers.get(name) ?? NaN);
              return { status: res.status, remaining: header("x-rate-limit-remaining"),
                reset: header("x-rate-limit-reset"), retryAfter: header("retry-after"), body: await res.text() };
            })(${JSON.stringify(request)})`,
            env,
          );

          const until = Number.isFinite(retryAfter) ? Date.now() + retryAfter * 1000 : reset * 1000;

          if (status === 429 && Number.isFinite(until)) {
            console.error(`x ${name}: rate limited until ${new Date(until).toISOString()}`);
            await Bun.sleep(until - Date.now());

            return await graphql(name, variables);
          }

          if (status !== 200) {
            throw new Error(`x ${name} ${status}: ${body.slice(0, 300)}`);
          }

          const { errors } = parsed<{ errors?: Json[] }>(body);

          if (errors !== undefined && errors.length > 0) {
            throw new Error(`x ${name}: ${JSON.stringify(errors).slice(0, 300)}`);
          }

          if (remaining === 0) {
            console.error(
              `x ${name}: out of requests until ${new Date(reset * 1000).toISOString()}`,
            );
            await Bun.sleep(reset * 1000 - Date.now());
          }

          return body;
        };

        const heads = `${state}/heads.json`;

        const known: Heads =
          since !== null && existsSync(heads) ? parsed<Heads>(readFileSync(heads, "utf-8")) : {};

        const next: Heads = {};

        const save = async (file: string, name: string, variables: Variables) => {
          const last = new Set(known[file]);
          const pages: string[] = [];
          const seen = new Set<string>();

          for (let cursor: string | undefined; ;) {
            const page = await graphql(name, { ...variables, cursor });
            const timeline = parsed<Timeline>(page);
            const entries = entriesOf(timeline);

            const fresh = entries.filter(
              (e) => e.content.entryType !== "TimelineTimelineCursor" && !seen.has(e.entryId),
            );

            pages.push(page);

            for (const entry of fresh) {
              seen.add(entry.entryId);
            }

            cursor = entries.find((entry) => entry.content.cursorType === "Bottom")?.content.value;

            if (
              fresh.length === 0 ||
              cursor === undefined ||
              addedIdsOf(timeline).some((id) => last.has(id))
            ) {
              break;
            }
          }

          const ids = pages.flatMap((page) => addedIdsOf(parsed<Timeline>(page)));
          next[file] = ids.length > 0 ? ids.slice(0, 20) : [...last];
          writeFileSync(`${dir}/${file}.jsonl`, pages.map((page) => `${page}\n`).join(""));
        };

        writeFileSync(`${dir}/viewer.json`, JSON.stringify({ id: viewer } satisfies Viewer));
        await save("bookmarks", "Bookmarks", { count: 100, includePromotedContent: true });

        const folders = await graphql("BookmarkFoldersSlice", {});
        writeFileSync(`${dir}/folders.json`, folders);
        mkdirSync(`${dir}/folders`);

        for (const { id } of parsed<Folders>(folders).data.viewer.user_results.result
          .bookmark_collections_slice.items) {
          await save(`folders/${id}`, "BookmarkFolderTimeline", {
            bookmark_collection_id: id,
            includePromotedContent: true,
          });
        }

        const profile = {
          userId: viewer,
          count: 100,
          includePromotedContent: false,
          withVoice: true,
        };

        await save("likes", "Likes", {
          ...profile,
          withClientEventToken: false,
          withBirdwatchNotes: false,
        });
        await save("posts", "UserTweets", {
          ...profile,
          withQuickPromoteEligibilityTweetFields: true,
        });
        await save("replies", "UserRepliesTimeline", { ...profile, withCommunity: true });

        mkdirSync(state, { recursive: true });
        writeFileSync(heads, JSON.stringify(next));
      } finally {
        agentBrowser([...signedIn, "close"], env);
      }
    },

    async *rows({ dir }) {
      const viewer = await json<Viewer>(`${dir}/viewer.json`);

      const folders = existsSync(`${dir}/folders.json`)
        ? await json<Folders>(`${dir}/folders.json`)
        : null;

      const files: readonly {
        file: string;
        verb: "saved" | "liked" | "posted";
        collections: string[];
      }[] = [
        { file: "bookmarks", verb: "saved", collections: ["x bookmarks"] },
        ...(folders?.data.viewer.user_results.result.bookmark_collections_slice.items ?? []).map(
          ({ id, name }) => ({
            file: `folders/${id}`,
            verb: "saved" as const,
            collections: ["x bookmarks", name],
          }),
        ),
        { file: "likes", verb: "liked", collections: [] },
        { file: "posts", verb: "posted", collections: [] },
        { file: "replies", verb: "posted", collections: [] },
      ];

      for (const { file, verb, collections } of files) {
        for await (const line of existsSync(`${dir}/${file}.jsonl`)
          ? lines(`${dir}/${file}.jsonl`)
          : []) {
          for (const entry of entriesOf(parsed<Timeline>(line))) {
            for (const tweet of tweetsOf(entry)) {
              const id = `x:tweet:${tweet.rest_id}`;
              const mine = tweet.core?.user_results?.result?.rest_id === viewer.id;

              if (verb === "posted" && !mine) {
                continue;
              }

              yield* postRows(tweet);
              yield event({
                verb,
                thing: id,
                ts: verb === "posted" ? iso(tweet.legacy?.created_at) : null,
                collections,
              });
            }
          }
        }
      }
    },
  });
};
