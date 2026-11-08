import { existsSync, readdirSync, readFileSync } from "node:fs";

import { digest, event, iso, link, thing, urlRef } from "../src/schema.ts";
import type { Row } from "../src/schema.ts";
import { defineSource } from "../src/source.ts";

interface Tweet {
  readonly id_str: string;
  readonly created_at: string;
  readonly full_text: string;
  readonly in_reply_to_status_id_str?: string;
  readonly in_reply_to_screen_name?: string;
  readonly entities: { readonly urls: readonly { readonly expanded_url: string }[] };
  readonly edit_info?: { readonly edit?: { readonly initialTweetId: string } };
  readonly deleted_at?: string;
}

interface Note {
  readonly noteTweetId: string;
  readonly createdAt: string;
  readonly core: { readonly text: string };
}

interface Message {
  readonly messageCreate?: {
    readonly id: string;
    readonly senderId: string;
    readonly text: string;
    readonly createdAt: string;
    readonly urls: readonly { readonly expanded: string }[];
    readonly mediaUrls: readonly string[];
  };
  readonly conversationNameUpdate?: { readonly name: string; readonly createdAt: string };
}

interface Conversation {
  readonly dmConversation: {
    readonly conversationId: string;
    readonly messages: readonly Message[];
  };
}

interface GrokItem {
  readonly grokChatItem: {
    readonly chatId: string;
    readonly createdAt: string;
    readonly sender: { readonly originalName: "USER" | "AGENT" };
    readonly message: string;
    readonly postIds?: readonly string[];
    readonly attachments?: readonly { readonly url: string }[];
  };
}

const entries = <T>(dir: string, name: string): T[] => {
  const data = `${dir}/data`;
  const part = new RegExp(`^${name}(?:-part\\d+)?\\.js$`, "u");

  return (existsSync(data) ? readdirSync(data) : [])
    .filter((file) => part.test(file))
    .toSorted()
    .flatMap((file) => {
      const js = readFileSync(`${data}/${file}`, "utf-8");
      const prefix = /^window\.YTD\.\w+\.part\d+ = /u.exec(js);

      if (prefix === null) {
        throw new Error(`${data}/${file}: missing the window.YTD.<name>.partN = prefix`);
      }

      // SAFETY: each archive file assigns one JSON array of the records its name says.
      return JSON.parse(js.slice(prefix[0].length)) as T[];
    });
};

const unescape = (text: string): string =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

const time = (value: string): string => {
  const at = iso(value);

  if (at === null) {
    throw new Error(`not a time: ${value}`);
  }

  return at;
};

const snowflakeEpoch = 1_288_834_974_657n;

export const postedAt = (id: string): string | null => {
  const snowflake = /^\d+$/u.test(id) ? BigInt(id) : 0n;

  return snowflake < 10n ** 12n
    ? null
    : new Date(Number(snowflake / 2n ** 22n + snowflakeEpoch)).toISOString();
};

const distinct = (rows: Iterable<Row>): Row[] => {
  const things = new Map<string, Extract<Row, { type: "thing" }>>();
  const links = new Map<string, Row>();
  const events: Row[] = [];

  for (const row of rows) {
    if (row.type === "thing") {
      const seen = things.get(row.id);
      things.set(
        row.id,
        seen === undefined
          ? row
          : {
              ...seen,
              title: seen.title ?? row.title,
              text: seen.text ?? row.text,
              url: seen.url ?? row.url,
              author: seen.author ?? row.author,
              created_at: seen.created_at ?? row.created_at,
              extra: { ...row.extra, ...seen.extra },
            },
      );
    } else if (row.type === "link") {
      links.set(`${row.from} ${row.rel} ${row.to}`, row);
    } else {
      events.push(row);
    }
  }

  return [...things.values(), ...events, ...links.values()];
};

interface Account {
  readonly accountId: string;
  readonly username: string;
  readonly accountDisplayName: string;
}

const accountOf = (dir: string): Account => {
  const [account, ...others] = entries<{ account: Account }>(dir, "account");

  if (account === undefined || others.length > 0) {
    throw new Error(
      `${dir}/data/account.js: ${others.length + (account === undefined ? 0 : 1)} accounts, expected 1`,
    );
  }

  return account.account;
};

const longTextsByCreatedAt = (
  dir: string,
  own: readonly (readonly [Tweet, string])[],
): Map<string, string> => {
  const texts = new Map<string, string>();

  for (const { noteTweet: note } of [
    ...entries<{ noteTweet: Note }>(dir, "note-tweet"),
    ...entries<{ noteTweet: Note }>(dir, "deleted-note-tweet"),
  ]) {
    const matches = own.filter(([, created]) => created === time(note.createdAt));
    const [match] = matches.map(([tweet]) => tweet);

    if (match === undefined || matches.length > 1 || texts.has(match.id_str)) {
      throw new Error(
        `${dir}/data/note-tweet.js: note ${note.noteTweetId} matches ${matches.length} posts, not 1`,
      );
    }

    texts.set(match.id_str, note.core.text);
  }

  return texts;
};

const conversationRows = (dir: string, me: Account): Row[] =>
  (
    [
      ["direct-messages", false],
      ["direct-messages-group", true],
    ] as const
  ).flatMap(([file, group]) =>
    entries<Conversation>(dir, file).flatMap(({ dmConversation: conversation }) => {
      const id = `x:dm:${conversation.conversationId}`;

      const [named] = conversation.messages
        .flatMap((message) =>
          message.conversationNameUpdate === undefined ? [] : [message.conversationNameUpdate],
        )
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));

      return [
        thing({ id, kind: "dm", title: named?.name ?? null, extra: { group } }),
        ...conversation.messages.flatMap(({ messageCreate: message }) =>
          message === undefined
            ? []
            : [
                event({
                  verb: message.senderId === me.accountId ? "sent" : "received",
                  thing: id,
                  ts: time(message.createdAt),
                  text: unescape(message.text),
                  key: message.id,
                  extra: {
                    sender: `x:user:${message.senderId}`,
                    urls: message.urls.map(({ expanded }) => expanded),
                    media: [...message.mediaUrls],
                  },
                }),
              ],
        ),
      ];
    }),
  );

const grokRows = (dir: string): Row[] =>
  entries<GrokItem>(dir, "grok-chat-item").flatMap(({ grokChatItem: item }) => {
    const id = `x:grok:${item.chatId}`;

    return [
      thing({ id, kind: "grok" }),
      event({
        verb: item.sender.originalName === "USER" ? "sent" : "received",
        thing: id,
        ts: time(item.createdAt),
        text: item.message,
        key: digest(item.createdAt, item.chatId, null, item.message),
        extra: {
          posts: [...(item.postIds ?? [])],
          attachments: (item.attachments ?? []).map(({ url }) => url),
        },
      }),
    ];
  });

export default defineSource({
  name: "x-archive",
  rows: ({ dir }) => {
    const me = accountOf(dir);
    const tweets = entries<{ tweet: Tweet }>(dir, "tweets").map(({ tweet }) => tweet);
    const deleted = entries<{ tweet: Tweet }>(dir, "deleted-tweets").map(({ tweet }) => tweet);
    const own = [...tweets, ...deleted].map((tweet) => [tweet, time(tweet.created_at)] as const);
    const texts = longTextsByCreatedAt(dir, own);

    const records: Row[] = [
      thing({
        id: `x:user:${me.accountId}`,
        kind: "user",
        title: me.accountDisplayName,
        url: `https://x.com/${me.username}`,
        extra: { username: me.username },
      }),
    ];

    const stubs: Row[] = [];

    for (const [tweet, created] of own) {
      const id = `x:tweet:${tweet.id_str}`;

      records.push(
        thing({
          id,
          kind: "tweet",
          text: texts.get(tweet.id_str) ?? unescape(tweet.full_text),
          url: `https://x.com/${me.username}/status/${tweet.id_str}`,
          author: me.username,
          created_at: created,
          extra: {
            deleted_at: tweet.deleted_at === undefined ? null : time(tweet.deleted_at),
            edit_of: tweet.edit_info?.edit?.initialTweetId ?? null,
          },
        }),
        event({ verb: "posted", thing: id, ts: created }),
      );

      if (tweet.in_reply_to_status_id_str !== undefined) {
        const parent = `x:tweet:${tweet.in_reply_to_status_id_str}`;
        stubs.push(
          thing({
            id: parent,
            kind: "tweet",
            author: tweet.in_reply_to_screen_name ?? null,
            created_at: postedAt(tweet.in_reply_to_status_id_str),
          }),
          link(id, "replies_to", parent),
        );
      }

      for (const { expanded_url: url } of tweet.entities.urls) {
        const target = urlRef(url);

        if (target === null) {
          throw new Error(
            `${dir}/data/tweets.js: post ${tweet.id_str} links to ${url}, not an http(s) URL`,
          );
        }

        stubs.push(thing({ ...target, url }), link(id, "mentions", target.id));
      }
    }

    for (const { like } of entries<{
      like: { tweetId: string; fullText?: string; expandedUrl: string };
    }>(dir, "like")) {
      const id = `x:tweet:${like.tweetId}`;

      records.push(
        thing({
          id,
          kind: "tweet",
          text: like.fullText === undefined ? null : unescape(like.fullText),
          url: like.expandedUrl,
          created_at: postedAt(like.tweetId),
        }),
        event({ verb: "liked", thing: id }),
      );
    }

    for (const { following } of entries<{ following: { accountId: string; userLink: string } }>(
      dir,
      "following",
    )) {
      const id = `x:user:${following.accountId}`;

      records.push(
        thing({ id, kind: "user", url: following.userLink }),
        event({ verb: "followed", thing: id }),
      );
    }

    records.push(...conversationRows(dir, me), ...grokRows(dir));

    return distinct([...records, ...stubs]);
  },
});
