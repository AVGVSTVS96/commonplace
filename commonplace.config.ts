import github from "./sources/github.ts";
import { imessage } from "./sources/imessage.ts";
import prompts from "./sources/prompts.ts";
import { defineConfig } from "./src/config.ts";

export default defineConfig({
  sources: [github, prompts, ...(process.platform === "darwin" ? [imessage()] : [])],

  mcp: ["github", "prompts"],

  redact: (row) => row.type === "event" && /\b(password|api[_ -]?key|secret)\b/i.test(row.text ?? ""),
});
