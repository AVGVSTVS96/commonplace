#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

import config from "../commonplace.config.ts";
import pkg from "../package.json";
import { build, paths, report } from "./build.ts";
import { serve } from "./mcp.ts";
import { type Hit, open } from "./store.ts";
import { sync } from "./sync.ts";

const usage = `commonplace: your personal data kit for agents

  commonplace search <query>     full-text search (FTS5 syntax works too)
  commonplace timeline           what you did, newest first  --since --until --verb
  commonplace show <id>          one record with its events and links
  commonplace stats              sources, freshness, kinds, verbs
  commonplace sync               snapshot every source due today, then rebuild
  commonplace build              rebuild the database from data/raw
  commonplace mcp                MCP server on stdio  --sources a,b to narrow what a client sees
  commonplace sql <query>        read-only SQL, local only
  commonplace root               where this commonplace lives

  --json      machine-readable output
  --limit n   how many results`;

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const data = process.env["COMMONPLACE_DATA"] ?? `${root}/data`;
const { db } = paths(data);
const everything = config.sources.map(({ name }) => name);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "boolean" },
    limit: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    verb: { type: "string" },
    sources: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, ...rest] = positionals;
const limit = values.limit === undefined ? undefined : Number(values.limit);

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const store = (sources: ReadonlyArray<string>) =>
  existsSync(db) ? open(db, sources) : fail("No archive yet. Run `commonplace sync` first.");

const lines = (hits: ReadonlyArray<Hit>): string =>
  hits
    .map((hit) =>
      [
        `${(hit.at ?? "").slice(0, 10).padEnd(10)}  ${hit.what.padEnd(10)}  ${hit.id}${hit.title === null ? "" : `  (${hit.title})`}`,
        ...(hit.text === null ? [] : [`            ${hit.text.replaceAll(/\s+/g, " ")}`]),
      ].join("\n"),
    )
    .join("\n");

const print = (value: unknown, text: () => string) =>
  console.log(values.json === true ? JSON.stringify(value, null, 1) : text());

switch (values.help === true ? "help" : (command ?? "help")) {
  case "search": {
    const hits = store(everything).search(rest.join(" "), limit);
    print(hits, () => lines(hits));
    break;
  }
  case "timeline": {
    const hits = store(everything).timeline({ ...values, limit });
    print(hits, () => lines(hits));
    break;
  }
  case "show": {
    const record = store(everything).show(rest[0] ?? fail("Usage: commonplace show <id>"));
    console.log(JSON.stringify(record ?? fail(`No record with id ${rest[0]}`), null, 1));
    break;
  }
  case "stats": {
    const stats = store(everything).stats();
    print(stats, () =>
      [
        ...stats.sources.map(
          (s) =>
            `${s.source.padEnd(14)} latest ${s.latest}  ${s.snapshots} snapshot(s)  ${s.things} things  ${s.events} events${s.failed > 0 ? `  ${s.failed} failed` : ""}`,
        ),
        `kinds  ${stats.kinds.map((k) => `${k.kind} ${k.n}`).join(" · ")}`,
        `verbs  ${stats.verbs.map((v) => `${v.verb} ${v.n}`).join(" · ")}`,
      ].join("\n"),
    );
    break;
  }
  case "sync": {
    const synced = await sync(config, data, (line) => console.error(line));
    if (synced === null) {
      console.error("Another sync is running.");
      break;
    }
    console.log(
      synced.built !== null
        ? report(synced.built)
        : synced.failed.length > 0
          ? `Nothing new. Failed: ${synced.failed.map((f) => f.source).join(", ")}`
          : "Every source is up to date for today.",
    );
    process.exitCode =
      synced.failed.length > 0 || synced.built?.outcomes.some((o) => o.error !== null) ? 1 : 0;
    break;
  }
  case "build": {
    const built = await build(config, data);
    console.log(report(built));
    process.exitCode = built.outcomes.some((o) => o.error !== null) ? 1 : 0;
    break;
  }
  case "mcp": {
    const sources = values.sources?.split(",").map((s) => s.trim()) ?? config.mcp;
    await serve(store(sources.filter((s) => config.mcp.includes(s))), pkg.version);
    break;
  }
  case "sql": {
    if (!existsSync(db)) {
      fail("No archive yet. Run `commonplace sync` first.");
    }
    const rows = new Database(db, { readonly: true }).query(rest.join(" ")).all();
    console.log(JSON.stringify(rows, null, 1));
    break;
  }
  case "root":
    console.log(root);
    break;
  default:
    console.log(usage);
    process.exitCode = command === undefined || values.help === true ? 0 : 1;
}
