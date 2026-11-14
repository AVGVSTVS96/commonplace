import { github } from "./sources/github.ts";
import { imessage } from "./sources/imessage.ts";
import { prompts } from "./sources/prompts.ts";
import raindrop from "./sources/raindrop.ts";
import takeout from "./sources/takeout.ts";
import xArchive from "./sources/x-archive.ts";
import { defineConfig } from "./src/config.ts";

const secret =
  /\b(?:sk-[\w-]{20,}|gh[pousr]_\w{30,}|github_pat_\w{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16})|\b(?:password|passwd|api[_ -]?key|secret|token)\s*[:=]\s*\S+/iu;

export default defineConfig({
  sources: [
    xArchive,
    raindrop,
    takeout,
    prompts(),
    github(),
    ...(process.platform === "darwin" ? [imessage()] : []),
  ],

  redact: (row) => row.type === "event" && secret.test(row.text ?? ""),
});
