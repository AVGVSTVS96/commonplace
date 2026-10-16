import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";

import { event, iso, thing } from "../src/schema.ts";
import { defineSource, jsonl, lines, writeJsonl } from "../src/source.ts";

export interface Prompt {
  readonly agent: "claude" | "codex" | "pi";
  readonly session: string;
  readonly ts: string;
  readonly cwd: string | null;
  readonly project: string | null;
  readonly model: string | null;
  readonly text: string;
  /** For a message that came in through a chat app (Telegram, Discord, …): which channel, and who sent it. */
  readonly channel: { readonly source: string; readonly user: string | null } | null;
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

const typed = (text: string, also: ReadonlyArray<string> = []): boolean =>
  text !== "" && ![...injected, ...also].some((prefix) => text.startsWith(prefix));

type Part = { readonly type?: string; readonly text?: string };

const textOf = (content: unknown, types: ReadonlyArray<string>): string | null =>
  typeof content === "string"
    ? content
    : Array.isArray(content) && !content.some((part: Part) => part.type === "tool_result")
      ? content
          .filter((part: Part) => types.includes(part.type ?? "") && typeof part.text === "string")
          .map((part: Part) => part.text)
          .join("\n")
      : null;

const parse = (line: string): Record<string, any> | null => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/** Session logs untouched since the last snapshot can't hold new prompts. */
const touched = async (dir: string, pattern: string, since: string | null): Promise<Array<string>> => {
  const files = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: dir, absolute: true })).catch(
    () => [],
  );

  return files
    .filter((file) => since === null || statSync(file).mtime.toLocaleDateString("sv") >= since)
    .toSorted();
};

const projectOf = (cwd: string | null): string | null =>
  cwd === null ? null : cwd === homedir() ? "~" : basename(cwd) || cwd;

const channelBlock = /<channel source="([^"]+)"([^>]*)>\n?([\s\S]*?)\n?<\/channel>/g;

/** A chat-app message (Telegram, Discord, …) arrives wrapped in `<channel …>`, sometimes several to a turn. */
const channelMessages = (text: string) =>
  text.startsWith("<channel source=")
    ? [...text.matchAll(channelBlock)].map(([, source = "", attributes = "", inner = ""]) => ({
        channel: { source, user: /\buser="([^"]*)"/.exec(attributes)?.[1] ?? null },
        text: inner.trim(),
      }))
    : null;

/** Claude Code: what a person sent, not what the harness, a subagent, `claude -p` or a plugin did. */
async function* claude(since: string | null): AsyncGenerator<Prompt> {
  const dir = `${process.env["CLAUDE_CONFIG_DIR"] ?? `${homedir()}/.claude`}/projects`;

  for (const file of await touched(dir, "*/*.jsonl", since)) {
    const pending: Array<Omit<Prompt, "model">> = [];
    let model: string | null = null;

    for await (const line of lines(file)) {
      const entry = parse(line);

      if (entry === null || entry["isSidechain"] === true) {
        continue;
      }

      const said = entry["message"]?.model;

      if (entry["type"] === "assistant" && typeof said === "string" && said !== "<synthetic>") {
        model = said;
        for (const prompt of pending.splice(0)) {
          yield { ...prompt, model };
        }
        continue;
      }

      const raw = entry["type"] === "user" ? textOf(entry["message"]?.content, ["text"])?.trim() : undefined;

      if (raw === undefined || raw === null) {
        continue;
      }

      const origin = entry["origin"]?.kind;
      const typedHere =
        entry["isMeta"] !== true &&
        (origin === undefined ? entry["entrypoint"] !== "sdk-cli" : origin === "human");
      const messages = channelMessages(raw) ?? (typedHere ? [{ channel: null, text: raw }] : []);
      const cwd = entry["cwd"] ?? null;

      for (const message of origin === undefined || origin === "channel" || typedHere ? messages : []) {
        if (typed(message.text)) {
          pending.push({
            agent: "claude",
            session: entry["sessionId"],
            ts: entry["timestamp"],
            cwd,
            project: projectOf(cwd),
            ...message,
          });
        }
      }
    }

    for (const prompt of pending) {
      yield { ...prompt, model };
    }
  }
}

/** Codex: your turns in every session except the subagent threads Codex starts for itself. */
async function* codex(since: string | null): AsyncGenerator<Prompt> {
  const home = process.env["CODEX_HOME"] ?? `${homedir()}/.codex`;
  const files = [
    ...(await touched(`${home}/sessions`, "**/*.jsonl", since)),
    ...(await touched(`${home}/archived_sessions`, "**/*.jsonl", since)),
  ];

  for (const file of files) {
    const entries = (await Array.fromAsync(lines(file))).map(parse);
    const meta = entries.find((e) => e?.["type"] === "session_meta")?.["payload"];
    const origin = meta?.source ?? meta?.thread_source;

    if (meta === undefined || (typeof origin === "object" && origin !== null && "subagent" in origin)) {
      continue;
    }

    const models = entries.map((e) =>
      e?.["type"] === "turn_context" ? (e["payload"]?.model ?? null) : null,
    );
    const modelAfter = (i: number): string | null =>
      models.slice(i).find((m) => m !== null) ?? models.findLast((m) => m !== null) ?? null;
    const events = entries.flatMap((e, i) =>
      e?.["type"] === "event_msg" && e["payload"]?.type === "user_message" ? [[e, i] as const] : [],
    );
    const turns =
      events.length > 0
        ? events.map(([e, i]) => ({
            i,
            ts: e["timestamp"],
            text: textOf(e["payload"].message, ["input_text", "text"]),
          }))
        : entries.flatMap((e, i) =>
            e?.["type"] === "response_item" &&
            e["payload"]?.type === "message" &&
            e["payload"].role === "user"
              ? [{ i, ts: e["timestamp"], text: textOf(e["payload"].content, ["input_text", "text"]) }]
              : [],
          );

    for (const { i, ts, text } of turns) {
      const trimmed = text?.trim() ?? "";

      if (typed(trimmed)) {
        const cwd = meta.cwd ?? null;
        yield {
          agent: "codex",
          session: meta.id,
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
}

/** Pi: your turns in every session. */
async function* pi(since: string | null): AsyncGenerator<Prompt> {
  for (const file of await touched(`${homedir()}/.pi/agent/sessions`, "*/*.jsonl", since)) {
    const entries = (await Array.fromAsync(lines(file))).map(parse);
    const session = entries.find((e) => e?.["type"] === "session");
    const replies = entries.map((e) =>
      e?.["type"] === "message" && e["message"]?.role === "assistant" ? (e["message"].model ?? null) : null,
    );

    for (const [i, e] of entries.entries()) {
      const text =
        e?.["type"] === "message" && e["message"]?.role === "user"
          ? (textOf(e["message"].content, ["text"])?.trim() ?? "")
          : "";

      if (typed(text, injectedByPi) && !text.slice(0, 600).includes("References are relative to ")) {
        const cwd = session?.["cwd"] ?? null;
        yield {
          agent: "pi",
          session: session?.["id"] ?? basename(file, ".jsonl"),
          ts: e?.["timestamp"],
          cwd,
          project: projectOf(cwd),
          model: replies.slice(i).find((m) => m !== null) ?? null,
          text,
          channel: null,
        };
      }
    }
  }
}

/** Every prompt on this machine since `since`, oldest first. */
const scan = async (since: string | null): Promise<Array<Prompt>> =>
  [
    ...(await Array.fromAsync(claude(since))),
    ...(await Array.fromAsync(codex(since))),
    ...(await Array.fromAsync(pi(since))),
  ]
    .filter((p) => typeof p.ts === "string" && (since === null || p.ts >= since))
    .toSorted((a, b) => a.ts.localeCompare(b.ts));

if (import.meta.main) {
  for (const prompt of await scan(process.env["COMMONPLACE_SINCE"] || null)) {
    process.stdout.write(`${JSON.stringify(prompt)}\n`);
  }
}

/** The same scan on another machine over ssh: this file is bundled and run there with its own Bun. */
const scanOver = async (host: string, since: string | null): Promise<Array<Prompt>> => {
  const [bundle] = (await Bun.build({ entrypoints: [import.meta.path], target: "bun" })).outputs;
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
    .map((line) => JSON.parse(line) as Prompt);
};

/** What older snapshots hold: prompt-picker's lines, or the first `{ agent: "claude-code" }` ones. */
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
  /** Read another machine's sessions over ssh (`user@host`, needs Bun there). Names the source `prompts-<host>`. */
  readonly ssh?: string;
}

/**
 * Every prompt you typed into Claude Code, Codex and Pi, and sent them from chat apps, read from their
 * session logs. A chat message keeps who sent it in `extra.from`, so `redact` can keep out the ones
 * your own bots and relays send.
 */
export const prompts = ({ ssh }: PromptsOptions = {}) =>
  defineSource({
    name: ssh === undefined ? "prompts" : `prompts-${ssh.replace(/^.*@/, "")}`,

    /** Starts a day before the last snapshot so no timezone can open a gap; repeats merge away by ID. */
    fetch: async ({ dir, since }) => {
      const from =
        since === null ? null : new Date(Date.parse(since) - 86_400_000).toISOString().slice(0, 10);
      await writeJsonl(
        `${dir}/prompts.jsonl`,
        ssh === undefined ? await scan(from) : await scanOver(ssh, from),
      );
    },

    rows: async function* ({ dir }) {
      const seen = new Set<string>();

      for await (const line of jsonl<Legacy>(`${dir}/prompts.jsonl`)) {
        const agent = line.source ?? (line.agent === "claude-code" ? "claude" : (line.agent ?? "claude"));
        const id = `session:${agent}:${line.sessionId ?? line.session}`;

        if (!seen.has(id)) {
          seen.add(id);
          yield thing({
            id,
            kind: "session",
            title: line.project ?? (line.cwd === null ? null : basename(line.cwd)),
            extra: { agent },
          });
        }

        yield event({
          verb: "prompted",
          thing: id,
          ts: iso(line.ts),
          text: line.text,
          extra: {
            cwd: line.cwd,
            model: line.model ?? null,
            ...(line.file === undefined ? {} : { file: line.file }),
            ...(line.channel === undefined || line.channel === null
              ? {}
              : { channel: line.channel.source, from: line.channel.user }),
          },
        });
      }
    },
  });
