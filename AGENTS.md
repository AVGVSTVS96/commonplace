# commonplace

A personal data archive: dated snapshots in `data/raw/`, replayed into `data/commonplace.db`, read through the `commonplace` CLI and MCP server. README.md has the rest.

## Check

```sh
bun run check   # typecheck, lint, format, tests; must pass
bun run fix     # autofix lint and format
```

## Map

```
src/schema.ts           things, events, links, verbs; thing() event() link() iso() urlRef() digest()
src/source.ts           defineSource and the readers: json, jsonl, lines, csv
src/build.ts            replays every snapshot into the database; the only writer
src/store.ts            every read, filtered by the sources the reader may see
src/sync.ts             today's snapshots, then a build if anything is new
src/install.ts          the macOS LaunchAgent, and the fixed binary (src/launcher.ts) it runs
src/cli.ts, src/mcp.ts  the two doors, both through store.ts
sources/<name>.ts       one file per source: fetch and rows
commonplace.config.ts   which sources, their rank, MCP exposure, redaction
```

## Rules

- `data/` is the user's private data: never commit it, and never edit or delete anything in `data/raw/`.
- Read the archive only through the CLI or MCP, never the database file.
- To add a source, follow `skills/add-source/SKILL.md`.
- Public copy, examples and defaults are for anyone who copies the template, not the maintainer's setup: every browser, every mail provider, live services only.
