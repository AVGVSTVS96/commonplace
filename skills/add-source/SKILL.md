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

2. **Write `fetch`.** Save the service's own output as close to raw as you can (JSON, JSONL, CSV) under `dir`. Don't reshape it; `rows` does that. Use `since` (the last snapshot's date, or null) to take only what's new when the full history is large. Overlapping a day is free: rows with the same ID merge. Throw on failure; the partial snapshot is discarded and retried on the next sync.

3. **Write `rows`.** Read with `json`, `jsonl`, or `lines` from `src/source.ts`; build rows with `thing`, `event`, `link`, `iso`, `urlId` from `src/schema.ts`.
   - **IDs come from content**, so every source names the same thing the same way: `url:<host/path>` via `urlId()` for any web page, `gh:repo:owner/name`, `<service>:<kind>:<native id>`. Never a row number or a random ID.
   - **Verbs say what the user did**, not what the app calls it. Use one from `src/schema.ts` (`saved`, `liked`, `posted`, `opened`, `followed`, `sent`, `received`, `prompted`, `commented`, `visited`, …). Add a verb there only when none fits.
   - **Times are real or null.** `iso()` the source's own timestamp; never use the fetch time or guess.
   - Every event's thing must be emitted by some source, or the build drops the event.
   - Put the app's folder, list, or tag names in the event's `collections`.

4. **Register it** in `commonplace.config.ts`: add it to `sources` (earlier sources win when two disagree on a field), and add its name to `mcp` only if the user wants MCP clients to read it. Ask before exposing anything personal like messages, mail, or health data. Suggest `redact` rules for anything they'd rather keep out entirely.

5. **Run it**: `commonplace sync`, then read the coverage report. A failed snapshot names the file and row. Check a few records with `commonplace search` and `commonplace show <id>`, then `bun run check`.

## Example

```ts
import { event, iso, thing, urlId } from "../src/schema.ts";
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
      const id = urlId(bookmark.link);

      yield thing({ id, kind: "url", title: bookmark.title, url: bookmark.link });
      yield event({ verb: "saved", thing: id, ts: iso(bookmark.created), collections: [bookmark.folder] });
    }
  },
});
```
