const { exitCode } = Bun.spawnSync(["bun", "src/cli.ts", "sync"], { stdout: "inherit", stderr: "inherit" });

process.exit(exitCode);
