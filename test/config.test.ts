import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { saveContextSettings } from "../src/config.ts";

describe("settings locking", () => {
  it("creates settings and preserves unrelated keys on later locked updates", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pxt-config-"));
    try {
      expect(saveContextSettings("project", cwd, { hideContents: true })).toEqual({ ok: true });
      const path = join(cwd, ".pi", "settings.json");
      writeFileSync(path, JSON.stringify({ unrelated: "keep", context: { hideContents: true } }));
      expect(saveContextSettings("project", cwd, { files: ["AGENTS.md"] })).toEqual({ ok: true });
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        unrelated: "keep", context: { hideContents: true, files: ["AGENTS.md"] },
      });
      expect(() => lockfile.lockSync(path)()).not.toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refuses to write while another process holds the settings lock", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pxt-config-"));
    const path = join(cwd, ".pi", "settings.json");
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(path, "{}\n");
    const release = lockfile.lockSync(path, { realpath: false });
    try {
      const result = saveContextSettings("project", cwd, { hideContents: true });
      expect(result.ok).toBe(false);
      expect(readFileSync(path, "utf8")).toBe("{}\n");
    } finally {
      release();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
