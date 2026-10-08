# commonplace

A personal data archive: dated snapshots in `data/raw/` → one importer per source → `data/commonplace.db`, read through the `commonplace` CLI and MCP server. See README.md.

## Check

```sh
bun run check   # typecheck + lint + format + tests; must pass
bun run fix     # autofix lint and format
```

## Where things go

```
src/schema.ts           things, events, links; verbs; thing() event() link() iso() urlId()
src/source.ts           defineSource, Snapshot, read helpers (json, jsonl, lines)
src/build.ts            replays every snapshot into the database; the only writer
src/store.ts            every read query, filtered by which sources the reader may see
src/sync.ts             daily snapshots on demand, then the build
src/mcp.ts, src/cli.ts  the two doors; both go through store.ts
sources/<name>.ts       one file per source: fetch + rows
commonplace.config.ts   which sources, their rank, MCP exposure, redaction
```

## Rules

- `data/` is the user's private data. Never commit it, and never edit or delete anything in `data/raw/`.
- Agents read the archive only through the CLI or MCP, never the database file.
- To add a source, follow `skills/add-source/SKILL.md`.
