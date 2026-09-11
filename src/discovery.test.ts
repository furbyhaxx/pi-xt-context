import { describe, it, expect } from "vitest";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import {
  buildContextBlock,
  dirForToolEvent,
  discoverContextFiles,
  pickNewFiles,
  resolveCdDir,
} from "./discovery.ts";
import { fileDedupKey, isUnderOrEqual } from "./paths.ts";

const HOME = "/home/radu";
const CWD = "/proj/app";
const BASE = "/proj/app";

async function withTree(
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pxt-disc-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("discoverContextFiles", () => {
  it("returns AGENTS.md deepest-first across multiple depths", async () => {
    await withTree(async (root) => {
      const mid = join(root, "mid");
      const deep = join(mid, "deep");
      await mkdir(deep, { recursive: true });
      await writeFile(join(root, "AGENTS.md"), "top\n");
      await writeFile(join(mid, "AGENTS.md"), "mid\n");
      await writeFile(join(deep, "AGENTS.md"), "deep\n");
      const files = await discoverContextFiles(deep, root, ["AGENTS.md"], {
        workingDirOnly: true,
        launchDir: root,
      });
      expect(files.map((f) => f.path)).toEqual([
        join(deep, "AGENTS.md"),
        join(mid, "AGENTS.md"),
        join(root, "AGENTS.md"),
      ]);
      expect(files.map((f) => f.content)).toEqual(["deep\n", "mid\n", "top\n"]);
      expect(files.map((f) => f.scopeDir)).toEqual([deep, mid, root]);
    });
  });

  it("does not load CLAUDE.md unless the pattern asks for it", async () => {
    await withTree(async (root) => {
      await writeFile(join(root, "CLAUDE.md"), "claude\n");
      await writeFile(join(root, "AGENTS.md"), "agents\n");
      const def = await discoverContextFiles(root, root, ["AGENTS.md"], {
        workingDirOnly: true,
        launchDir: root,
      });
      expect(def.map((f) => f.path)).toEqual([join(root, "AGENTS.md")]);
      const both = await discoverContextFiles(root, root, ["CLAUDE.md"], {
        workingDirOnly: true,
        launchDir: root,
      });
      expect(both.map((f) => f.path)).toEqual([join(root, "CLAUDE.md")]);
    });
  });

  it("matches globs, relative dirs, and recursive patterns from each ancestor", async () => {
    await withTree(async (root) => {
      const deep = join(root, "pkg", "deep");
      await mkdir(join(root, ".pi", "context"), { recursive: true });
      await mkdir(join(deep, "nested"), { recursive: true });
      await writeFile(join(root, "AGENTS.md"), "root-agents\n");
      await writeFile(join(root, "AGENTS.override.md"), "override\n");
      await writeFile(join(root, ".pi", "context", "rules.md"), "rules\n");
      await writeFile(join(deep, "nested", "secret.md"), "secret\n");

      const files = await discoverContextFiles(
        deep,
        root,
        ["AGENTS*.md", ".pi/context/*.md"],
        { workingDirOnly: true, launchDir: root },
      );
      expect(files.map((f) => f.path).sort()).toEqual(
        [
          join(root, "AGENTS.md"),
          join(root, "AGENTS.override.md"),
          join(root, ".pi", "context", "rules.md"),
        ].sort(),
      );
      const rules = files.find((f) => f.path.endsWith("rules.md"));
      expect(rules?.scopeDir).toBe(root);

      const recursive = await discoverContextFiles(deep, root, ["**/*.md"], {
        workingDirOnly: true,
        launchDir: root,
      });
      expect(recursive.some((f) => f.path.endsWith("secret.md"))).toBe(true);

      await writeFile(join(root, "CLAUDE.md"), "claude\n");
      const braced = await discoverContextFiles(
        root,
        root,
        ["{AGENTS.md,CLAUDE.md}"],
        { workingDirOnly: true, launchDir: root },
      );
      expect(braced.map((f) => f.path).sort()).toEqual(
        [join(root, "AGENTS.md"), join(root, "CLAUDE.md")].sort(),
      );
    });
  });

  it("empty patterns load nothing", async () => {
    await withTree(async (root) => {
      await writeFile(join(root, "AGENTS.md"), "x\n");
      const files = await discoverContextFiles(root, root, [], {
        workingDirOnly: true,
        launchDir: root,
      });
      expect(files).toEqual([]);
    });
  });

  it("workingDirOnly skips symlink targets outside the launch dir", async () => {
    await withTree(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "pxt-out-"));
      try {
        await writeFile(join(outside, "AGENTS.md"), "leak\n");
        try {
          await symlink(join(outside, "AGENTS.md"), join(root, "AGENTS.md"), "file");
        } catch {
          return; // platform cannot create file symlinks
        }
        const files = await discoverContextFiles(root, root, ["AGENTS.md"], {
          workingDirOnly: true,
          launchDir: root,
        });
        expect(files).toEqual([]);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});

describe("buildContextBlock", () => {
  it("tags specificity from scopeDir, not file nesting", () => {
    const block = buildContextBlock([
      {
        path: "/proj/.pi/context/rules.md",
        content: "rules",
        scopeDir: "/proj/app",
      },
      {
        path: "/proj/AGENTS.md",
        content: "root",
        scopeDir: "/proj",
      },
    ]);
    expect(block).toContain("most specific");
    expect(block).toContain("1 level(s) up — broader");
  });
});

describe("resolveCdDir", () => {
  it("returns null for non-cd commands", () => {
    expect(resolveCdDir("ls -la", "", CWD, HOME)).toBeNull();
    expect(resolveCdDir("echo cd", "", CWD, HOME)).toBeNull();
  });

  it("bare `cd` goes home", () => {
    expect(resolveCdDir("cd", "", CWD, HOME)).toBe(HOME);
  });

  it("uses pwd output as the real dir", () => {
    expect(resolveCdDir("cd sub && pwd", "/proj/app/sub", CWD, HOME)).toBe("/proj/app/sub");
  });

  it("handles paths with spaces (the bug that bit us)", () => {
    const out = "/d/Projects/LLM Tests/qwen35b/tasktrack";
    expect(resolveCdDir("cd tasktrack && pwd", out, CWD, HOME)).toBe(out);
  });

  it("picks the last non-empty output line", () => {
    expect(resolveCdDir("cd x && pwd", "\n  /a/b  \n", CWD, HOME)).toBe("/a/b");
  });

  it("resolves a bare relative cd against the current dir", () => {
    expect(resolveCdDir("cd sub", "", CWD, HOME)).toBe(resolve(CWD, "sub"));
  });

  it("strips the `&& pwd` suffix from the target on the fallback path", () => {
    const got = resolveCdDir("cd sub && pwd", "", CWD, HOME)!;
    expect(got.endsWith("sub")).toBe(true);
    expect(got).not.toContain("pwd");
  });
});

describe("dirForToolEvent", () => {
  it("returns null for non-path tools", () => {
    expect(dirForToolEvent("bash", { command: "ls" }, BASE)).toBeNull();
    expect(dirForToolEvent("unknown", { path: "/x" }, BASE)).toBeNull();
  });

  it("file tools (read/edit/write) → dirname of an absolute path", () => {
    const f = "/proj/app/pkg/__main__.py";
    expect(dirForToolEvent("read", { path: f }, BASE)).toBe(dirname(f));
    expect(dirForToolEvent("edit", { path: f }, BASE)).toBe(dirname(f));
    expect(dirForToolEvent("write", { path: f }, BASE)).toBe(dirname(f));
  });

  it("converts a bash drive path and keeps the spaced dir intact", () => {
    const f = "/d/Projects/LLM Tests/qwen35b/tasktrack/__main__.py";
    const got = dirForToolEvent("read", { path: f }, BASE)!;
    expect(got).toMatch(/tasktrack$/);
    expect(got).toContain("LLM Tests");
    expect(got).not.toContain("__main__.py");
  });

  it("accepts the file_path alias", () => {
    expect(dirForToolEvent("read", { file_path: "/proj/lib/c.ts" }, BASE)).toBe(
      dirname("/proj/lib/c.ts"),
    );
  });

  it("file tools resolve a relative path against baseDir", () => {
    expect(dirForToolEvent("read", { path: "sub/x.ts" }, BASE)).toBe(resolve(BASE, "sub"));
  });

  it("file tools without a path return null", () => {
    expect(dirForToolEvent("read", {}, BASE)).toBeNull();
  });

  it("dir tools (grep/ls/find) → the dir itself", () => {
    expect(dirForToolEvent("ls", { path: "/some/dir" }, BASE)).toBe("/some/dir");
    expect(dirForToolEvent("grep", { path: "/some/dir", pattern: "x" }, BASE)).toBe("/some/dir");
  });

  it("dir tools default to baseDir when path omitted", () => {
    expect(dirForToolEvent("ls", {}, BASE)).toBe(BASE);
    expect(dirForToolEvent("grep", { pattern: "x" }, BASE)).toBe(BASE);
  });
});

describe("isUnderOrEqual", () => {
  it("true for the same dir and for descendants", () => {
    expect(isUnderOrEqual("/proj/app", "/proj/app")).toBe(true);
    expect(isUnderOrEqual("/proj/app/sub/deep", "/proj/app")).toBe(true);
  });

  it("false for ancestors and siblings", () => {
    expect(isUnderOrEqual("/proj", "/proj/app")).toBe(false);
    expect(isUnderOrEqual("/proj/other", "/proj/app")).toBe(false);
    expect(isUnderOrEqual("/proj/appx/y", "/proj/app")).toBe(false);
  });

  it("handles bash-style drive paths", () => {
    expect(isUnderOrEqual("/d/Projects/LLM Tests/tasktrack", "/d/Projects")).toBe(true);
    expect(isUnderOrEqual("/d/Projects/other", "/d/Projects/LLM")).toBe(false);
  });

  it("mixes win-style and bash-style formats on win32", () => {
    if (process.platform === "win32") {
      expect(isUnderOrEqual("D:\\Projects\\LLM Tests", "/d/Projects")).toBe(true);
    } else {
      expect(isUnderOrEqual("D:\\Projects\\LLM Tests", "/d/Projects")).toBe(false);
    }
  });

  it("case handling follows the platform", () => {
    if (process.platform === "win32") {
      expect(isUnderOrEqual("/D/Projects/X", "/d/projects")).toBe(true);
    } else {
      expect(isUnderOrEqual("/D/Projects/X", "/d/projects")).toBe(false);
    }
  });
});

describe("pickNewFiles", () => {
  const f = (path: string) => ({ path, content: `# ${path}`, scopeDir: dirname(path) });

  it("drops files pi already loaded at startup", () => {
    const claude = "/proj/CLAUDE.md";
    const s = {
      piLoadedPaths: new Set([fileDedupKey(claude)]),
      injected: new Set<string>(),
    };
    const out = pickNewFiles(s, [f("/proj/app/CLAUDE.md"), f(claude)]);
    expect(out.map((x) => x.path)).toEqual(["/proj/app/CLAUDE.md"]);
  });

  it("dedups a parent file shared across two dirs (marks injected)", () => {
    const s = { piLoadedPaths: new Set<string>(), injected: new Set<string>() };
    const first = pickNewFiles(s, [f("/proj/a/CLAUDE.md"), f("/proj/CLAUDE.md")]);
    expect(first.map((x) => x.path)).toEqual(["/proj/a/CLAUDE.md", "/proj/CLAUDE.md"]);
    const second = pickNewFiles(s, [f("/proj/b/CLAUDE.md"), f("/proj/CLAUDE.md")]);
    expect(second.map((x) => x.path)).toEqual(["/proj/b/CLAUDE.md"]);
  });

  it("preserves input order (caller passes deepest-first)", () => {
    const s = { piLoadedPaths: new Set<string>(), injected: new Set<string>() };
    const out = pickNewFiles(s, [f("/proj/a/b/CLAUDE.md"), f("/proj/CLAUDE.md")]);
    expect(out.map((x) => x.path)).toEqual(["/proj/a/b/CLAUDE.md", "/proj/CLAUDE.md"]);
  });
});

describe("fileDedupKey", () => {
  it("falls back to the normalized path when the file doesn't exist", () => {
    const missing = "/proj/definitely-missing/CLAUDE.md";
    expect(fileDedupKey(missing)).toBe(
      process.platform === "win32" ? "/proj/definitely-missing/claude.md" : missing,
    );
  });

  it("does not collapse distinct POSIX filenames that differ only by case", () => {
    if (process.platform === "win32") return;
    expect(fileDedupKey("/proj/AGENTS.md")).not.toBe(fileDedupKey("/proj/agents.md"));
  });

  it("resolves to the realpath, so aliases of the same file dedup", async () => {
    await withTree(async (root) => {
      const real = join(root, "real");
      const link = join(root, "link");
      await mkdir(real, { recursive: true });
      await writeFile(join(real, "AGENTS.md"), "x\n");
      await symlink(real, link, process.platform === "win32" ? "junction" : "dir");
      const s = { piLoadedPaths: new Set<string>(), injected: new Set<string>() };
      const out = pickNewFiles(s, [
        { path: join(real, "AGENTS.md"), content: "x\n", scopeDir: real },
        { path: join(link, "AGENTS.md"), content: "x\n", scopeDir: link },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].path).toBe(join(real, "AGENTS.md"));
    });
  });
});
