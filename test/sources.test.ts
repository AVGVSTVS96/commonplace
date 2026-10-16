import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

import type { Row } from "../src/schema.ts";
import type { Source } from "../src/source.ts";
import { github } from "../sources/github.ts";
import { imessage } from "../sources/imessage.ts";
import { prompts } from "../sources/prompts.ts";
import raindrop from "../sources/raindrop.ts";
import takeout from "../sources/takeout.ts";
import xArchive from "../sources/x-archive.ts";
import { x } from "../sources/x.ts";

const folder = (files: Record<string, string>): string => {
  const dir = mkdtempSync(`${tmpdir()}/commonplace-source-`);

  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(`${dir}/${path}`), { recursive: true });
    writeFileSync(`${dir}/${path}`, text);
  }

  return dir;
};

const rowsOf = (source: Source, dir: string): Promise<Array<Row>> =>
  Array.fromAsync(source.rows({ source: source.name, date: "2026-01-01", dir }));

const pick = (rows: ReadonlyArray<Row>, type: Row["type"]) => rows.filter((row) => row.type === type);

test("takeout: activity verbs come from title prefixes, places and searches get stable ids", async () => {
  const activity = [
    {
      title: "Searched for  Best  Ramen ",
      titleUrl: "https://www.google.com/search?q=ramen",
      time: "2026-01-02T10:00:00.000Z",
    },
    {
      title: "Watched A talk",
      titleUrl: "https://www.youtube.com/watch?v=abc",
      time: "2026-01-02T11:00:00Z",
      subtitles: [{ name: "A Channel", url: "https://www.youtube.com/channel/UC123" }],
    },
    { title: "Viewed area around Lisbon", time: "2026-01-02T12:00:00Z" },
    {
      title: "Visited example.com/page",
      titleUrl: "https://www.google.com/url?q=https://example.com/page",
      time: "2026-01-02T13:00:00Z",
    },
  ];
  const dir = folder({
    "My Activity/Search/MyActivity.json": JSON.stringify(activity),
    "Saved/Lisbon.csv":
      "Title,Note,URL,Tags,Comment\nA Cafe,good,https://www.google.com/maps/place/A+Cafe/data=!4m2!3m1!1s0x0:0x1f,,\n",
    "YouTube and YouTube Music/comments/comments.csv":
      'Comment ID,Comment Create Timestamp,Video ID,Comment Text\nc1,2026-01-03T00:00:00+00:00,abc,"{""text"":""nice""}"\n',
  });
  const rows = await rowsOf(takeout, dir);

  expect(pick(rows, "event").map((row) => (row.type === "event" ? [row.verb, row.thing] : []))).toEqual([
    ["searched", "query:best ramen"],
    ["watched", "yt:video:abc"],
    ["visited", "url:example.com/page"],
    ["saved", "place:31"],
    ["posted", "yt:comment:c1"],
  ]);
  expect(rows).toContainEqual(
    expect.objectContaining({ id: "yt:video:abc", title: "A talk", author: "A Channel" }),
  );
  expect(rows).toContainEqual(expect.objectContaining({ id: "url:example.com/page", title: null }));
  expect(rows).toContainEqual({ type: "link", from: "yt:comment:c1", rel: "replies_to", to: "yt:video:abc" });

  const unknown = folder({
    "My Activity/Search/MyActivity.json": JSON.stringify([
      { title: "Teleported to Mars", time: "2026-01-02T10:00:00Z" },
    ]),
  });
  expect(rowsOf(takeout, unknown)).rejects.toThrow(/no verb for title "Teleported to Mars"/);
});

test("raindrop: a save per bookmark, folders as collections, tweets named as tweets", async () => {
  const dir = folder({
    "export.csv": [
      "id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite",
      '1,"A post, quoted",,,https://x.com/someone/status/5?s=20,AI,"agents, tools",2026-01-01T00:00:00.000Z,,,true',
      "2,Page,my note,an excerpt,https://example.com/a,Unsorted,,2026-01-02T00:00:00.000Z,,,false",
    ].join("\n"),
  });
  const rows = await rowsOf(raindrop, dir);

  expect(rows).toContainEqual(
    expect.objectContaining({ type: "thing", id: "x:tweet:5", kind: "tweet", title: "A post, quoted" }),
  );
  expect(rows).toContainEqual(
    expect.objectContaining({
      verb: "saved",
      thing: "x:tweet:5",
      collections: ["AI"],
      extra: expect.objectContaining({ tags: ["agents", "tools"], favorite: true }),
    }),
  );
  expect(rows).toContainEqual(
    expect.objectContaining({ verb: "saved", thing: "url:example.com/a", collections: [], text: "my note" }),
  );
});

const post = (id: string, user: string, text: string, legacy: object = {}) => ({
  rest_id: id,
  core: { user_results: { result: { rest_id: user, core: { screen_name: `user${user}` } } } },
  legacy: { full_text: text, created_at: "Thu Jan 01 12:00:00 +0000 2026", ...legacy },
});

/** One GraphQL page as x.com sends it: a timeline of posts. */
const timeline = (...posts: ReadonlyArray<object>) => ({
  timeline: {
    instructions: [
      {
        type: "TimelineAddEntries",
        entries: posts.map((result, i) => ({
          entryId: `tweet-${i}`,
          content: { itemContent: { tweet_results: { result } } },
        })),
      },
    ],
  },
});

const pages = (...data: ReadonlyArray<object>) =>
  data.map((page) => `${JSON.stringify({ data: page })}\n`).join("");

test("x: bookmarks with their folders, likes, and only your own posts, from the pages x.com sent", async () => {
  const shared = post("10", "7", "a thread on kerning https://t.co/a", {
    entities: { urls: [{ url: "https://t.co/a", expanded_url: "https://example.com/kerning" }] },
  });
  const profile = (...posts: ReadonlyArray<object>) => ({
    user: { result: { timeline: timeline(...posts) } },
  });
  const dir = folder({
    "viewer.json": JSON.stringify({ id: "1" }),
    "bookmarks.jsonl": pages({ bookmark_timeline_v2: timeline(shared) }),
    "folders.json": pages({
      viewer: {
        user_results: { result: { bookmark_collections_slice: { items: [{ id: "55", name: "type" }] } } },
      },
    }),
    "folders/55.jsonl": pages({ bookmark_collection_timeline: timeline(shared) }),
    "likes.jsonl": pages(profile(post("11", "8", "liked"))),
    "posts.jsonl": pages(profile(post("12", "1", "mine"), post("13", "9", "someone else's"))),
  });
  const rows = await rowsOf(x(), dir);

  expect(pick(rows, "event")).toEqual([
    expect.objectContaining({ verb: "saved", thing: "x:tweet:10", collections: ["x bookmarks"] }),
    expect.objectContaining({ verb: "saved", thing: "x:tweet:10", collections: ["x bookmarks", "type"] }),
    expect.objectContaining({ verb: "liked", thing: "x:tweet:11" }),
    expect.objectContaining({ verb: "posted", thing: "x:tweet:12", ts: "2026-01-01T12:00:00.000Z" }),
  ]);
  expect(rows).toContainEqual(
    expect.objectContaining({ id: "x:tweet:10", author: "user7", url: "https://x.com/user7/status/10" }),
  );
  expect(rows).toContainEqual({
    type: "link",
    from: "x:tweet:10",
    rel: "mentions",
    to: "url:example.com/kerning",
  });
  expect(rows).not.toContainEqual(expect.objectContaining({ id: "x:tweet:13" }));
});

const js = (name: string, value: unknown) => `window.YTD.${name}.part0 = ${JSON.stringify(value)}`;

test("x-archive: posts with their full text, likes, follows, DMs and Grok", async () => {
  const dir = folder({
    "data/account.js": js("account", [
      { account: { accountId: "1", username: "me", accountDisplayName: "Me" } },
    ]),
    "data/tweets.js": js("tweets", [
      {
        tweet: {
          id_str: "10",
          created_at: "Fri Jan 02 10:00:00 +0000 2026",
          full_text: "a long post cut sh…",
          in_reply_to_status_id_str: "9",
          in_reply_to_screen_name: "friend",
          entities: { urls: [{ expanded_url: "https://example.com/" }] },
          edit_info: {},
        },
      },
    ]),
    "data/note-tweet.js": js("note_tweet", [
      {
        noteTweet: {
          noteTweetId: "n",
          createdAt: "2026-01-02T10:00:00.000Z",
          core: { text: "a long post cut short no more" },
        },
      },
    ]),
    "data/like.js": js("like", [
      { like: { tweetId: "20", fullText: "a &amp; b", expandedUrl: "https://x.com/i/web/status/20" } },
    ]),
    "data/direct-messages.js": js("direct_messages", [
      {
        dmConversation: {
          conversationId: "1-2",
          messages: [
            {
              messageCreate: {
                id: "m1",
                senderId: "2",
                text: "hi",
                createdAt: "2026-01-03T00:00:00.000Z",
                urls: [],
                mediaUrls: [],
              },
            },
          ],
        },
      },
    ]),
    "data/grok-chat-item.js": js("grok_chat_item", [
      {
        grokChatItem: {
          chatId: "g",
          createdAt: "2026-01-04T00:00:00.000Z",
          sender: { originalName: "USER" },
          message: "why?",
        },
      },
    ]),
  });
  const rows = await rowsOf(xArchive, dir);
  expect(rows).toContainEqual(
    expect.objectContaining({ id: "x:tweet:10", text: "a long post cut short no more", author: "me" }),
  );
  expect(rows).toContainEqual(expect.objectContaining({ id: "x:tweet:9", kind: "tweet", author: "friend" }));
  expect(rows).toContainEqual(expect.objectContaining({ id: "x:tweet:20", text: "a & b" }));
  expect(rows).toContainEqual({ type: "link", from: "x:tweet:10", rel: "mentions", to: "url:example.com" });
  expect(pick(rows, "event").map((row) => (row.type === "event" ? `${row.verb} ${row.thing}` : ""))).toEqual([
    "posted x:tweet:10",
    "liked x:tweet:20",
    "received x:dm:1-2",
    "sent x:grok:g",
  ]);
});

const chatDb = (path: string) => {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT, service_name TEXT, style INTEGER);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER, is_from_me INTEGER,
      item_type INTEGER, associated_message_type INTEGER, associated_message_guid TEXT, service TEXT, cache_has_attachments INTEGER, handle_id INTEGER);
    INSERT INTO handle VALUES (1, '+15550001'), (2, '+15550002');
    INSERT INTO chat VALUES (1, 'iMessage;-;+15550001', '', 'iMessage', 45);
    INSERT INTO chat_handle_join VALUES (1, 1);
    INSERT INTO chat_message_join VALUES (1, 1), (1, 2);
    INSERT INTO message VALUES
      (1, 'm1', 'see you at 8', NULL, 789000000000000000, 0, 0, 0, NULL, 'iMessage', 0, 1),
      (2, 'm2', NULL, NULL, 789000060000000000, 1, 0, 2001, 'p:0/m1', 'iMessage', 0, 1),
      (3, 'm3', 'no chat row', NULL, 789000120000000000, 0, 0, 0, NULL, 'SMS', 0, 2),
      (4, 'm4', 'renamed', NULL, 789000180000000000, 0, 2, 0, NULL, 'iMessage', 0, 1);
  `);
  db.close();
};

test("imessage: a whole chat.db snapshot gives every chat and message, and drop rules still apply", async () => {
  const dir = folder({});
  chatDb(`${dir}/chat.db`);
  const rows = await rowsOf(imessage({ drop: (message) => message.text === "no chat row" }), dir);

  expect(pick(rows, "thing").map((row) => (row.type === "thing" ? row.id : ""))).toEqual([
    "chat:imessage:any;-;+15550002",
    "chat:imessage:iMessage;-;+15550001",
  ]);
  expect(pick(rows, "event")).toEqual([
    expect.objectContaining({
      verb: "received",
      key: "m1",
      ts: "2026-01-01T22:40:00.000Z",
      text: "see you at 8",
    }),
    expect.objectContaining({
      verb: "sent",
      key: "m2",
      extra: expect.objectContaining({ associated: { kind: "like", removed: false, to: "p:0/m1" } }),
    }),
  ]);
});

const user = (fields: Record<string, unknown>, text: string) =>
  JSON.stringify({
    type: "user",
    sessionId: "s1",
    cwd: "/work/app",
    timestamp: fields["ts"],
    message: { content: text },
    ...fields,
  });

test("prompts: typed turns and chat messages, not the harness, plugins or scripts", async () => {
  const home = folder({
    ".claude/projects/app/s1.jsonl": [
      user({ ts: "2026-01-01T00:00:00.000Z", entrypoint: "cli" }, "  fix the build  "),
      JSON.stringify({ type: "assistant", message: { model: "claude-x" } }),
      user(
        { ts: "2026-01-01T00:01:00.000Z", isMeta: true, origin: { kind: "channel" } },
        '<channel source="plugin:telegram:telegram" chat_id="1" user="me">\nfrom my phone\n</channel>',
      ),
      user(
        { ts: "2026-01-01T00:02:00.000Z", origin: { kind: "task-notification" } },
        "a background task finished",
      ),
      user({ ts: "2026-01-01T00:03:00.000Z", entrypoint: "sdk-cli" }, "a scripted prompt"),
      user({ ts: "2026-01-01T00:04:00.000Z" }, "<command-name>/clear</command-name>"),
    ].join("\n"),
    ".codex/sessions/2026/01/01/rollout.jsonl": [
      JSON.stringify({ type: "session_meta", payload: { id: "c1", cwd: "/work/api", source: "cli" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T01:00:00.000Z",
        payload: { type: "user_message", message: "add a test" },
      }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-x" } }),
    ].join("\n"),
  });
  const saved = {
    HOME: process.env["HOME"],
    CLAUDE_CONFIG_DIR: process.env["CLAUDE_CONFIG_DIR"],
    CODEX_HOME: process.env["CODEX_HOME"],
    PI_CODING_AGENT_DIR: process.env["PI_CODING_AGENT_DIR"],
  };
  Object.assign(process.env, {
    HOME: home,
    CLAUDE_CONFIG_DIR: `${home}/.claude`,
    CODEX_HOME: `${home}/.codex`,
    PI_CODING_AGENT_DIR: `${home}/.pi/agent`,
  });
  const source = prompts();
  const dir = folder({});
  try {
    await source.fetch?.({ dir, since: null, state: folder({}) });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  const rows = await rowsOf(source, dir);

  expect(
    pick(rows, "event").map((row) => (row.type === "event" ? [row.thing, row.text, row.extra] : [])),
  ).toEqual([
    ["session:claude:s1", "fix the build", { cwd: "/work/app", model: "claude-x" }],
    [
      "session:claude:s1",
      "from my phone",
      { cwd: "/work/app", model: "claude-x", channel: "plugin:telegram:telegram", from: "me" },
    ],
    ["session:codex:c1", "add a test", { cwd: "/work/api", model: "gpt-x" }],
  ]);
});

const pr = (repo: string, number: number) => ({
  repository: { nameWithOwner: repo },
  number,
  title: `PR ${number}`,
  body: "",
  state: "merged",
  isDraft: false,
  createdAt: "2026-01-01T00:00:00Z",
  closedAt: "0001-01-01T00:00:00Z",
  url: `https://github.com/${repo}/pull/${number}`,
});

test("github: snapshots from older fetches, with or without reviews, commits, issues and stars", async () => {
  const reviewing = folder({
    "prs.json": JSON.stringify([pr("Me/App", 1)]),
    "reviewed.jsonl": `${JSON.stringify({
      repository_url: "https://api.github.com/repos/Other/Lib",
      number: 2,
      title: "Their PR",
      body: null,
      html_url: "https://github.com/Other/Lib/pull/2",
      user: { login: "them" },
      state: "closed",
      draft: false,
      created_at: "2026-01-02T00:00:00Z",
      closed_at: "2026-01-03T00:00:00Z",
      pull_request: { merged_at: "2026-01-03T00:00:00Z" },
    })}\n`,
    "reviews.jsonl": `${JSON.stringify({ id: 7, repo: "Other/Lib", pr: 2, state: "COMMENTED", body: "looks good", html_url: "u", commit_id: null, submitted_at: "2026-01-02T05:00:00Z" })}\n`,
    "review_comments.jsonl": `${JSON.stringify({ id: 8, pull_request_review_id: 7, body: "nit", path: "a.ts", line: 3, html_url: "u", created_at: "2026-01-02T05:00:00Z" })}\n`,
    "commits.jsonl": ["Me/App", "Me/app-fork"]
      .map((repo) =>
        JSON.stringify({
          sha: "a".repeat(40),
          date: "2026-01-01T10:00:00-05:00",
          author: "me",
          email: "e",
          subject: "fix",
          body: "",
          repo,
          remote: `git@github.com:${repo}.git`,
          path: "/p",
        }),
      )
      .join("\n"),
  });
  const rows = await rowsOf(github(), reviewing);
  expect(rows).toContainEqual(
    expect.objectContaining({
      id: "gh:pr:me/app#1",
      extra: { state: "merged", draft: false, closed_at: null },
    }),
  );
  expect(rows).toContainEqual(
    expect.objectContaining({
      id: "gh:pr:other/lib#2",
      author: "them",
      extra: expect.objectContaining({ state: "merged" }),
    }),
  );
  expect(rows).toContainEqual(
    expect.objectContaining({ verb: "reviewed", key: "review:7", text: "looks good\n\nnit" }),
  );
  expect(rows).toContainEqual(
    expect.objectContaining({
      verb: "committed",
      key: `commit:${"a".repeat(40)}`,
      thing: "gh:repo:me/app",
      ts: "2026-01-01T15:00:00.000Z",
    }),
  );

  const starring = folder({
    "prs.json": "[]",
    "issues.json": JSON.stringify([{ ...pr("Me/App", 3), isDraft: undefined }]),
    "stars.jsonl": `${JSON.stringify({ starred_at: "2026-01-05T00:00:00Z", repo: { full_name: "Cool/Tool", description: "d", html_url: "https://github.com/Cool/Tool", language: null, topics: [], created_at: "2020-01-01T00:00:00Z" } })}\n`,
  });

  expect(await rowsOf(github(), starring)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ verb: "opened", thing: "gh:issue:me/app#3" }),
      expect.objectContaining({ verb: "saved", thing: "gh:repo:cool/tool", collections: ["github stars"] }),
    ]),
  );
});
