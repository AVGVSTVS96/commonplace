import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { type Computer, local, type Provider, site } from "../src/computer.ts";
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
}

interface Timeline {
  readonly data?: {
    readonly bookmark_timeline_v2?: {
      readonly timeline?: { readonly instructions?: ReadonlyArray<Instruction> };
    };
    readonly user?: {
      readonly result?: {
        readonly timeline?: { readonly timeline?: { readonly instructions?: ReadonlyArray<Instruction> } };
        readonly timeline_v2?: { readonly timeline?: { readonly instructions?: ReadonlyArray<Instruction> } };
      };
    };
  };
}

interface Viewer {
  readonly id: string;
  readonly handle: string;
}

const timelines = [
  { file: "bookmarks", operation: "Bookmarks", path: () => "i/bookmarks" },
  { file: "likes", operation: "Likes", path: (handle: string) => `${handle}/likes` },
  { file: "posts", operation: "UserOriginalsTimeline", path: (handle: string) => handle },
  { file: "replies", operation: "UserRepliesTimeline", path: (handle: string) => `${handle}/with_replies` },
] as const;

/** Posts with reply limits or other visibility rules come wrapped one level deeper. */
const unwrap = (tweet: Tweet | undefined): Tweet | undefined => tweet?.tweet ?? tweet;

/** New entries only: a pinned post comes in its own instruction, so it never looks like where you left off. */
const entriesOf = (timeline: Timeline): ReadonlyArray<Entry> => {
  const root =
    timeline.data?.bookmark_timeline_v2 ??
    timeline.data?.user?.result?.timeline_v2 ??
    timeline.data?.user?.result?.timeline;

  return (root?.timeline?.instructions ?? []).flatMap((instruction) =>
    instruction.type === "TimelineAddEntries" ? (instruction.entries ?? []) : [],
  );
};

const tweetsOf = (entry: Entry): ReadonlyArray<Tweet> =>
  (entry.content.items?.map(({ item }) => item.itemContent) ?? [entry.content.itemContent]).flatMap(
    (item) => {
      const tweet = unwrap(item?.tweet_results?.result);

      return tweet?.rest_id === undefined ? [] : [tweet];
    },
  );

const idsOf = (timeline: Timeline): ReadonlyArray<string> =>
  entriesOf(timeline).flatMap((entry) => tweetsOf(entry).map((tweet) => tweet.rest_id ?? ""));

const pause = () => Bun.sleep(700 + Math.random() * 900);

/**
 * Opens one timeline and scrolls it like a person, keeping every response the page loads,
 * until it reaches a post from the last run or the end.
 */
const scroll = async (computer: Computer, path: string, operation: string, known: ReadonlySet<string>) => {
  const match = new RegExp(`/i/api/graphql/[\\w-]+/${operation}\\?`);
  const { responses, stop } = computer.capture(match);
  const loading = new Set<string>();
  let asked = 0;
  let finished = 0;
  const offs = [
    computer.on("Network.requestWillBeSent", ({ requestId, request }) => {
      if (match.test(request.url)) {
        asked += 1;
        loading.add(requestId);
      }
    }),
    computer.on("Network.loadingFinished", ({ requestId }) => {
      finished += loading.delete(requestId) ? 1 : 0;
    }),
    computer.on("Network.loadingFailed", ({ requestId }) => {
      loading.delete(requestId);
    }),
  ];
  const first = computer.next(match);
  await computer.goto(`https://x.com/${path}`);
  if (asked === 0) {
    throw new Error(`x: x.com/${path} loaded without asking for ${operation}, so X has changed the page`);
  }
  await first;

  for (let seen = 0; ;) {
    const fresh = responses.slice(seen);
    seen = responses.length;
    const ids = fresh.flatMap((response) => idsOf(JSON.parse(response.body) as Timeline));
    if (fresh.length > 0 && (ids.length === 0 || ids.some((id) => known.has(id)))) {
      break;
    }
    await computer.wheel(600 + Math.random() * 400);
    await pause();
    const bottom = await computer.evaluate<boolean>(
      "innerHeight + scrollY >= document.documentElement.scrollHeight - 4",
    );
    if (bottom && loading.size === 0 && responses.length === finished && responses.length === seen) {
      break;
    }
  }
  stop();
  offs.forEach((off) => off());

  return responses.filter((response) => response.status === 200).map((response) => response.body);
};

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

export interface XOptions {
  /** Where the remote computer runs. Defaults to Docker or Podman on this machine. */
  readonly computer?: Provider;
  /** Days between catch-ups. */
  readonly every?: number;
}

/** Your X bookmarks, likes, posts and replies, read by a remote computer signed in as you. */
export const x = ({ computer = local(), every = 3 }: XOptions = {}) => {
  const account = site(computer, {
    name: "x",
    login: "https://x.com/i/flow/login",
    signedIn: (cookies) =>
      cookies.some((cookie) => cookie.name === "auth_token" && cookie.domain.endsWith("x.com")),
  });

  return defineSource({
    name: "x",
    every,
    signin: account.signin,

    fetch: ({ dir, state }) =>
      account.run(state, async (browser) => {
        const twid = (await browser.cookies()).find((cookie) => cookie.name === "twid")?.value ?? "";
        const id = /u(?:%3D|=)(\d+)/.exec(decodeURIComponent(twid))?.[1];
        if (id === undefined) {
          throw new Error("x: the session has no twid cookie");
        }
        await browser.goto("https://x.com/home");
        const handle = await browser.evaluate<string | null>(
          `document.querySelector('[data-testid="AppTabBar_Profile_Link"]')?.getAttribute("href")?.slice(1) ?? null`,
        );
        if (handle === null) {
          throw new Error("x: x.com/home has no Profile link, so the session isn't signed in");
        }
        writeFileSync(`${dir}/viewer.json`, JSON.stringify({ id, handle } satisfies Viewer));

        const heads = `${state}/heads.json`;
        const known: Record<string, ReadonlyArray<string>> = existsSync(heads)
          ? JSON.parse(readFileSync(heads, "utf8"))
          : {};
        const next: Record<string, ReadonlyArray<string>> = {};

        for (const { file, operation, path } of timelines) {
          const bodies = await scroll(browser, path(handle), operation, new Set(known[file] ?? []));
          writeFileSync(`${dir}/${file}.jsonl`, bodies.map((body) => `${body}\n`).join(""));
          const ids = bodies.flatMap((body) => idsOf(JSON.parse(body) as Timeline));
          next[file] = ids.length > 0 ? ids.slice(0, 20) : (known[file] ?? []);
          await pause();
        }

        mkdirSync(state, { recursive: true });
        writeFileSync(heads, JSON.stringify(next));
      }),

    rows: async function* ({ dir }) {
      const viewer = await json<Viewer>(`${dir}/viewer.json`);

      for (const { file } of timelines) {
        for await (const line of lines(`${dir}/${file}.jsonl`)) {
          for (const entry of entriesOf(JSON.parse(line) as Timeline)) {
            for (const tweet of tweetsOf(entry)) {
              const id = `x:tweet:${tweet.rest_id}`;
              const mine = tweet.core?.user_results?.result?.rest_id === viewer.id;

              if ((file === "posts" || file === "replies") && !mine) {
                continue;
              }
              yield* postRows(tweet);
              yield file === "bookmarks"
                ? event({ verb: "saved", thing: id, collections: ["x bookmarks"] })
                : file === "likes"
                  ? event({ verb: "liked", thing: id })
                  : event({ verb: "posted", thing: id, ts: iso(tweet.legacy?.created_at) });
            }
          }
        }
      }
    },
  });
};
