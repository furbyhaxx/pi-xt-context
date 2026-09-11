import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import {
  buildSettingsPatch,
  DEFAULT_CONFIG,
  loadConfig,
  parseFilesEditorText,
  saveContextSettings,
  validatePattern,
  type ScopeDraft,
} from "./config.ts";

async function withDirs(fn: (agent: string, cwd: string) => Promise<void>) {
  const agent = await mkdtemp(join(tmpdir(), "pxt-agent-"));
  const cwd = await mkdtemp(join(tmpdir(), "pxt-cwd-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    await fn(agent, cwd);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    await rm(agent, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("validatePattern", () => {
  it("accepts relative filenames and globs", () => {
    expect(validatePattern("AGENTS.md")).toBeNull();
    expect(validatePattern("AGENTS*.md")).toBeNull();
    expect(validatePattern(".pi/context/*.md")).toBeNull();
    expect(validatePattern("**/*.md")).toBeNull();
    expect(validatePattern("{AGENTS.md,CLAUDE.md}")).toBeNull();
  });

  it("rejects empty, absolute, and parent-escaping patterns", () => {
    expect(validatePattern("")).not.toBeNull();
    expect(validatePattern("/etc/passwd")).not.toBeNull();
    expect(validatePattern("~/AGENTS.md")).not.toBeNull();
    expect(validatePattern("../AGENTS.md")).not.toBeNull();
    expect(validatePattern("foo/../../secret")).not.toBeNull();
  });
});

describe("parseFilesEditorText", () => {
  it("keeps one glob per line and does not split on commas", () => {
    const got = parseFilesEditorText("AGENTS.md\n{AGENTS.md,CLAUDE.md}\n\n  \n");
    expect(got.errors).toEqual([]);
    expect(got.files).toEqual(["AGENTS.md", "{AGENTS.md,CLAUDE.md}"]);
  });

  it("reports invalid lines without dropping valid ones", () => {
    const got = parseFilesEditorText("AGENTS.md\n../nope\n.pi/context/*.md");
    expect(got.files).toEqual(["AGENTS.md", ".pi/context/*.md"]);
    expect(got.errors).toHaveLength(1);
  });
});

describe("loadConfig", () => {
  it("defaults to workingDirOnly on, hideContents off, files AGENTS.md", async () => {
    await withDirs(async (_agent, cwd) => {
      expect(loadConfig(cwd, true).effective).toEqual(DEFAULT_CONFIG);
    });
  });

  it("merges user + trusted project; files arrays replace; untrusted skips project", async () => {
    await withDirs(async (agent, cwd) => {
      await writeFile(
        join(agent, "settings.json"),
        JSON.stringify({
          theme: "dark",
          context: { workingDirOnly: true, hideContents: true, files: ["USER.md"] },
        }),
      );
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({
          context: { workingDirOnly: false, files: ["PROJECT.md"] },
        }),
      );

      const trusted = loadConfig(cwd, true);
      expect(trusted.effective).toEqual({
        workingDirOnly: false,
        hideContents: true,
        files: ["PROJECT.md"],
      });
      expect(trusted.provenance).toEqual({
        workingDirOnly: "project",
        hideContents: "user",
        files: "project",
      });

      const untrusted = loadConfig(cwd, false);
      expect(untrusted.effective).toEqual({
        workingDirOnly: true,
        hideContents: true,
        files: ["USER.md"],
      });
      expect(untrusted.project).toEqual({});
    });
  });

  it("explicit empty files disables discovery", async () => {
    await withDirs(async (agent, cwd) => {
      await writeFile(
        join(agent, "settings.json"),
        JSON.stringify({ context: { files: [] } }),
      );
      expect(loadConfig(cwd, false).effective.files).toEqual([]);
      expect(loadConfig(cwd, false).provenance.files).toBe("user");
    });
  });

  it("invalid values fall back with diagnostics; missing/corrupt files do not throw", async () => {
    await withDirs(async (agent, cwd) => {
      expect(loadConfig(cwd, true).effective).toEqual(DEFAULT_CONFIG);

      await writeFile(join(agent, "settings.json"), "{ not json");
      const bad = loadConfig(cwd, false);
      expect(bad.effective).toEqual(DEFAULT_CONFIG);
      expect(bad.diagnostics.length).toBeGreaterThan(0);

      await writeFile(join(agent, "settings.json"), "[1,2]");
      expect(loadConfig(cwd, false).effective).toEqual(DEFAULT_CONFIG);

      await writeFile(
        join(agent, "settings.json"),
        JSON.stringify({
          context: {
            workingDirOnly: "yes",
            hideContents: 1,
            files: ["../x", "AGENTS.md"],
          },
        }),
      );
      const mixed = loadConfig(cwd, false);
      expect(mixed.effective.workingDirOnly).toBe(true);
      expect(mixed.effective.hideContents).toBe(false);
      expect(mixed.effective.files).toEqual(["AGENTS.md"]);
    });
  });
});

describe("saveContextSettings", () => {
  it("writes only context keys and preserves unrelated settings", async () => {
    await withDirs(async (agent, cwd) => {
      await writeFile(
        join(agent, "settings.json"),
        JSON.stringify({ theme: "dark", context: { extra: 1, workingDirOnly: true } }, null, 2) + "\n",
      );
      const result = saveContextSettings("user", cwd, {
        hideContents: true,
        files: ["AGENTS.md", ".pi/context/*.md"],
      });
      expect(result).toEqual({ ok: true });
      const raw = JSON.parse(await readFile(join(agent, "settings.json"), "utf-8"));
      expect(raw.theme).toBe("dark");
      expect(raw.context).toEqual({
        extra: 1,
        workingDirOnly: true,
        hideContents: true,
        files: ["AGENTS.md", ".pi/context/*.md"],
      });
    });
  });

  it("null patch keys remove overrides without copying defaults", async () => {
    await withDirs(async (agent, cwd) => {
      await writeFile(
        join(agent, "settings.json"),
        JSON.stringify({ context: { workingDirOnly: false, hideContents: true } }),
      );
      expect(saveContextSettings("user", cwd, { workingDirOnly: null })).toEqual({ ok: true });
      const raw = JSON.parse(await readFile(join(agent, "settings.json"), "utf-8"));
      expect(raw.context).toEqual({ hideContents: true });
    });
  });

  it("creates missing settings files and project .pi dirs", async () => {
    await withDirs(async (_agent, cwd) => {
      expect(saveContextSettings("project", cwd, { files: ["X.md"] })).toEqual({ ok: true });
      const raw = JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf-8"));
      expect(raw).toEqual({ context: { files: ["X.md"] } });
    });
  });

  it("refuses to overwrite corrupt settings", async () => {
    await withDirs(async (agent, cwd) => {
      const path = join(agent, "settings.json");
      await writeFile(path, "{ not json");
      const result = saveContextSettings("user", cwd, { hideContents: true });
      expect(result.ok).toBe(false);
      expect(await readFile(path, "utf-8")).toBe("{ not json");
    });
  });
});

describe("buildSettingsPatch", () => {
  const base = (over: Partial<ScopeDraft> = {}): ScopeDraft => ({
    inherit: { workingDirOnly: true, hideContents: true, files: true, ...over.inherit },
    workingDirOnly: true,
    hideContents: false,
    files: ["AGENTS.md"],
    ...over,
  });

  it("emits nothing when the draft still inherits everything", () => {
    expect(buildSettingsPatch(base(), base())).toEqual({});
  });

  it("sets overrides and can reset them to inherit", () => {
    const initial = base();
    const draft = base({
      inherit: { workingDirOnly: false, hideContents: true, files: false },
      workingDirOnly: false,
      files: [],
    });
    expect(buildSettingsPatch(initial, draft)).toEqual({
      workingDirOnly: false,
      files: [],
    });

    const after = base({
      inherit: { workingDirOnly: false, hideContents: true, files: false },
      workingDirOnly: false,
      files: [],
    });
    const reset = base();
    expect(buildSettingsPatch(after, reset)).toEqual({
      workingDirOnly: null,
      files: null,
    });
  });
});
