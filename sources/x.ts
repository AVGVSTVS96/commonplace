import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { event, iso, link, type Row, thing, urlRef } from "../src/schema.ts";
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
        readonly entity_set?: { readonly urls?: ReadonlyArray<Url> };
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
    readonly entities?: { readonly urls?: ReadonlyArray<Url> };
    readonly extended_entities?: { readonly media?: ReadonlyArray<unknown> };
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
  readonly items?: ReadonlyArray<{ readonly item: { readonly itemContent?: Content["itemContent"] } }>;
}

interface Entry {
  readonly entryId: string;
  readonly content: Content;
}

interface Instruction {
  readonly type: string;
  readonly entries?: ReadonlyArray<Entry>;
  readonly entry?: Entry;
}

interface Instructions {
  readonly timeline?: { readonly instructions?: ReadonlyArray<Instruction> };
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
            readonly items: ReadonlyArray<{ readonly id: string; readonly name: string }>;
          };
        };
      };
    };
  };
}

interface Viewer {
  readonly id: string;
}

/** Posts with reply limits or other visibility rules come wrapped one level deeper. */
const unwrap = (tweet: Tweet | undefined): Tweet | undefined => tweet?.tweet ?? tweet;

const instructionsOf = (timeline: Timeline): ReadonlyArray<Instruction> =>
  (
    timeline.data?.bookmark_timeline_v2 ??
    timeline.data?.bookmark_collection_timeline ??
    timeline.data?.user?.result?.timeline_v2 ??
    timeline.data?.user?.result?.timeline
  )?.timeline?.instructions ?? [];

/** Every entry of a page, the pinned post's too. */
const entriesOf = (timeline: Timeline): ReadonlyArray<Entry> =>
  instructionsOf(timeline).flatMap(
    (instruction) => instruction.entries ?? (instruction.entry === undefined ? [] : [instruction.entry]),
  );

const tweetsOf = (entry: Entry): ReadonlyArray<Tweet> =>
  (entry.content.items?.map(({ item }) => item.itemContent) ?? [entry.content.itemContent]).flatMap(
    (item) => {
      const tweet = unwrap(item?.tweet_results?.result);

      return tweet?.rest_id === undefined ? [] : [tweet];
    },
  );

/** The posts a page added: a pinned post comes in its own instruction, so it never looks like where you left off. */
const idsOf = (timeline: Timeline): ReadonlyArray<string> =>
  instructionsOf(timeline)
    .flatMap((instruction) => (instruction.type === "TimelineAddEntries" ? (instruction.entries ?? []) : []))
    .flatMap((entry) => tweetsOf(entry).map((tweet) => tweet.rest_id ?? ""));

const extraOf = (tweet: Tweet, author: User | undefined) => ({
  author_name: author?.core?.name ?? author?.legacy?.name ?? null,
  conversation_id: tweet.legacy?.conversation_id_str ?? null,
  media: (tweet.legacy?.extended_entities?.media ?? null) as never,
  metrics: {
    likes: tweet.legacy?.favorite_count ?? null,
    replies: tweet.legacy?.reply_count ?? null,
    retweets: tweet.legacy?.retweet_count ?? null,
    quotes: tweet.legacy?.quote_count ?? null,
    bookmarks: tweet.legacy?.bookmark_count ?? null,
    impressions: tweet.views?.count === undefined ? null : Number(tweet.views.count),
  },
});

function* postRows(tweet: Tweet): Generator<Row> {
  const id = `x:tweet:${tweet.rest_id}`;
  const author = tweet.core?.user_results?.result;
  const handle = author?.core?.screen_name ?? author?.legacy?.screen_name ?? null;
  const note = tweet.note_tweet?.note_tweet_results?.result;
  const quoted = unwrap(tweet.quoted_status_result?.result);

  yield thing({
    id,
    kind: "tweet",
    text: note?.text ?? tweet.legacy?.full_text ?? null,
    url: handle === null ? null : `https://x.com/${handle}/status/${tweet.rest_id}`,
    author: handle,
    created_at: iso(tweet.legacy?.created_at),
    extra: extraOf(tweet, author),
  });

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
  for (const url of [...(note?.entity_set?.urls ?? []), ...(tweet.legacy?.entities?.urls ?? [])]) {
    const href = url.expanded_url ?? url.url;
    const target = urlRef(href);

    if (target !== null && !related.has(target.id)) {
      if (target.kind !== "tweet") {
        yield thing({ ...target, url: href });
      }
      yield link(id, "mentions", target.id);
    }
  }
}

interface Operation {
  readonly queryId: string;
  readonly features: ReadonlyArray<string>;
  readonly toggles: ReadonlyArray<string>;
}

const operation =
  /queryId:"([^"]+)",operationName:"(\w+)",operationType:"\w+",metadata:\{featureSwitches:\[([^\]]*)\],fieldToggles:\[([^\]]*)\]/g;
const strings = (list: string) => Array.from(list.matchAll(/"([^"]+)"/g), (match) => match[1] ?? "");
const bundles = "https://abs.twimg.com/responsive-web/client-web/";

/** Every GraphQL operation in x.com's current bundles and the web app's bearer token, so nothing goes stale. */
const discover = async (html: string) => {
  const chunks = (pattern: RegExp) =>
    new Map(Array.from(html.matchAll(pattern), ([, id, value]) => [id, value]));
  const names = chunks(/(\d+):"((?:bundle|ondemand|loader|shared~|vendor)[^"]*)"/g);
  const hashes = chunks(/(\d+):"([0-9a-f]{16})"/g);
  const main = /client-web\/(main\.[0-9a-f]+\.js)/.exec(html)?.[1];

  if (main === undefined) {
    throw new Error("x: x.com's page names no main bundle, so X has changed how it loads");
  }

  const queue = Array.from(names, ([id, name]) =>
    hashes.has(id) ? `${name}.${hashes.get(id)}a.js` : "",
  ).filter((file) => file !== "");
  const code = [await (await fetch(bundles + main)).text()];
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
        code.push(await (await fetch(bundles + file)).text());
      }
    }),
  );

  return {
    bearer: /AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]+/.exec(code[0] ?? "")?.[0],
    operations: new Map<string, Operation>(
      code.flatMap((js) =>
        Array.from(js.matchAll(operation), ([, queryId = "", name = "", features = "", toggles = ""]) => [
          name,
          { queryId, features: strings(features), toggles: strings(toggles) },
        ]),
      ),
    ),
  };
};

const agentBrowser = (args: ReadonlyArray<string>, env: Record<string, string | undefined> = process.env) => {
  const run = Bun.spawnSync(["agent-browser", ...args], { env });

  if (run.exitCode !== 0) {
    throw new Error(`x: agent-browser ${args.join(" ").slice(0, 80)}: ${run.stderr.toString().trim()}`);
  }

  return run.stdout.toString();
};

const evaluate = (
  session: ReadonlyArray<string>,
  js: string,
  env?: Record<string, string | undefined>,
): any => {
  const out = JSON.parse(
    agentBrowser([...session, "eval", "--json", "-b", Buffer.from(js).toString("base64")], env),
  );

  if (out.success !== true) {
    throw new Error(`x: ${out.error}`);
  }

  return out.data.result;
};

/** Chrome's own user agent without "Headless", which X turns away, read from a throwaway browser. */
const userAgent = (): string => {
  const probe = ["--session", "commonplace-user-agent"];
  agentBrowser([...probe, "open", "about:blank"]);

  try {
    return String(evaluate(probe, "navigator.userAgent")).replace("HeadlessChrome", "Chrome");
  } finally {
    agentBrowser([...probe, "close"]);
  }
};

export interface XOptions {
  /** The agent-browser session that's signed in to X. */
  readonly session?: string;
}

/**
 * Your X bookmarks with their folders, likes, posts and replies, read the way x.com's own web app reads them:
 * GraphQL requests sent from inside agent-browser's signed-in session on this machine. Each run keeps the pages
 * as they came and stops at a post the last run already had.
 */
export const x = ({ session = "x" }: XOptions = {}) => {
  const signin = `agent-browser --session ${session} --restore --headed open https://x.com/login`;

  return defineSource({
    name: "x",

    fetch: async ({ dir, since, state }) => {
      if (Bun.which("agent-browser") === null) {
        throw new Error("x: needs agent-browser (npm i -g agent-browser && agent-browser install)");
      }

      const signedIn = ["--session", session, "--restore"];
      const env = { ...process.env, AGENT_BROWSER_USER_AGENT: userAgent() };

      try {
        agentBrowser([...signedIn, "open", "https://x.com/i/bookmarks"], env);
        const { cookie, html } = evaluate(
          signedIn,
          "({ cookie: document.cookie, html: document.documentElement.outerHTML })",
          env,
        );
        const viewer = /(?:^|; )twid=u%3D(\d+)/.exec(cookie)?.[1];

        if (viewer === undefined) {
          throw new Error(`x: the agent-browser session isn't signed in to X. Sign in once with: ${signin}`);
        }

        const { bearer, operations } = await discover(html);

        const graphql = async (name: string, variables: Record<string, unknown>): Promise<string> => {
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
          const { status, remaining, reset, retryAfter, body } = evaluate(
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

            return graphql(name, variables);
          }
          if (status !== 200) {
            throw new Error(`x ${name} ${status}: ${body.slice(0, 300)}`);
          }

          const { errors } = JSON.parse(body);

          if (errors?.length > 0) {
            throw new Error(`x ${name}: ${JSON.stringify(errors).slice(0, 300)}`);
          }
          if (remaining === 0) {
            console.error(`x ${name}: out of requests until ${new Date(reset * 1000).toISOString()}`);
            await Bun.sleep(reset * 1000 - Date.now());
          }

          return body;
        };

        const heads = `${state}/heads.json`;
        const known: Record<string, ReadonlyArray<string>> = since !== null && existsSync(heads)
          ? JSON.parse(readFileSync(heads, "utf8"))
          : {};
        const next: Record<string, ReadonlyArray<string>> = {};

        /** Follows the Bottom cursor until a page brings nothing new or holds a post the last run had. */
        const save = async (file: string, name: string, variables: Record<string, unknown>) => {
          const last = new Set(known[file] ?? []);
          const pages: Array<string> = [];
          const seen = new Set<string>();

          for (let cursor: string | undefined; ;) {
            const page = await graphql(name, { ...variables, cursor });
            const timeline = JSON.parse(page) as Timeline;
            const entries = entriesOf(timeline);
            const fresh = entries.filter(
              (e) => e.content.entryType !== "TimelineTimelineCursor" && !seen.has(e.entryId),
            );

            pages.push(page);
            fresh.forEach((entry) => seen.add(entry.entryId));
            cursor = entries.find((entry) => entry.content.cursorType === "Bottom")?.content.value;

            if (fresh.length === 0 || cursor === undefined || idsOf(timeline).some((id) => last.has(id))) {
              break;
            }
          }

          const ids = pages.flatMap((page) => idsOf(JSON.parse(page) as Timeline));
          next[file] = ids.length > 0 ? ids.slice(0, 20) : [...last];
          writeFileSync(`${dir}/${file}.jsonl`, pages.map((page) => `${page}\n`).join(""));
        };

        writeFileSync(`${dir}/viewer.json`, JSON.stringify({ id: viewer } satisfies Viewer));
        await save("bookmarks", "Bookmarks", { count: 100, includePromotedContent: true });

        const folders = await graphql("BookmarkFoldersSlice", {});
        writeFileSync(`${dir}/folders.json`, folders);
        mkdirSync(`${dir}/folders`);
        for (const { id } of (JSON.parse(folders) as Folders).data.viewer.user_results.result
          .bookmark_collections_slice.items) {
          await save(`folders/${id}`, "BookmarkFolderTimeline", {
            bookmark_collection_id: id,
            includePromotedContent: true,
          });
        }

        const profile = { userId: viewer, count: 100, includePromotedContent: false, withVoice: true };
        await save("likes", "Likes", { ...profile, withClientEventToken: false, withBirdwatchNotes: false });
        await save("posts", "UserTweets", { ...profile, withQuickPromoteEligibilityTweetFields: true });
        await save("replies", "UserRepliesTimeline", { ...profile, withCommunity: true });

        mkdirSync(state, { recursive: true });
        writeFileSync(heads, JSON.stringify(next));
      } finally {
        agentBrowser([...signedIn, "close"], env);
      }
    },

    rows: async function* ({ dir }) {
      const viewer = await json<Viewer>(`${dir}/viewer.json`);
      const folders = existsSync(`${dir}/folders.json`)
        ? (await json<Folders>(`${dir}/folders.json`)).data.viewer.user_results.result
            .bookmark_collections_slice.items
        : [];
      const files = [
        { file: "bookmarks", collections: ["x bookmarks"] },
        ...folders.map(({ id, name }) => ({ file: `folders/${id}`, collections: ["x bookmarks", name] })),
        { file: "likes", collections: [] },
        { file: "posts", collections: [] },
        { file: "replies", collections: [] },
      ];

      for (const { file, collections } of files) {
        for await (const line of existsSync(`${dir}/${file}.jsonl`) ? lines(`${dir}/${file}.jsonl`) : []) {
          for (const entry of entriesOf(JSON.parse(line) as Timeline)) {
            for (const tweet of tweetsOf(entry)) {
              const id = `x:tweet:${tweet.rest_id}`;
              const mine = tweet.core?.user_results?.result?.rest_id === viewer.id;

              if ((file === "posts" || file === "replies") && !mine) {
                continue;
              }
              yield* postRows(tweet);
              yield file === "likes"
                ? event({ verb: "liked", thing: id })
                : file === "posts" || file === "replies"
                  ? event({ verb: "posted", thing: id, ts: iso(tweet.legacy?.created_at) })
                  : event({ verb: "saved", thing: id, collections });
            }
          }
        }
      }
    },
  });
};
