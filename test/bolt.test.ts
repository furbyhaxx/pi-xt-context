import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

it.skipIf(!process.env.PI_BOLT_BINARY)("deduplicates sequential tool touches and excludes subtrees in compiled Pi-Bolt", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pxt-bolt-context-"));
  try {
    mkdirSync(join(cwd, "nested"));
    mkdirSync(join(cwd, "agent"));
    writeFileSync(join(cwd, "AGENTS.md"), "runtime root rules\n");
    writeFileSync(join(cwd, "nested", "AGENTS.md"), "runtime nested rules\n");
    writeFileSync(join(cwd, "nested", "file.txt"), "fixture data\n");
    for (const exclude of [[], ["nested/**"]]) {
      writeFileSync(join(cwd, "agent", "settings.json"), JSON.stringify({ context: { exclude }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
      const result = spawnSync(process.env.PI_BOLT_BINARY!, [
        "-ne", "-ns", "-np", "--offline", "-nc", "--no-session",
        "-e", fileURLToPath(new URL("./fixtures/bolt-provider.ts", import.meta.url)),
        "--provider", "xt-context-fixture", "--model", "fixture", "--mode", "json", "-p", "Run fixture",
      ], { cwd, encoding: "utf8", timeout: 20_000, env: { ...process.env, PI_CODING_AGENT_DIR: join(cwd, "agent") } });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
      const messages = events.filter((e) => e.type === "message_end").map((e) => e.message);
      expect(messages.some((m) => m.role === "assistant" && m.stopReason === "error"), result.stdout).toBe(false);
      const blocks = messages.filter((m) => m.role === "custom" && m.customType === "context");
      expect(blocks).toHaveLength(1);
      expect(blocks[0].details.files).toEqual(exclude.length > 0
        ? [join(cwd, "AGENTS.md")]
        : [join(cwd, "nested", "AGENTS.md"), join(cwd, "AGENTS.md")]);
      expect(messages.at(-1).content).toEqual([{ type: "text", text: "fixture complete" }]);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 45_000);

// Opt-in real-runtime regression: PI_BOLT_BINARY=/path/to/pi-bolt npm test
it.skipIf(!process.env.PI_BOLT_BINARY)("loads the extension in compiled Pi-Bolt", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pxt-bolt-"));
  try {
    const result = spawnSync(process.env.PI_BOLT_BINARY!, [
      "--no-extensions", "-e", fileURLToPath(new URL("../index.ts", import.meta.url)),
      "--mode", "rpc", "--no-session",
    ], {
      cwd, input: "", encoding: "utf8", timeout: 20_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(cwd, "agent") },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("Failed to load extension");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 25_000);
