import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";

import { event, iso, thing } from "../src/schema.ts";
import { defineSource, jsonl, lines, writeJsonl } from "../src/source.ts";

interface Prompt {
  readonly agent: "claude-code" | "codex";
  readonly session: string;
  readonly ts: string;
  readonly cwd: string | null;
  readonly text: string;
}

/** Text the agent harness puts in the user's turn. None of it was typed by you. */
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
  "<user_shell_command>",
  "<external_",
  "# AGENTS.md instructions",
  "Caveat: The messages below",
  "[Request interrupted",
  "This session is being continued",
];

const typed = (text: string): boolean =>
  text.trim() !== "" && !injected.some((p) => text.trimStart().startsWith(p));

type Part = { readonly type?: string; readonly text?: string };

const textOf = (content: unknown): string | null =>
  typeof content === "string"
    ? content
    : Array.isArray(content) && !content.some((part: Part) => part.type === "tool_result")
      ? content
          .filter(
            (part: Part) => ["text", "input_text"].includes(part.type ?? "") && typeof part.text === "string",
          )
          .map((part: Part) => part.text)
          .join("\n")
      : null;

/** Session files untouched since the last snapshot can't hold new prompts. */
const touched = async (dir: string, since: string | null): Promise<Array<string>> => {
  const files = await Array.fromAsync(new Bun.Glob("**/*.jsonl").scan({ cwd: dir, absolute: true }));

  return files.filter((file) => since === null || statSync(file).mtime.toLocaleDateString("sv") >= since);
};

const parse = (line: string): Record<string, any> | null => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

async function* claudeCode(since: string | null): AsyncGenerator<Prompt> {
  const dir = `${process.env["CLAUDE_CONFIG_DIR"] ?? `${homedir()}/.claude`}/projects`;

  for (const file of await touched(dir, since)) {
    if (file.includes("/subagents/")) {
      continue;
    }

    for await (const line of lines(file)) {
      const entry = parse(line);
      const text =
        entry?.["type"] === "user" && !entry["isMeta"] && !entry["isSidechain"]
          ? textOf(entry["message"]?.content)
          : null;

      if (entry !== null && text !== null && typed(text)) {
        yield {
          agent: "claude-code",
          session: entry["sessionId"],
          ts: entry["timestamp"],
          cwd: entry["cwd"] ?? null,
          text,
        };
      }
    }
  }
}

async function* codex(since: string | null): AsyncGenerator<Prompt> {
  const dir = `${process.env["CODEX_HOME"] ?? `${homedir()}/.codex`}/sessions`;

  for (const file of await touched(dir, since)) {
    const entries = (await Array.fromAsync(lines(file))).map(parse);
    const meta = entries.find((e) => e?.["type"] === "session_meta")?.["payload"];

    if (meta === undefined || typeof (meta.source ?? meta.thread_source) === "object") {
      continue;
    }

    const events = entries.filter(
      (e) => e?.["type"] === "event_msg" && e["payload"]?.type === "user_message",
    );
    const turns =
      events.length > 0
        ? events.map((e) => ({ ts: e?.["timestamp"], text: textOf(e?.["payload"].message) }))
        : entries
            .filter((e) => e?.["type"] === "response_item" && e["payload"]?.role === "user")
            .map((e) => ({ ts: e?.["timestamp"], text: textOf(e?.["payload"].content) }));

    for (const { ts, text } of turns) {
      if (text !== null && typed(text)) {
        yield { agent: "codex", session: meta.id, ts, cwd: meta.cwd ?? null, text };
      }
    }
  }
}

/** Every prompt you typed into Claude Code and Codex, read from their local session logs. */
export default defineSource({
  name: "prompts",

  /** Starts a day before the last snapshot so no timezone can open a gap; repeats merge away by ID. */
  fetch: async ({ dir, since }) => {
    const from = since === null ? null : new Date(Date.parse(since) - 86_400_000).toISOString().slice(0, 10);
    const prompts = [...(await Array.fromAsync(claudeCode(from))), ...(await Array.fromAsync(codex(from)))];

    await writeJsonl(
      `${dir}/prompts.jsonl`,
      prompts.filter((p) => from === null || p.ts >= from).toSorted((a, b) => a.ts.localeCompare(b.ts)),
    );
  },

  rows: async function* ({ dir }) {
    for await (const prompt of jsonl<Prompt>(`${dir}/prompts.jsonl`)) {
      const id = `session:${prompt.agent}:${prompt.session}`;

      yield thing({
        id,
        kind: "session",
        title: prompt.cwd === null ? null : basename(prompt.cwd),
        extra: { agent: prompt.agent, cwd: prompt.cwd },
      });
      yield event({ verb: "prompted", thing: id, ts: iso(prompt.ts), text: prompt.text });
    }
  },
});
