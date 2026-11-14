import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { recall } from "../src/recall.ts";

const home = mkdtempSync(`${tmpdir()}/commonplace-recall-`);
const index = `${home}/recall.db`;
const keys = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR"] as const;
const saved = keys.map((key) => [key, process.env[key]] as const);

const claude = `${home}/.claude/projects/-work-app/11111111-1111-4111-8111-111111111111.jsonl`;

const codex = `${home}/.codex/sessions/2026/11/01/rollout-2026-11-01T10-00-00-22222222-2222-4222-8222-222222222222.jsonl`;

const pi = `${home}/.pi/agent/sessions/--work-infra--/2026-11-02T09-00-00-000Z_33333333-3333-4333-8333-333333333333.jsonl`;

const write = (file: string, entries: readonly object[]) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
};

const at = (minute: number) => `2026-11-01T10:${String(minute).padStart(2, "0")}:00.000Z`;

beforeAll(() => {
  Object.assign(process.env, {
    CLAUDE_CONFIG_DIR: `${home}/.claude`,
    CODEX_HOME: `${home}/.codex`,
    PI_CODING_AGENT_DIR: `${home}/.pi/agent`,
  });

  write(claude, [
    {
      type: "user",
      timestamp: at(1),
      cwd: "/work/app",
      message: { role: "user", content: "fix the flaky deploy" },
    },
    {
      type: "assistant",
      timestamp: at(2),
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "bun test --bail" } }],
      },
    },
    {
      type: "user",
      timestamp: at(3),
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "error: ECONNREFUSED on port 5432" }],
      },
    },
    {
      type: "user",
      timestamp: at(4),
      message: {
        role: "user",
        content: "<system-reminder>the harness says marmalade</system-reminder>",
      },
    },
    {
      type: "assistant",
      timestamp: at(5),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The deploy is flaky again" }],
      },
    },
  ]);

  write(codex, [
    { type: "session_meta", timestamp: at(10), payload: { cwd: "/work/api" } },
    {
      type: "response_item",
      timestamp: at(11),
      payload: { type: "message", role: "developer", content: "zebra instructions" },
    },
    {
      type: "response_item",
      timestamp: at(12),
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: '{"cmd":"terraform plan"}',
      },
    },
  ]);

  write(pi, [
    { type: "session", timestamp: at(20), cwd: "/work/infra" },
    {
      type: "message",
      timestamp: at(21),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash", arguments: { command: "kubectl rollout" } }],
      },
    },
  ]);
});

afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }

  rmSync(home, { recursive: true, force: true });
});

const where = async (q: string) => {
  const hits = await recall(index, q);

  return hits.map((hit) => [hit.id, hit.role, hit.project, hit.file, hit.line]);
};

test("recall points at the line of each agent's session that matches", async () => {
  expect(await where("ECONNREFUSED")).toEqual([
    ["session:claude:11111111-1111-4111-8111-111111111111", "tool", "app", claude, 3],
  ]);
  expect(await where("terraform")).toEqual([
    ["session:codex:22222222-2222-4222-8222-222222222222", "agent", "api", codex, 3],
  ]);
  expect(await where("kubectl")).toEqual([
    ["session:pi:33333333-3333-4333-8333-333333333333", "agent", "infra", pi, 2],
  ]);
  const [hit] = await recall(index, "ECONNREFUSED");
  expect(hit?.text).toBe("error: ECONNREFUSED on port 5432");
});

test("recall leaves out what the harness injected, and gives one pointer per session", async () => {
  expect(await where("marmalade")).toEqual([]);
  expect(await where("zebra")).toEqual([]);
  expect(await where("flaky")).toHaveLength(1);
});

test("recall reads what was appended, waits for a whole line, and forgets deleted sessions", async () => {
  appendFileSync(
    claude,
    `${JSON.stringify({ type: "assistant", timestamp: at(6), message: { role: "assistant", content: "postgres was down" } })}\n{"type":"assistant","message":{"role":"assistant","content":"halfwr`,
  );

  expect(await where("postgres")).toEqual([
    ["session:claude:11111111-1111-4111-8111-111111111111", "agent", "app", claude, 6],
  ]);
  expect(await where("halfwritten")).toEqual([]);

  appendFileSync(claude, `itten"}}\n`);
  const [finished] = await where("halfwritten");
  expect(finished?.[4]).toBe(7);

  rmSync(codex);
  expect(await where("terraform")).toEqual([]);
});
