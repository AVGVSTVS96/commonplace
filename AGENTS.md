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
src/store.ts            every read
src/sync.ts             today's snapshots, then a build if anything is new
src/install.ts          the macOS LaunchAgent, and the fixed binary (src/launcher.ts) it runs
src/cli.ts, src/mcp.ts  the two doors, both through store.ts
sources/<name>.ts       one file per source: fetch and rows
commonplace.config.ts   which sources, their rank, redaction
```

## Rules

| Rule                                                                   | Enforced by                                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| No comments, no `any`, no unchecked type assertions                    | oxlint (`oxlint.config.ts`), in `check`                          |
| `build.ts` is the only writer, `store.ts` the only reader              | the map above; `test/archive.test.ts`                            |
| `data/` is never committed                                             | `.gitignore`                                                     |
| Never edit or delete anything in `data/raw/`                           | judgment: it's the user's only copy                              |
| Read the archive through the CLI or MCP, never the database file       | judgment                                                         |
| A new source follows `skills/add-source/SKILL.md`                      | judgment                                                         |
| Public copy, examples and defaults suit anyone who copies the template | judgment: every browser, every mail provider, live services only |
