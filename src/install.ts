import { $ } from "bun";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import type { Config } from "./config.ts";

const label = "dev.commonplace.sync";

const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Keeps the archive current on macOS: a LaunchAgent that syncs at login, when a file a source watches
 * changes (Messages' database, for iMessage), and when a hook kicks it. launchd starts a small fixed binary
 * that runs `commonplace sync`, so the Full Disk Access you grant that binary once survives every code change.
 */
export const install = async (config: Config, root: string, data: string): Promise<string> => {
  if (process.platform !== "darwin") {
    return "Only macOS so far. Elsewhere the Claude Code plugin's hook keeps the archive current.";
  }

  const launcher = `${data}/commonplace-sync`;
  const plist = `${homedir()}/Library/LaunchAgents/${label}.plist`;
  const log = `${homedir()}/Library/Logs/commonplace-sync.log`;
  const watched = config.sources.flatMap((source) => source.watch ?? []);
  const uid = process.getuid?.() ?? 0;

  mkdirSync(data, { recursive: true });
  if (!existsSync(launcher)) {
    await $`bun build --compile ${`${root}/src/launcher.ts`} --outfile ${launcher}`.quiet();
  }

  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${xml(launcher)}</string></array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(process.env["PATH"] ?? "/usr/bin:/bin")}</string>
    <key>COMMONPLACE_DATA</key><string>${xml(data)}</string>
  </dict>
  <key>WatchPaths</key><array>${watched.map((path) => `<string>${xml(path)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`,
  );
  await $`launchctl bootout gui/${uid}/${label}`.quiet().nothrow();
  await $`launchctl bootstrap gui/${uid} ${plist}`.quiet();

  return [
    `Installed ${label}: it syncs at login${watched.length > 0 ? `, when ${watched.join(" or ")} changes` : ""}, and when kicked.`,
    `Hooks kick it with: launchctl kickstart gui/$(id -u)/${label}`,
    `Log: ${log}`,
    `Sources that read Messages or ~/Documents need Full Disk Access: grant it once to ${launcher}`,
    `  (System Settings → Privacy & Security → Full Disk Access → +).`,
  ].join("\n");
};
