<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/commonplace-dark.svg">
    <img alt="commonplace" src=".github/assets/commonplace.svg" width="320">
  </picture>
</h1>

**Your personal data kit for agents.** A commonplace book for the age of agents.

[Website](https://commonplace-eight-sable.vercel.app) · [Start](#start) · [Sources](#sources) · [How it works](#how-it-works)

People like Bacon and Locke kept a commonplace book: one notebook for everything they read, saved and thought, added to for life. commonplace keeps yours for you. It copies everything you've made, saved and said into a private archive on your machine, keeps it current, and gives every agent you use one safe door to it.

Not just your GitHub. Your texts, your mail, your review comments, what you watched, what you saved, what you liked, every prompt you ever typed. That's where your taste and judgment live, and an agent that can search it stops guessing what you mean.

```
your accounts    GitHub, Claude Code, Codex, …
     │  fetch: one dated snapshot per source per day
data/raw/        read-only, kept forever, never in git
     │  build: replay every snapshot, redact as you go
commonplace.db   things · events · links · search
     │
commonplace      CLI ── search · timeline · show · stats
     └── mcp     Claude Code, Codex, Claude Desktop, any MCP client
```

It's a template you own, not an app you install: about 1,300 lines of TypeScript plus one file per source, no runtime dependencies (Bun and its built-in SQLite), in your own repo next to your own data. Read it in an afternoon. Change anything.

- **You choose what agents see over MCP.** Your data lives in `data/`, never in git. Agents never open the database: the MCP server shows only the sources you list, and `redact` rules keep rows out of the archive entirely. The CLI shows every source to whoever runs it.
- **It keeps itself current.** `commonplace sync` takes one snapshot per source per day and rebuilds. On a Mac, `commonplace install` runs it at login, whenever a message arrives, and whenever an agent session ends.
- **One shape for everything.** Every source becomes things, events and links, with IDs derived from content, so the same page saved in two apps is one record.
- **Agents write the sources.** The `add-source` skill has your agent write one for any app or export you have.

## Sources

### Built in

| source     | what                                                                                | needs                                      |
| ---------- | ----------------------------------------------------------------------------------- | ------------------------------------------ |
| `github`   | your pull requests and issues, your reviews and review comments, stars, and commits | `gh` signed in                             |
| `prompts`  | every prompt you typed into Claude Code, Codex and Pi, and sent them from chat apps | nothing, read from disk                    |
| `imessage` | every iMessage and SMS conversation                                                 | macOS, Full Disk Access                    |
| `x`        | your bookmarks with their folders, likes, posts and replies                         | a browser on your machine, [signed in](#x) |

### From an export

Unzip it into `data/raw/<source>/<YYYY-MM-DD>/` and the next sync reads it. Drop in a newer one whenever you like.

| source      | what                                                                   | the export                                                        |
| ----------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `takeout`   | searches, YouTube watches, comments and playlists, Maps places, Chrome | [Google Takeout](https://takeout.google.com), My Activity as JSON |
| `x-archive` | every post (with long ones in full), like, follow, DM and Grok chat    | X → Settings → Your account → Download an archive                 |
| `raindrop`  | bookmarks, collections, tags and highlights                            | Raindrop → Settings → Backups, the CSV                            |

`prompts({ ssh: "you@server" })` reads another machine's sessions too, as a source of its own.

### X

X's archive is a manual download that leaves out bookmarks, and its API is paid. So `x` reads your account the way x.com does, from a browser on your machine signed in as you, through [agent-browser](https://github.com/vercel-labs/agent-browser). It keeps each page as x.com sent it and takes only what's new.

Sign in once, then close the window:

```sh
npm i -g agent-browser && agent-browser install
agent-browser --session x --restore --headed open https://x.com/login
```

Then add it to `sources` in `commonplace.config.ts`:

```ts
import { x } from "./sources/x.ts";

sources: [github(), prompts(), x()],
```

If X signs the session out, the next sync fails with the sign-in command.

### One ask away

Anything with an export, a local database, an API or a CLI. Ask your agent, _"add my Obsidian vault to commonplace"_, and the [`add-source`](skills/add-source/SKILL.md) skill has it write the source: one file, usually under 80 lines. Any agent that reads files can use it, not just Claude Code.

- **Browsing:** Chrome, Safari, Firefox, Edge, Arc or any other browser's history
- **Notes:** Obsidian or any folder of markdown, Apple Notes
- **Mail and calendar:** Gmail via Takeout, any `.ics`
- **Chat:** Slack, Discord and Telegram exports
- **Reading and media:** Readwise, Goodreads, Letterboxd, Spotify, Reddit exports

## Start

You need [Bun](https://bun.sh) and, for the GitHub source, the [GitHub CLI](https://cli.github.com) signed in.

```sh
gh repo create my-commonplace --template AVGVSTVS96/commonplace --private --clone
cd my-commonplace
bun install
bun add -g "$PWD"     # links `commonplace` into `bun pm bin -g`, which must be on your PATH
commonplace sync
commonplace install   # on a Mac: keep it current on its own
```

It's a private copy, not a fork: forks of public repos are public, and your config and sources say a lot about you. To take updates:

```sh
git remote add upstream https://github.com/AVGVSTVS96/commonplace
git pull upstream main --allow-unrelated-histories   # the first time; plain `git pull upstream main` after
```

Then connect your agents:

```sh
# Claude Code: MCP server, add-source skill, sync when a session ends
/plugin marketplace add AVGVSTVS96/commonplace
/plugin install commonplace@commonplace

# Codex: MCP server, and this command in the Stop hook in ~/.codex/hooks.json to sync when a turn ends
codex mcp add commonplace -- commonplace mcp
launchctl kickstart gui/$(id -u)/dev.commonplace.sync

# anything else that speaks MCP
command: commonplace   args: ["mcp"]
```

Then ask something only your history can answer: _"What was that restaurant someone texted me about last spring?"_, _"What was I working on the week before my last trip?"_, _"Have I asked an agent about this before?"_

## Use

```
commonplace search <query>     full-text search (FTS5 syntax works too)
commonplace timeline           what you did, newest first  --since --until --verb
commonplace show <id>          one record with its events and links
commonplace stats              sources, freshness, kinds, verbs
commonplace sync               snapshot every source due today, then rebuild if anything is new
commonplace install            sync on its own: at login, on new messages, when a hook kicks it (macOS)
commonplace build              rebuild the database from data/raw
commonplace mcp                MCP server on stdio  --sources a,b to narrow what a client sees
commonplace sql <query>        read-only SQL, local only
commonplace root               where this commonplace lives
```

`--json` for machine-readable output, `--limit n` for how many.

The MCP server has four tools, `search`, `timeline`, `show` and `stats`, over the same store as the CLI. An agent calls `stats` first to learn what it can ask for.

## Configure

`commonplace.config.ts` is yours to edit:

```ts
export default defineConfig({
  // strongest first: when two sources disagree on a field, the earlier one wins
  sources: [github(), prompts(), imessage()],

  // what MCP clients may read; `commonplace mcp --sources github` narrows it per client
  // messages stay local until you add "imessage" here
  mcp: ["github", "prompts"],

  // rows that never reach the archive
  redact: (row) => row.type === "event" && /\b(password|api[_ -]?key|secret)\b/i.test(row.text ?? ""),
});
```

Some sources take options. `imessage({ drop: (message, chat) => … })` keeps matching messages out of the snapshot itself, so they never exist anywhere but Messages.

## How it works

- **`data/raw/<source>/<date>/`** is the source of truth, kept forever. Each fetch writes through a `.partial` directory and makes the snapshot read-only, so a crash never leaves half of one. A second snapshot of one day, like one merged in from another archive, is `<date>.<label>`.
- **`commonplace.db`** is SQLite: `things`, `events`, `links`, a `snapshots` log, and a full-text `search` index that matches word forms (trip finds trips). Every build starts empty and replays every snapshot, so the same `raw/` always gives the same database, and a fixed source rebuilds years of history.
- **Merging** needs no fuzzy matching. Things merge by ID; per field, the strongest source's newest value wins and nulls never erase. Once-only events (`saved`, `liked`, …) merge across sources and keep every collection.
- **Visibility** is all-or-nothing per row: a reader sees a row only if it may read every source that contributed to it, so a hidden source can't leak through a merge.
- **A source** is one file with two halves: `fetch` copies what the service gives into today's snapshot, and `rows` turns one snapshot into things, events and links, reading nothing else.

```
src/schema.ts     things, events, links; verbs
src/source.ts     defineSource and the read helpers
src/build.ts      replays every snapshot; the only writer
src/store.ts      every read, filtered by what the reader may see
src/sync.ts       daily snapshots on demand, then the build
src/install.ts    the LaunchAgent that runs sync on its own
src/cli.ts        one door
src/mcp.ts        the other
sources/*.ts      one file per source
```

## Next

- Remote MCP for ChatGPT and claude.ai on the web
- Mail, calendars and browser history
- Yours, if you send one back

MIT
