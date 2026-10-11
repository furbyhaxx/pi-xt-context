import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { SettingsList } from "@earendil-works/pi-tui";
import { parseContextArgs, registerContextCommand, formatOverview } from "./commands.ts";
import { DEFAULT_CONFIG, loadConfig, type LoadedConfig } from "./config.ts";
import {
  collectExtensionFilesFromBranch,
  formatFileList,
  mergeListedFiles,
} from "./loaded.ts";

function loaded(over: Partial<LoadedConfig> = {}): LoadedConfig {
  return {
    effective: {
      ...DEFAULT_CONFIG,
      files: [...DEFAULT_CONFIG.files],
      exclude: [...DEFAULT_CONFIG.exclude],
    },
    user: {},
    project: {},
    provenance: {
      workingDirOnly: "default",
      hideContents: "default",
      files: "default",
      exclude: "default",
    },
    diagnostics: [],
    userPath: "/tmp/user/settings.json",
    projectPath: "/tmp/proj/.pi/settings.json",
    ...over,
  };
}

type SettingAction = readonly [id: string, value: string];

async function runConfigCommand(options: {
  initialSettings: Record<string, unknown>;
  screenActions: readonly (readonly SettingAction[])[];
  editor: (title: string, initial: string, path: string) => Promise<string | undefined>;
}): Promise<Record<string, unknown>> {
  const agent = await mkdtemp(join(tmpdir(), "pxt-cmd-config-"));
  const cwd = await mkdtemp(join(tmpdir(), "pxt-cwd-config-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  const settingsPath = join(agent, "settings.json");
  const originalHandleInput = SettingsList.prototype.handleInput;
  process.env.PI_CODING_AGENT_DIR = agent;

  try {
    await writeFile(settingsPath, JSON.stringify(options.initialSettings));
    let screenIndex = 0;
    let activeActions: readonly SettingAction[] = [];
    SettingsList.prototype.handleInput = function () {
      expect(this.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "excludeSource" }),
        expect.objectContaining({ id: "excludeEdit" }),
      ]));
      for (const [id, value] of activeActions) {
        this.onChange(id, value);
        if (id === "excludeSource") {
          const edit = this.items.find((item) => item.id === "excludeEdit");
          expect(edit?.values).toEqual(value === "inherit" ? undefined : ["edit"]);
          expect(edit?.currentValue).toBe(value === "inherit" ? "(inherited)" : "(none)");
        }
      }
    };

    const commands: Record<string, { handler: Function }> = {};
    const hostConfig = loadConfig(cwd, true);
    registerContextCommand(
      {
        registerCommand: (name: string, def: { handler: Function }) => {
          commands[name] = def;
        },
      } as never,
      {
        getState: () => null,
        getConfig: () => hostConfig,
        setConfig: () => {},
      },
    );

    const ctx = {
      cwd,
      mode: "tui",
      isProjectTrusted: () => true,
      waitForIdle: async () => {},
      ui: {
        notify: () => {},
        select: async () => "User",
        editor: (title: string, initial: string) =>
          options.editor(title, initial, settingsPath),
        custom: async (factory: Function) => {
          activeActions = options.screenActions[screenIndex] ?? [];
          screenIndex++;
          return await new Promise<unknown>((resolve, reject) => {
            try {
              const view: unknown = factory(
                { requestRender: () => {} },
                {
                  fg: (_color: string, value: string) => value,
                  bold: (value: string) => value,
                },
                {},
                resolve,
              );
              if (
                !view ||
                typeof view !== "object" ||
                !("handleInput" in view) ||
                typeof view.handleInput !== "function"
              ) {
                throw new Error("custom settings view did not expose handleInput");
              }
              view.handleInput("test");
            } catch (error) {
              reject(error);
            }
          });
        },
      },
    };

    await commands.context.handler("config", ctx);
    return JSON.parse(await readFile(settingsPath, "utf-8")) as Record<string, unknown>;
  } finally {
    SettingsList.prototype.handleInput = originalHandleInput;
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    await rm(agent, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("parseContextArgs", () => {
  it("routes overview, list, config, and usage", () => {
    expect(parseContextArgs("")).toBe("overview");
    expect(parseContextArgs("  LIST ")).toBe("list");
    expect(parseContextArgs("config")).toBe("config");
    expect(parseContextArgs("nope")).toBe("usage");
  });
});

describe("formatOverview / formatFileList", () => {
  it("summarizes unique counts, provenance, and command hints", () => {
    const text = formatOverview({
      launchDir: "/proj",
      currentDir: "/proj/app",
      piCount: 1,
      extensionCount: 2,
      uniqueCount: 3,
      config: loaded({ provenance: { workingDirOnly: "user", hideContents: "default", files: "project", exclude: "default" } }),
    });
    expect(text).toContain("launch: /proj");
    expect(text).toContain("tracked: /proj/app");
    expect(text).toContain("3 unique (1 pi, 2 extension)");
    expect(text).toContain("workingDirOnly: on  (user)");
    expect(text).toContain("exclude: (none)  (default)");
    expect(text).toContain("/context list");
    expect(text).toContain("/context config");
  });

  it("lists unique paths with origin labels", () => {
    const text = formatFileList([
      { path: "/proj/AGENTS.md", source: "pi" },
      { path: "/proj/app/AGENTS.md", source: "extension" },
    ]);
    expect(text).toContain("Pi startup:");
    expect(text).toContain("/proj/AGENTS.md");
    expect(text).toContain("Extension:");
    expect(text).toContain("/proj/app/AGENTS.md");
  });
});

describe("collectExtensionFilesFromBranch", () => {
  it("restores unique files from the active branch", () => {
    const files = collectExtensionFilesFromBranch([
      { type: "message" },
      {
        type: "custom_message",
        customType: "pi-xt-context",
        details: { files: ["/proj/AGENTS.md", "/proj/app/AGENTS.md"] },
      },
      {
        type: "custom_message",
        customType: "pi-xt-context",
        details: { files: ["/proj/app/AGENTS.md", "/proj/pkg/AGENTS.md"] },
      },
      {
        type: "custom_message",
        customType: "other",
        details: { files: ["/ignore"] },
      },
    ]);
    expect(files.map((f) => f.path)).toEqual([
      "/proj/AGENTS.md",
      "/proj/app/AGENTS.md",
      "/proj/pkg/AGENTS.md",
    ]);
  });
});

describe("mergeListedFiles", () => {
  it("prefers Pi origin when the same file was also injected", () => {
    const listed = mergeListedFiles(
      [{ path: "/proj/AGENTS.md" }],
      [
        { path: "/proj/AGENTS.md", key: "/proj/AGENTS.md", scopeDir: "/proj", stamp: { mtimeMs: 1, size: 1 } },
        { path: "/proj/app/AGENTS.md", key: "/proj/app/AGENTS.md", scopeDir: "/proj/app", stamp: { mtimeMs: 1, size: 1 } },
      ],
    );
    expect(listed).toEqual([
      { path: "/proj/AGENTS.md", source: "pi" },
      { path: "/proj/app/AGENTS.md", source: "extension" },
    ]);
  });
});

describe("/context command", () => {
  it("stages exclude edits and cancels without saving", async () => {
    const initialSettings = {
      theme: "dark",
      context: { hideContents: true, files: ["CUSTOM.md"] },
    };
    const raw = JSON.stringify(initialSettings);
    const result = await runConfigCommand({
      initialSettings,
      screenActions: [
        [["excludeSource", "override"], ["excludeEdit", "edit"]],
        [["cancel", "cancel"]],
      ],
      editor: async (title, initial, path) => {
        expect(title).toContain("exclusion patterns");
        expect(initial).toBe("");
        expect(await readFile(path, "utf-8")).toBe(raw);
        return "reference/**";
      },
    });
    expect(result).toEqual(initialSettings);
  });

  it("saves an exclude edit only after Save and preserves other keys", async () => {
    const initialSettings = {
      theme: "dark",
      context: { hideContents: true, files: ["CUSTOM.md"] },
    };
    const raw = JSON.stringify(initialSettings);
    const result = await runConfigCommand({
      initialSettings,
      screenActions: [
        [["excludeSource", "override"], ["excludeEdit", "edit"]],
        [["save", "save"]],
      ],
      editor: async (_title, _initial, path) => {
        expect(await readFile(path, "utf-8")).toBe(raw);
        return "reference/**";
      },
    });
    expect(result).toEqual({
      theme: "dark",
      context: {
        hideContents: true,
        files: ["CUSTOM.md"],
        exclude: ["reference/**"],
      },
    });
  });

  it("routes args, lists unique files, and does not save on cancel", async () => {
    const agent = await mkdtemp(join(tmpdir(), "pxt-cmd-"));
    const cwd = await mkdtemp(join(tmpdir(), "pxt-cwd-"));
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    try {
      await writeFile(
        join(agent, "settings.json"),
        JSON.stringify({ context: { hideContents: true } }),
      );

      const notifies: string[] = [];
      let selects = 0;
      let saved = false;
      const commands: Record<string, { handler: Function; getArgumentCompletions?: Function }> = {};
      const cfg = loadConfig(cwd, true);
      const host = {
        getState: () => ({
          currentDir: join(cwd, "app"),
          launchDir: cwd,
          extensionFiles: [
            {
              path: join(cwd, "app", "AGENTS.md"),
              key: "k",
              scopeDir: join(cwd, "app"),
              stamp: { mtimeMs: 1, size: 1 },
            },
          ],
        }),
        getConfig: () => cfg,
        setConfig: () => {
          saved = true;
        },
      };
      registerContextCommand(
        {
          registerCommand: (name: string, def: { handler: Function; getArgumentCompletions?: Function }) => {
            commands[name] = def;
          },
        } as never,
        host,
      );

      const ctx = {
        cwd,
        mode: "tui",
        isProjectTrusted: () => true,
        waitForIdle: async () => {},
        getSystemPromptOptions: () => ({
          cwd,
          contextFiles: [{ path: join(cwd, "AGENTS.md"), content: "x" }],
        }),
        sessionManager: { getBranch: () => [] },
        ui: {
          notify: (msg: string) => notifies.push(msg),
          select: async () => {
            selects++;
            return undefined;
          },
          editor: async () => undefined,
          custom: async () => null,
        },
      };

      await commands.context.handler("", ctx);
      expect(notifies.some((n) => n.includes("pi-xt-context"))).toBe(true);
      expect(notifies.some((n) => n.includes("hideContents: on"))).toBe(true);

      notifies.length = 0;
      await commands.context.handler("list", ctx);
      expect(notifies[0]).toContain("Pi startup:");
      expect(notifies[0]).toContain(join(cwd, "AGENTS.md"));
      expect(notifies[0]).toContain("Extension:");

      notifies.length = 0;
      await commands.context.handler("wat", ctx);
      expect(notifies[0]).toContain("usage: /context [list|config]");

      await commands.context.handler("config", ctx);
      expect(selects).toBe(1);
      expect(saved).toBe(false);

      const completions = commands.context.getArgumentCompletions!("li");
      expect(completions.map((c: { value: string }) => c.value)).toEqual(["list"]);
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
      await rm(agent, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
