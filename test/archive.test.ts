import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { build, paths } from "../src/build.ts";
import { defineConfig } from "../src/config.ts";
import { event, link, type Row, thing, urlRef } from "../src/schema.ts";
import { defineSource, jsonl } from "../src/source.ts";
import { open } from "../src/store.ts";
import { sync } from "../src/sync.ts";

const fromFile = (name: string) => defineSource({ name, rows: ({ dir }) => jsonl<Row>(`${dir}/rows.jsonl`) });

const snapshot = (data: string, source: string, date: string, rows: ReadonlyArray<Row>) => {
  const dir = `${paths(data).raw}/${source}/${date}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/rows.jsonl`, rows.map((row) => JSON.stringify(row)).join("\n"));
};

const page = urlRef("https://www.Example.com/post/?utm_source=x&id=1#top")?.id ?? "";

const fixture = () => {
  const data = mkdtempSync(`${tmpdir()}/commonplace-`);

  snapshot(data, "bookmarks", "2026-01-01", [
    thing({ id: page, kind: "url", title: "Old title", text: "from bookmarks" }),
    event({ verb: "saved", thing: page, collections: ["reading"] }),
  ]);
  snapshot(data, "bookmarks", "2026-02-01", [thing({ id: page, kind: "url", title: "New title" })]);
  snapshot(data, "notes", "2026-01-15", [
    thing({ id: page, kind: "url", title: "Notes title", author: "someone" }),
    event({ verb: "saved", thing: page, collections: ["ideas"], ts: "2026-01-15T10:00:00.000Z" }),
    thing({ id: "note:1", kind: "note", text: "private diary" }),
    event({ verb: "posted", thing: "note:1", ts: "2026-01-16T10:00:00.000Z" }),
    link("note:1", "mentions", page),
  ]);
  snapshot(data, "notes", "2026-01-20", [event({ verb: "posted", thing: "note:missing" })]);
  snapshot(data, "notes", "2026-01-21", [thing({ id: "no scheme", kind: "note" })]);

  return data;
};

const config = defineConfig({
  sources: [fromFile("bookmarks"), fromFile("notes")],
  mcp: ["bookmarks"],
});

test("urlRef drops www, tracking, fragments, and trailing slashes", () => {
  expect(page).toBe("url:example.com/post?id=1");
});

const ids = (hrefs: ReadonlyArray<string>) => hrefs.map((href) => urlRef(href)?.id ?? null);

test("urlRef names posts, videos, repos and pull requests the same from any link", () => {
  expect(
    ids([
      "https://twitter.com/someone/status/123/photo/1?s=20",
      "https://x.com/i/status/123",
      "https://youtu.be/abc",
      "https://m.youtube.com/watch?v=abc&t=4",
      "https://www.youtube.com/shorts/abc",
      "https://github.com/Owner/Repo/pull/7/files",
      "https://github.com/Owner/Repo",
      "https://www.google.com/url?q=https://example.com/a/&sa=D",
      "mailto:someone@example.com",
    ]),
  ).toEqual([
    "x:tweet:123",
    "x:tweet:123",
    "yt:video:abc",
    "yt:video:abc",
    "yt:video:abc",
    "gh:pr:owner/repo#7",
    "gh:repo:owner/repo",
    "url:example.com/a",
    null,
  ]);
});

test("the strongest source wins each field, its newest snapshot first, and nulls never erase", async () => {
  const data = fixture();
  const built = await build(config, data);
  const store = open(paths(data).db, ["bookmarks", "notes"]);
  const shown = store.show(page);

  expect(shown?.thing).toMatchObject({
    title: "New title",
    text: "from bookmarks",
    author: "someone",
    sources: ["bookmarks", "notes"],
  });
  expect(built.orphans).toBe(1);
});

test("once-verbs merge across sources and keep every collection", async () => {
  const data = fixture();
  await build(config, data);
  const shown = open(paths(data).db, ["bookmarks", "notes"]).show(`saved:${page}`);

  expect(shown).toMatchObject({
    event: {
      collections: ["ideas", "reading"],
      ts: "2026-01-15T10:00:00.000Z",
      sources: ["bookmarks", "notes"],
    },
  });
});

test("a bad row fails its whole snapshot and the build says where", async () => {
  const built = await build(config, fixture());
  const failed = built.outcomes.filter((o) => o.error !== null);

  expect(failed).toHaveLength(1);
  expect(failed[0]?.error).toContain('thing id "no scheme"');
});

test("redacted rows never reach the database, and their events go with them", async () => {
  const data = fixture();
  await build({ ...config, redact: (row) => row.type === "thing" && row.id === "note:1" }, data);
  const store = open(paths(data).db, ["bookmarks", "notes"]);

  expect(store.show("note:1")).toBeNull();
  expect(store.search("diary")).toEqual([]);
  expect(store.timeline({ verb: "posted" })).toEqual([]);
});

test("a reader sees only rows whose every source it may read", async () => {
  const data = fixture();
  await build(config, data);
  const store = open(paths(data).db, ["notes"]);

  expect(store.show(page)).toBeNull();
  expect(store.search("diary").map((hit) => hit.id)).toEqual(["note:1"]);
  expect(store.show("note:1")).toMatchObject({ links: [] });
  expect(store.stats().sources.map((s) => s.source)).toEqual(["notes"]);
});

test("search matches word forms, and a link to a thing no source defined still shows", async () => {
  const data = fixture();
  snapshot(data, "notes", "2026-01-22", [
    thing({ id: "note:2", kind: "note", text: "planning two trips" }),
    link("note:2", "replies_to", "note:elsewhere"),
  ]);
  await build(config, data);
  const store = open(paths(data).db, ["notes"]);

  expect(store.search("trip").map((hit) => hit.id)).toEqual(["note:2"]);
  expect(store.show("note:2")).toMatchObject({
    links: [{ rel: "replies_to", direction: "to", id: "note:elsewhere", title: null }],
  });
});

test("search falls back to plain words when the query isn't FTS5 syntax", async () => {
  const data = fixture();
  await build(config, data);

  expect(
    open(paths(data).db, ["notes"])
      .search("private (diary")
      .map((hit) => hit.id),
  ).toEqual(["note:1"]);
});

test("sync snapshots each source once a day, read-only, and leaves nothing behind on failure", async () => {
  const data = mkdtempSync(`${tmpdir()}/commonplace-`);
  let calls = 0;
  const notes = defineSource({
    name: "notes",
    fetch: async ({ dir, since }) => {
      calls += 1;
      expect(since).toBeNull();
      writeFileSync(`${dir}/rows.jsonl`, JSON.stringify(thing({ id: "note:1", kind: "note" })));
    },
    rows: ({ dir }) => jsonl<Row>(`${dir}/rows.jsonl`),
  });
  const broken = defineSource({
    name: "broken",
    fetch: async () => {
      throw new Error("offline");
    },
    rows: () => [],
  });
  const both = defineConfig({ sources: [notes, broken], mcp: [] });

  const first = await sync(both, data, () => {});
  const second = await sync(both, data, () => {});
  const [date = ""] = readdirSync(`${paths(data).raw}/notes`);

  expect(first).toMatchObject({
    fetched: ["notes"],
    failed: [{ source: "broken", error: "offline" }],
  });
  expect(second?.fetched).toEqual([]);
  expect(calls).toBe(1);
  expect(statSync(`${paths(data).raw}/notes/${date}/rows.jsonl`).mode & 0o222).toBe(0);
  expect(readdirSync(`${paths(data).raw}/broken`)).toEqual([]);
});

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toLocaleDateString("sv");

test("a source with `every` waits that many days, and gets its own state directory", async () => {
  const data = mkdtempSync(`${tmpdir()}/commonplace-`);
  const states: Array<string> = [];
  const weekly = defineSource({
    name: "weekly",
    every: 7,
    fetch: async ({ dir, state }) => {
      states.push(state);
      writeFileSync(`${dir}/rows.jsonl`, "");
    },
    rows: () => [],
  });
  const only = defineConfig({ sources: [weekly], mcp: [] });

  snapshot(data, "weekly", daysAgo(6), []);
  expect((await sync(only, data, () => {}))?.fetched).toEqual([]);

  snapshot(data, "weekly", daysAgo(7), []);
  rmSync(`${paths(data).raw}/weekly/${daysAgo(6)}`, { recursive: true });
  expect((await sync(only, data, () => {}))?.fetched).toEqual(["weekly"]);
  expect(states).toEqual([`${data}/state/weekly`]);
});

test("lines split on newlines only, so JSON text may hold a line separator", async () => {
  const file = `${mkdtempSync(`${tmpdir()}/commonplace-`)}/rows.jsonl`;
  writeFileSync(file, `${JSON.stringify({ text: "one two" })}\r\n\n${JSON.stringify({ text: "three" })}`);

  expect(await Array.fromAsync(jsonl<{ text: string }>(file))).toEqual([
    { text: "one two" },
    { text: "three" },
  ]);
});
