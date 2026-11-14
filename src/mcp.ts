import { createInterface } from "node:readline";

import { recall } from "./recall.ts";
import type { Json } from "./schema.ts";
import type { Store } from "./store.ts";

const tools = [
  {
    name: "search",
    description:
      'Full-text search over the records in the user\'s archive (SQLite FTS5: words, "exact phrases", prefix*, OR, NOT). Matches word forms (trip finds trips), not meanings, so try synonyms when results are thin. Returns citable ids; pass one to show for the whole record.',
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
    name: "recall",
    description:
      "Full-text search over the raw transcripts of every Claude Code, Codex and Pi session on this machine: what was typed, what the agent said, the tools it called and what they returned. Same query syntax as search. Returns pointers, one per session: the file and line of the best match, with a short excerpt. Open that line (sed -n '<line>p' <file>, or a few lines around it) before you claim what happened.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        since: { type: "string", description: "ISO date or time, inclusive" },
        until: { type: "string", description: "ISO date or time, exclusive" },
        limit: { type: "number", description: "Default 10" },
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

type Args = Readonly<Record<string, Json>>;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON.stringify takes any value
const text = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 1) }],
});

const call = async (store: Store, sessions: string, name: string, args: Args) => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- tool arguments are the client's JSON, read here
  const string = (key: string) => (typeof args[key] === "string" ? args[key] : undefined);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- tool arguments are the client's JSON, read here
  const number = (key: string) => (typeof args[key] === "number" ? args[key] : undefined);

  switch (name) {
    case "search": {
      return text(store.search(string("query") ?? "", number("limit")));
    }

    case "recall": {
      return text(
        await recall(sessions, string("query") ?? "", {
          since: string("since"),
          until: string("until"),
          limit: number("limit"),
        }),
      );
    }

    case "timeline": {
      return text(
        store.timeline({
          since: string("since"),
          until: string("until"),
          verb: string("verb"),
          limit: number("limit"),
        }),
      );
    }

    case "show": {
      return text(store.show(string("id") ?? "") ?? `No record with id ${string("id")}`);
    }

    case "stats": {
      return text(store.stats());
    }

    default: {
      return { ...text(`Unknown tool ${name}`), isError: true };
    }
  }
};

interface Request {
  readonly id?: string | number;
  readonly method: string;
  readonly params?: {
    readonly protocolVersion?: string;
    readonly name?: string;
    readonly arguments?: Args;
  };
}

type Reply =
  | { readonly result: object }
  | { readonly error: { readonly code: number; readonly message: string } };

const send = (id: Request["id"] | null, reply: Reply) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...reply })}\n`);

const parse = (line: string): Request | null => {
  try {
    // SAFETY: a JSON-RPC 2.0 request; every read below still holds when a client sends other JSON.
    return JSON.parse(line) as Request;
  } catch {
    return null;
  }
};

export const serve = async (
  latest: () => Store,
  version: string,
  sessions: string,
): Promise<void> => {
  const result = async (request: Request): Promise<object | null> => {
    switch (request.method) {
      case "initialize": {
        return {
          protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "commonplace", version },
        };
      }

      case "ping": {
        return {};
      }

      case "tools/list": {
        return { tools };
      }

      case "tools/call": {
        return await call(
          latest(),
          sessions,
          String(request.params?.name),
          request.params?.arguments ?? {},
        );
      }

      default: {
        return null;
      }
    }
  };

  for await (const line of createInterface({ input: process.stdin })) {
    if (line.trim() === "") {
      continue;
    }

    const request = parse(line);

    if (request === null) {
      send(null, { error: { code: -32_700, message: "Parse error" } });
      continue;
    }

    if (request.id === undefined) {
      continue;
    }

    try {
      const answer = await result(request);

      send(
        request.id,
        answer === null
          ? { error: { code: -32_601, message: `Method not found: ${request.method}` } }
          : { result: answer },
      );
    } catch (error) {
      send(request.id, { result: { ...text(String(error)), isError: true } });
    }
  }
};
