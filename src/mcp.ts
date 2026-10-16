import { createInterface } from "node:readline";

import type { Store } from "./store.ts";

const tools = [
  {
    name: "search",
    description:
      'Full-text search over everything the user has made, saved and said (SQLite FTS5: words, "exact phrases", prefix*, OR, NOT). Matches word forms (trip finds trips), not meanings, so try synonyms when results are thin. Returns citable ids; pass one to show for the whole record.',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Default 20" },
      },
      required: ["query"],
    },
  },
  {
    name: "timeline",
    description:
      "What the user did, newest first: events like prompted, committed, opened, saved, liked, posted. Filter by verb and an ISO date range.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO date or time, inclusive" },
        until: { type: "string", description: "ISO date or time, exclusive" },
        verb: { type: "string" },
        limit: { type: "number", description: "Default 50" },
      },
    },
  },
  {
    name: "show",
    description:
      "One record by id: a thing with its events and links, or an event with full text and its thing.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "stats",
    description:
      "What the archive holds and how fresh it is: each source's latest snapshot and counts, and every kind and verb in use. Call it first to learn what to ask for.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

type Args = Record<string, unknown>;

const text = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 1) }],
});

const call = (store: Store, name: string, args: Args) => {
  const string = (key: string) => (typeof args[key] === "string" ? args[key] : undefined);
  const number = (key: string) => (typeof args[key] === "number" ? args[key] : undefined);

  switch (name) {
    case "search":
      return text(store.search(string("query") ?? "", number("limit")));
    case "timeline":
      return text(
        store.timeline({
          since: string("since"),
          until: string("until"),
          verb: string("verb"),
          limit: number("limit"),
        }),
      );
    case "show":
      return text(store.show(string("id") ?? "") ?? `No visible record with id ${string("id")}`);
    case "stats":
      return text(store.stats());
    default:
      return { ...text(`Unknown tool ${name}`), isError: true };
  }
};

interface Request {
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Args;
}

const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

const parse = (line: string): Request | null => {
  try {
    return JSON.parse(line) as Request;
  } catch {
    return null;
  }
};

/** A Model Context Protocol server over stdio: newline-delimited JSON-RPC, tools only. */
export const serve = async (latest: () => Store, version: string): Promise<void> => {
  const result = (request: Request): object | null => {
    switch (request.method) {
      case "initialize":
        return {
          protocolVersion: request.params?.["protocolVersion"] ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "commonplace", version },
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools };
      case "tools/call":
        return call(
          latest(),
          String(request.params?.["name"]),
          (request.params?.["arguments"] ?? {}) as Args,
        );
      default:
        return null;
    }
  };

  for await (const line of createInterface({ input: process.stdin })) {
    if (line.trim() === "") {
      continue;
    }

    const request = parse(line);

    if (request === null) {
      send({ id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }

    if (request.id === undefined) {
      continue;
    }

    try {
      const answer = result(request);
      send(
        answer === null
          ? {
              id: request.id,
              error: { code: -32601, message: `Method not found: ${request.method}` },
            }
          : { id: request.id, result: answer },
      );
    } catch (error) {
      send({ id: request.id, result: { ...text(String(error)), isError: true } });
    }
  }
};
