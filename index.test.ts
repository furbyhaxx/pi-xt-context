import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import piXtContext, { applyLoadedConfig, restoreLoadedFromContext, type State } from "./index.ts";
import { DEFAULT_CONFIG, loadConfig } from "./src/config.ts";

describe("extension factory", () => {
  it("restores injected files, lists uniquely, and clears scan cache on discovery change", async () => {
    const agent = await mkdtemp(join(tmpdir(), "pxt-idx-"));
    const cwd = await mkdtemp(join(tmpdir(), "pxt-cwd-"));
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    try {
      const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
      const sessionHandlers: Array<(e: unknown, ctx: unknown) => void> = [];
      piXtContext({
        registerMessageRenderer() {},
        registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
          commands[name] = def;
        },
        on(event: string, handler: (e: unknown, ctx: unknown) => void) {
          if (event === "session_start") sessionHandlers.push(handler);
        },
        sendMessage: async () => {},
      } as never);

      expect(Object.keys(commands)).toEqual(["context"]);

      const ctx = {
        cwd,
        isProjectTrusted: () => true,
        sessionManager: {
          getBranch: () => [
            {
              type: "custom_message",
              customType: "on-demand-context",
              details: { files: [join(cwd, "AGENTS.md")] },
            },
          ],
        },
      };
      for (const h of sessionHandlers) h({ reason: "startup" }, ctx);

      const notifies: string[] = [];
      await commands.context.handler("list", {
        cwd,
        getSystemPromptOptions: () => ({
          cwd,
          contextFiles: [{ path: join(cwd, "AGENTS.md"), content: "x" }],
        }),
        ui: { notify: (msg: string) => notifies.push(msg) },
      });
      expect(notifies[0]).toContain("Pi startup:");
      expect(notifies[0]).toContain(join(cwd, "AGENTS.md"));
      expect(notifies[0]).not.toContain("Extension:\n  " + join(cwd, "AGENTS.md"));

      await writeFile(
        join(agent, "settings.json"),
        JSON.stringify({ context: { files: ["CLAUDE.md"] } }),
      );
      const next = loadConfig(cwd, true);
      expect(next.effective.files).toEqual(["CLAUDE.md"]);
      applyLoadedConfig(next, true);
      expect(next.effective).not.toEqual(DEFAULT_CONFIG);
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
      await rm(agent, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("restoreLoadedFromContext", () => {
  it("rebuilds injected keys from custom messages on the branch", () => {
    const s: State = {
      currentDir: "/proj",
      dirContexts: new Map(),
      piLoadedPaths: new Set(),
      injected: new Set(["stale"]),
      inFlight: new Set(),
      launchDir: "/proj",
      scanGeneration: 0,
      extensionFiles: [],
    };
    restoreLoadedFromContext(s, {
      sessionManager: {
        getBranch: () => [
          {
            type: "custom_message",
            customType: "pi-xt-context",
            details: { files: ["/proj/app/AGENTS.md"] },
          },
        ],
      },
    } as never);
    expect(s.injected.has("stale")).toBe(false);
    expect(s.extensionFiles.map((f) => f.path)).toEqual(["/proj/app/AGENTS.md"]);
    expect(s.injected.size).toBe(1);
  });
});
