# commonplace

**Your personal data kit for agents.** A commonplace book for the age of agents.

Scholars from Bacon to Locke kept a commonplace book: one place for everything they read, saved, and thought, added to every day for life. commonplace is yours, except it keeps itself. It copies your digital life into a private archive on your machine, keeps it current, and gives every agent you use one safe way to read it.

```
your accounts   GitHub, Claude Code, Codex, …
     │  fetch: one dated snapshot per day
data/raw/       private, read-only, kept forever
     │  import + redact
commonplace.db  rebuilt from raw/ anytime
     │
commonplace     CLI ─── search · timeline · show · stats
     └── mcp    Claude Code, Codex, Claude Desktop, any MCP client
```

- **Private by design.** Your data lives in `data/`, which never enters git. Agents never touch the database: they go through the CLI or MCP server, which only show the sources you allow. `redact` rules keep rows out of the archive entirely.
- **Always current.** `commonplace sync` takes one snapshot per source per day and rebuilds. The Claude Code plugin runs it whenever a session ends.
- **One shape for everything.** Every source becomes things, events, and links, with IDs derived from content, so the same page saved in two apps is one record.
- **Agents add the sources.** The `add-source` skill teaches your agent to write a new source for any app or export you have.

## Sources

### Built in: zero setup

| source    | what                                              | needs                   |
| --------- | ------------------------------------------------- | ----------------------- |
| `github`  | your pull requests, issues, and stars             | `gh` signed in          |
| `prompts` | every prompt you typed into Claude Code and Codex | nothing, read from disk |

### Coming built in

| source         | what                                                | needs                                       |
| -------------- | --------------------------------------------------- | ------------------------------------------- |
| X archive      | your posts, likes, DMs, and Grok chats, all of them | the archive you download from X's settings  |
| X              | new posts, likes, and bookmarks every day           | an X developer app (pay per use, cents/day) |
| iMessage       | your conversations                                  | macOS, Full Disk Access                     |
| Google Takeout | searches, YouTube, Maps, Chrome, Calendar           | a Takeout export                            |
| Raindrop       | bookmarks and collections                           | a CSV export or API token                   |

### One ask away

Anything with an export, a local database, an API, or a CLI. Ask your agent, _"add my Obsidian vault to commonplace"_, and the `add-source` skill has it write the source: one file, usually under 80 lines.

- **Browsing:** Chrome, Safari, Arc, or Dia history
- **Notes:** Obsidian or any folder of markdown, Apple Notes
- **Mail and calendar:** Gmail via Takeout, any `.ics`
- **Chat:** Slack, Discord, and Telegram exports
- **Reading and media:** Readwise, Pocket, Goodreads, Letterboxd, Spotify, Reddit exports

[`skills/add-source/SKILL.md`](skills/add-source/SKILL.md) works for any agent that reads files, not just Claude Code.

## Start

You need [Bun](https://bun.sh) and, for the GitHub source, the [GitHub CLI](https://cli.github.com) signed in.

```sh
gh repo create my-commonplace --template AVGVSTVS96/commonplace --private --clone
cd my-commonplace
bun install
bun add -g "$PWD"     # puts `commonplace` on your PATH
commonplace sync
```

Then connect your agents:

```sh
# Claude Code: MCP server, add-source skill, sync when a session ends
/plugin marketplace add AVGVSTVS96/commonplace
/plugin install commonplace@commonplace

# Codex
codex mcp add commonplace -- commonplace mcp

# anything else that speaks MCP
command: commonplace   args: ["mcp"]
```

Ask your agent something only your history can answer: _"What was I working on the week I first used Effect?"_, _"Which repos have I starred about syntax highlighting?"_

## Use

```
commonplace search <query>     full-text search (FTS5 syntax works too)
commonplace timeline           what you did, newest first  --since --until --verb
commonplace show <id>          one record with its events and links
commonplace stats              sources, freshness, kinds, verbs
commonplace sync               snapshot every source due today, then rebuild
commonplace build              rebuild the database from data/raw
commonplace mcp                MCP server on stdio  --sources a,b to narrow what a client sees
commonplace sql <query>        read-only SQL, local only
```

## Configure

`commonplace.config.ts` is yours to edit:

```ts
export default defineConfig({
  // strongest first: when two sources disagree on a field, the earlier one wins
  sources: [github, prompts],

  // what MCP clients may read; `commonplace mcp --sources github` narrows it per client
  mcp: ["github", "prompts"],

  // rows that never reach the archive
  redact: (row) => row.type === "event" && /\b(password|api[_ -]?key|secret)\b/i.test(row.text ?? ""),
});
```

## How it works

- **`data/raw/<source>/<date>/`** is the source of truth. Each fetch writes a new snapshot through a `.partial` directory and makes it read-only, so a crash never leaves half a snapshot.
- **`commonplace.db`** is SQLite with four tables, `things`, `events`, `links`, and a full-text `search` index. Every build starts from empty and replays every snapshot, so the same `raw/` always gives the same database.
- **Merging** needs no fuzzy matching. Things merge by ID; per field, the strongest source's newest value wins and nulls never erase. Once-only events (`saved`, `liked`, …) merge across sources and keep every collection.
- **Visibility** is all-or-nothing per row: a reader sees a row only if it may read every source that contributed to it, so a hidden source can't leak through a merge.

## Next

- Remote MCP for ChatGPT and claude.ai on the web
- The "coming built in" sources above

MIT
