import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { event, iso, thing } from "../src/schema.ts";
import type { Extra } from "../src/schema.ts";
import { defineSource, jsonl, lines, writeJsonl } from "../src/source.ts";

export interface Prompt {
  readonly agent: "claude" | "codex" | "pi";
  readonly session: string;
  readonly ts: string;
  readonly cwd: string | null;
  readonly project: string | null;
  readonly model: string | null;
  readonly text: string;
  readonly channel: { readonly source: string; readonly user: string | null } | null;
}

const injected = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<task-notification>",
  "<system-reminder>",
  "<user-memory-input>",
  "<environment_context>",
  "<user_instructions>",
  "<user_shell_environment>",
  "<user_shell_command>",
  "<external_",
  "<t3_code_instructions>",
  "# AGENTS.md instructions",
  "## My request for Codex:",
  "Caveat: The messages below",
  "[Request interrupted",
  "This session is being continued",
];

const injectedByPi = [
  "<skill name=",
  "<files>",
  "<file ",
  "<command-",
  "The conversation history before this point was compacted",
  "The following is a summary of a branch",
  "The following files were included as context",
  "Ran `",
];

const typed = (text: string, also: readonly string[] = []): boolean =>
  text !== "" && ![...injected, ...also].some((prefix) => text.startsWith(prefix));

interface Part {
  readonly type?: string;
  readonly text?: string;
}

type Content = string | readonly Part[];

interface Entry {
  readonly type?: string;
  readonly timestamp?: string;
  readonly id?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly isSidechain?: boolean;
  readonly isMeta?: boolean;
  readonly entrypoint?: string;
  readonly origin?: { readonly kind?: string };
  readonly message?: {
    readonly role?: string;
    readonly model?: string;
    readonly content?: Content;
  };
  readonly payload?: {
    readonly type?: string;
    readonly role?: string;
    readonly id?: string;
    readonly cwd?: string;
    readonly model?: string;
    readonly source?: unknown;
    readonly thread_source?: unknown;
    readonly message?: Content;
    readonly content?: Content;
  };
}

const isSubagent = (origin: unknown): origin is { readonly subagent: unknown } =>
  typeof origin === "object" && origin !== null && "subagent" in origin;

const isParts = (content: Content | undefined): content is readonly Part[] =>
  Array.isArray(content);

const textOf = (content: Content | undefined, types: readonly string[]): string | null => {
  if (!isParts(content)) {
    return content ?? null;
  }

  if (content.some((part) => part.type === "tool_result")) {
    return null;
  }

  return content
    .flatMap((part) =>
      types.includes(part.type ?? "") && part.text !== undefined ? [part.text] : [],
    )
    .join("\n");
};

const parse = (line: string): Entry | null => {
  try {
    // SAFETY: every field of Entry is optional, and each read below allows for a log that lacks it.
    return JSON.parse(line) as Entry;
  } catch {
    return null;
  }
};

const touched = async (dir: string, pattern: string, since: string | null): Promise<string[]> => {
  const files = await Array.fromAsync(
    new Bun.Glob(pattern).scan({ cwd: dir, absolute: true }),
  ).catch(() => []);

  return files
    .filter((file) => since === null || statSync(file).mtime.toLocaleDateString("sv") >= since)
    .toSorted();
};

const projectOf = (cwd: string | null): string | null => {
  if (cwd === null) {
    return null;
  }

  if (cwd === homedir()) {
    return "~";
  }

  return path.basename(cwd) || cwd;
};

const channelBlock =
  /<channel source="(?<source>[^"]+)"(?<attributes>[^>]*)>\n?(?<inner>[\s\S]*?)\n?<\/channel>/gu;

const channelMessages = (text: string) =>
  text.startsWith("<channel source=")
    ? Array.from(
        text.matchAll(channelBlock),
        ({ groups: { source = "", attributes = "", inner = "" } = {} }) => ({
          channel: {
            source,
            user: /\buser="(?<user>[^"]*)"/u.exec(attributes)?.groups?.["user"] ?? null,
          },
          text: inner.trim(),
        }),
      )
    : null;

const claudeTurn = (entry: Entry, file: string): Omit<Prompt, "model">[] => {
  const raw = entry.type === "user" ? textOf(entry.message?.content, ["text"])?.trim() : undefined;

  const origin = entry.origin?.kind;
  const ts = entry.timestamp;

  const typedHere =
    entry.isMeta !== true &&
    (origin === undefined ? entry.entrypoint !== "sdk-cli" : origin === "human");

  if (
    raw === undefined ||
    raw === null ||
    ts === undefined ||
    !(origin === undefined || origin === "channel" || typedHere)
  ) {
    return [];
  }

  const messages = channelMessages(raw) ?? (typedHere ? [{ channel: null, text: raw }] : []);
  const cwd = entry.cwd ?? null;

  return messages.flatMap((message) =>
    typed(message.text)
      ? [
          {
            agent: "claude" as const,
            session: entry.sessionId ?? path.basename(file, ".jsonl"),
            ts,
            cwd,
            project: projectOf(cwd),
            ...message,
          },
        ]
      : [],
  );
};

const claude = async function* claude(since: string | null): AsyncGenerator<Prompt> {
  const dir = `${process.env["CLAUDE_CONFIG_DIR"] ?? `${homedir()}/.claude`}/projects`;

  for (const file of await touched(dir, "*/*.jsonl", since)) {
    const pending: Omit<Prompt, "model">[] = [];
    let model: string | null = null;

    for await (const line of lines(file)) {
      const entry = parse(line);
      const said = entry?.message?.model;

      if (entry === null || entry.isSidechain === true) {
        continue;
      }

      if (entry.type === "assistant" && said !== undefined && said !== "<synthetic>") {
        model = said;

        for (const prompt of pending.splice(0)) {
          yield { ...prompt, model };
        }
      } else {
        pending.push(...claudeTurn(entry, file));
      }
    }

    for (const prompt of pending) {
      yield { ...prompt, model };
    }
  }
};

const codex = async function* codex(since: string | null): AsyncGenerator<Prompt> {
  const home = process.env["CODEX_HOME"] ?? `${homedir()}/.codex`;

  const files = [
    ...(await touched(`${home}/sessions`, "**/*.jsonl", since)),
    ...(await touched(`${home}/archived_sessions`, "**/*.jsonl", since)),
  ];

  for (const file of files) {
    const entries = await Array.fromAsync(lines(file), parse);
    const meta = entries.find((e) => e?.type === "session_meta")?.payload;
    const origin = meta?.source ?? meta?.thread_source;

    if (meta === undefined || origin === "exec" || isSubagent(origin)) {
      continue;
    }

    const models = entries.map((e) =>
      e?.type === "turn_context" ? (e.payload?.model ?? null) : null,
    );

    const modelAfter = (i: number): string | null =>
      models.slice(i).find((m) => m !== null) ?? models.findLast((m) => m !== null) ?? null;

    const events = entries.flatMap((e, i) =>
      e?.type === "event_msg" && e.payload?.type === "user_message"
        ? [{ i, ts: e.timestamp, text: textOf(e.payload.message, ["input_text", "text"]) }]
        : [],
    );

    const turns =
      events.length > 0
        ? events
        : entries.flatMap((e, i) =>
            e?.type === "response_item" &&
            e.payload?.type === "message" &&
            e.payload.role === "user"
              ? [{ i, ts: e.timestamp, text: textOf(e.payload.content, ["input_text", "text"]) }]
              : [],
          );

    for (const { i, ts, text } of turns) {
      const trimmed = text?.trim() ?? "";

      if (ts !== undefined && typed(trimmed)) {
        const cwd = meta.cwd ?? null;

        yield {
          agent: "codex",
          session: meta.id ?? path.basename(file, ".jsonl"),
          ts,
          cwd,
          project: projectOf(cwd),
          model: modelAfter(i),
          text: trimmed,
          channel: null,
        };
      }
    }
  }
};

const pi = async function* pi(since: string | null): AsyncGenerator<Prompt> {
  const home = process.env["PI_CODING_AGENT_DIR"] ?? `${homedir()}/.pi/agent`;

  for (const file of await touched(`${home}/sessions`, "*/*.jsonl", since)) {
    const entries = await Array.fromAsync(lines(file), parse);
    const session = entries.find((e) => e?.type === "session");

    const replies = entries.map((e) =>
      e?.type === "message" && e.message?.role === "assistant" ? (e.message.model ?? null) : null,
    );

    for (const [i, e] of entries.entries()) {
      const text =
        e?.type === "message" && e.message?.role === "user"
          ? (textOf(e.message.content, ["text"])?.trim() ?? "")
          : "";

      if (
        e?.timestamp !== undefined &&
        typed(text, injectedByPi) &&
        !text.slice(0, 600).includes("References are relative to ")
      ) {
        const cwd = session?.cwd ?? null;

        yield {
          agent: "pi",
          session: session?.id ?? path.basename(file, ".jsonl"),
          ts: e.timestamp,
          cwd,
          project: projectOf(cwd),
          model: replies.slice(i).find((m) => m !== null) ?? null,
          text,
          channel: null,
        };
      }
    }
  }
};

const scan = async (since: string | null): Promise<Prompt[]> =>
  [
    ...(await Array.fromAsync(claude(since))),
    ...(await Array.fromAsync(codex(since))),
    ...(await Array.fromAsync(pi(since))),
  ]
    .filter((p) => since === null || p.ts >= since)
    .toSorted((a, b) => a.ts.localeCompare(b.ts));

if (import.meta.main) {
  const since = process.env["COMMONPLACE_SINCE"] ?? "";

  for (const prompt of await scan(since === "" ? null : since)) {
    process.stdout.write(`${JSON.stringify(prompt)}\n`);
  }
}

const scanOver = async (host: string, since: string | null): Promise<Prompt[]> => {
  const build = await Bun.build({ entrypoints: [import.meta.path], target: "bun" });
  const [bundle] = build.outputs;

  const ssh = Bun.spawn(
    ["ssh", "-o", "BatchMode=yes", host, `env COMMONPLACE_SINCE=${since ?? ""} bun run -`],
    {
      stdin: new Blob([(await bundle?.text()) ?? ""]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [out, err, code] = await Promise.all([
    new Response(ssh.stdout).text(),
    new Response(ssh.stderr).text(),
    ssh.exited,
  ]);

  if (code !== 0) {
    throw new Error(`prompts: ssh ${host} exited ${code}: ${err.trim()}`);
  }

  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const prompt: unknown = JSON.parse(line);

      // SAFETY: the remote ran this file's own scan, which prints one Prompt per line.
      return prompt as Prompt;
    });
};

interface Legacy {
  readonly source?: Prompt["agent"];
  readonly sessionId?: string;
  readonly agent?: Prompt["agent"] | "claude-code";
  readonly session?: string;
  readonly ts: string;
  readonly cwd: string | null;
  readonly project?: string | null;
  readonly model?: string | null;
  readonly file?: string;
  readonly text: string;
  readonly channel?: Prompt["channel"];
}

export interface PromptsOptions {
  readonly ssh?: string;
}

export const prompts = ({ ssh }: PromptsOptions = {}) =>
  defineSource({
    name: ssh === undefined ? "prompts" : `prompts-${ssh.replace(/^.*@/u, "")}`,

    fetch: async ({ dir, since }) => {
      const dayBeforeSince =
        since === null ? null : new Date(Date.parse(since) - 86_400_000).toISOString().slice(0, 10);

      await writeJsonl(
        `${dir}/prompts.jsonl`,
        ssh === undefined ? await scan(dayBeforeSince) : await scanOver(ssh, dayBeforeSince),
      );
    },

    async *rows({ dir }) {
      const seen = new Set<string>();

      for await (const line of jsonl<Legacy>(`${dir}/prompts.jsonl`)) {
        const agent =
          line.source ?? (line.agent === "claude-code" ? "claude" : (line.agent ?? "claude"));

        const id = `session:${agent}:${line.sessionId ?? line.session}`;

        if (!seen.has(id)) {
          seen.add(id);
          yield thing({
            id,
            kind: "session",
            title: line.project ?? (line.cwd === null ? null : path.basename(line.cwd)),
            extra: { agent },
          });
        }

        const extra: Extra = { cwd: line.cwd, model: line.model ?? null };

        if (line.file !== undefined) {
          extra["file"] = line.file;
        }

        if (line.channel !== undefined && line.channel !== null) {
          extra["channel"] = line.channel.source;
          extra["from"] = line.channel.user;
        }

        yield event({
          verb: "prompted",
          thing: id,
          ts: iso(line.ts),
          text: line.text.trim(),
          extra,
        });
      }
    },
  });
