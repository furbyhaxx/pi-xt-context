import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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
