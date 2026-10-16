---
name: add-source
description: Add a new data source to the user's commonplace archive (an app, service, export, or local file they want their agents to remember). Use when the user asks to add, connect, import, or sync a source like bookmarks, a chat app, notes, browser history, or a data export into commonplace.
---

# Add a source to commonplace

A source is one file, `sources/<name>.ts`, in the user's commonplace repo (`commonplace root` prints where it is). It has two halves:

- `fetch` copies what the service gives into today's snapshot directory. It may use the network, CLIs, and the clock.
- `rows` turns one snapshot into things, events, and links. It is pure: it reads only the snapshot.

Snapshots are dated, read-only, and kept forever, so `rows` can be fixed later and the archive rebuilt from them.

## Steps

1. **Find the data.** Ask the user only what you can't discover: which account, which export. Prefer, in order: an official CLI or API the user is already signed into, a local database or file the app keeps, a data export they download by hand. For a one-time export, skip `fetch`: copy the export into `data/raw/<name>/<YYYY-MM-DD>/` and write only `rows`.

   For a site with no usable API or automatable export (X, Instagram, LinkedIn), use the user's own browser session: see "Sites without an API" below.

2. **Write `fetch`.** Save the service's own output as close to raw as you can (JSON, JSONL, CSV) under `dir`. Don't reshape it; `rows` does that. Use `since` (the last snapshot's date, or null) to take only what's new when the full history is large. Overlapping a day is free: rows with the same ID merge. Throw on failure; the partial snapshot is discarded and retried on the next sync.

3. **Write `rows`.** Read with `json`, `jsonl`, `lines` or `csv` from `src/source.ts`; build rows with `thing`, `event`, `link`, `iso`, `urlRef` from `src/schema.ts`.
   - **IDs come from content**, so every source names the same thing the same way: `urlRef()` for any link (a post, video, repo or pull request when it is one, else `url:<host/path>`), `gh:repo:owner/name`, `<service>:<kind>:<native id>`. Never a row number or a random ID. A repeatable event with no ID of its own gets `key: digest(...its fields)`.
   - **Verbs say what the user did**, not what the app calls it. Use one from `src/schema.ts` (`saved`, `liked`, `posted`, `opened`, `followed`, `sent`, `received`, `prompted`, `commented`, `visited`, …). Add a verb there only when none fits.
   - **Times are real or null.** `iso()` the source's own timestamp; never use the fetch time or guess.
   - Every event's thing must be emitted by some source, or the build drops the event. A link may point at a thing nobody defined, like the post a reply answers.
   - Put the app's folder, list, or tag names in the event's `collections`.
   - If a local file changes whenever there's something new (an app's database), list it in `watch` so the LaunchAgent syncs on it.

4. **Register it** in `commonplace.config.ts`: add it to `sources` (earlier sources win when two disagree on a field), and add its name to `mcp` only if the user wants MCP clients to read it. Ask before exposing anything personal like messages, mail, or health data. Suggest `redact` rules for anything they'd rather keep out entirely.

5. **Run it**: `commonplace sync`, then read the coverage report. A failed snapshot names the file and row. Check a few records with `commonplace search` and `commonplace show <id>`, then `bun run check`.

## Sites without an API

Read the site the way its own web app does, from the user's signed-in browser on their machine, with [agent-browser](https://github.com/vercel-labs/agent-browser):

- **Sign in once.** Confirm with the user, then run `agent-browser --session <site> --restore --headed open <login page>` and let them sign in. The session persists; when the site logs it out, `fetch` throws with that same command.
- **Call the app's own JSON endpoints from inside the page** (`agent-browser --session <site> --restore eval`), so requests carry the session's cookies. Save each response as it came, one per line.
- **Look up what the app sends each run** from its current JS bundles (operation IDs, feature flags, tokens), so the fetch never goes stale.
- **Wait out rate limits** (`retry-after`, `x-rate-limit-reset`) instead of failing, and set a real Chrome user agent, since sites turn away HeadlessChrome.

For X: open `x.com/i/bookmarks`; the viewer's ID is in the `twid` cookie and the CSRF token in `ct0`; the bearer token and every GraphQL `queryId` with its feature switches are in the `client-web` bundles. Page `Bookmarks`, `BookmarkFoldersSlice` + `BookmarkFolderTimeline`, `Likes`, `UserTweets` and `UserRepliesTimeline` by their Bottom cursor until a page brings nothing new.

## Example

```ts
import { event, iso, thing, urlRef } from "../src/schema.ts";
import { defineSource, json } from "../src/source.ts";

interface Bookmark {
  readonly link: string;
  readonly title: string;
  readonly created: string;
  readonly folder: string;
}

export default defineSource({
  name: "bookmarks",

  fetch: async ({ dir }) => {
    const response = await fetch("https://api.example.com/bookmarks", {
      headers: { authorization: `Bearer ${process.env["EXAMPLE_TOKEN"]}` },
    });
    await Bun.write(`${dir}/bookmarks.json`, await response.text());
  },

  rows: async function* ({ dir }) {
    for (const bookmark of await json<ReadonlyArray<Bookmark>>(`${dir}/bookmarks.json`)) {
      const ref = urlRef(bookmark.link);

      if (ref !== null) {
        yield thing({ ...ref, title: bookmark.title, url: bookmark.link });
        yield event({
          verb: "saved",
          thing: ref.id,
          ts: iso(bookmark.created),
          collections: [bookmark.folder],
        });
      }
    }
  },
});
```
