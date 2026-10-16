---
name: add-source
description: Add a data source to the user's commonplace archive (an app, service, export or local file). Use when the user asks to add, connect, import or sync something like bookmarks, chats, notes, browser history or an export into commonplace.
---

# Add a source to commonplace

A source is one file, `sources/<name>.ts`, in the user's commonplace repo (`commonplace root`), with two halves:

- `fetch` copies what the service gives into today's snapshot directory.
- `rows` turns one snapshot into things, events and links, reading nothing else. Snapshots are kept forever, so a fixed `rows` rebuilds all of history.

Check `sources/` first. X is built in, with no API key. When the user wants it, confirm once, then:

1. If `agent-browser` is missing: `npm i -g agent-browser && agent-browser install`.
2. `agent-browser --session x --restore --headed open https://x.com/login`. The user signs in and closes the window.
3. Add `x()` to `sources` in `commonplace.config.ts` and run `commonplace sync`.

## Steps

1. **Find the data.** Ask only what you can't discover. Prefer an official CLI or API the user is signed into, then a file or database the app keeps, then an export they download. No API or export you can automate (Instagram, LinkedIn): see [Sites without an API](#sites-without-an-api). A one-time export needs no `fetch`: copy it into `data/raw/<name>/<YYYY-MM-DD>/`.
2. **Write `fetch`.** Save the service's output (JSON, JSONL, CSV) into `dir` as it came; reshaping is `rows`' job. For a long history, use `since` (the last snapshot's date) to take only what's new; overlap is free, as rows with the same ID merge. Throw on failure and the next sync retries.
3. **Write `rows`** with the readers in `src/source.ts` and the builders in `src/schema.ts`.
   - **IDs come from content**, so every source names a thing the same way: `urlRef()` for any link, `gh:repo:owner/name`, `<service>:<kind>:<native id>`. Never a row number or a random ID. A repeatable event with no ID of its own gets `key: digest(...its fields)`.
   - **Verbs say what the user did**, not what the app calls it, from `src/schema.ts`. Add one only when none fits.
   - **Times are real or null**: `iso()` the source's own timestamp, never the fetch time or a guess.
   - An event's thing must come from some source, or the event is dropped. A link may point at a thing no source defines.
   - Folder, list and tag names go in the event's `collections`.
   - A local file that changes when there's something new (an app's database) goes in `watch`; then rerun `commonplace install`.
4. **Register it**: add it to `sources` in `commonplace.config.ts`, where earlier sources win a field when two disagree. Add it to `mcp` only if the user wants MCP clients to read it, and ask first for messages, mail, health and the like. Suggest `redact` rules for anything they'd keep out.
5. **Run it**: `commonplace sync`, and read the report; a failed snapshot names its file and row. Spot-check with `commonplace search` and `commonplace show <id>`, then run `bun run check`.

## Sites without an API

Read them the way their own web app does, from the user's signed-in [agent-browser](https://github.com/vercel-labs/agent-browser) session on their machine. Copy `sources/x.ts`:

- **Sign in once**, after asking: `agent-browser --session <site> --restore --headed open <login page>`. When the session expires, `fetch` throws with that command.
- **Call the app's JSON endpoints from inside the page** (`agent-browser --session <site> --restore eval`), so its cookies go along. Save each response as it came, one per line.
- **Read operation IDs, flags and tokens from the app's current bundles** every run.
- **Stop paging at an ID the last run kept** in `state`.
- **Wait out rate limits**, and drop "Headless" from the user agent.

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
