/**
 * pi-xt-context
 *
 * Automatically loads nested context files (default: AGENTS.md) when the model
 * works in a directory — by `cd`-ing into it, or by touching a file there with
 * any file tool (read/edit/write/grep/ls/find). Context is injected once,
 * durably, the moment a dir is touched — before the model's next response
 * (discovery is awaited inside the tool_result hook).
 *
 * Complements pi's own startup loader (deduped against it).
 *
 * Config lives under the top-level "context" key in pi settings.json
 * (user: <agentDir>/settings.json, project: <cwd>/.pi/settings.json).
 * `/context` (overview), `/context list`, `/context config`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isAbsolute } from "node:path";
import { registerContextCommand, type ContextCommandHost } from "./src/commands.ts";
import {
  DEFAULT_CONFIG,
  loadConfig,
  type LoadedConfig,
} from "./src/config.ts";
import {
  buildContextBlock,
  dirForToolEvent,
  discoverContextFiles,
  pickNewFiles,
  resolveCdDir,
  type ContextFile,
  type DirState,
} from "./src/discovery.ts";
import {
  collectExtensionFilesFromBranch,
  CUSTOM_TYPE,
  LEGACY_CUSTOM_TYPE,
  type ExtensionLoadedFile,
} from "./src/loaded.ts";
import {
  fileDedupKey,
  fromBashPath,
  isContainedIn,
  pathKey,
  workspaceDisplayPath,
} from "./src/paths.ts";

export {
  buildContextBlock,
  dirForToolEvent,
  discoverContextFiles,
  pickNewFiles,
  resolveCdDir,
} from "./src/discovery.ts";
export {
  buildSettingsPatch,
  DEFAULT_CONFIG,
  loadConfig,
  parseFilesEditorText,
  saveContextSettings,
  validatePattern,
} from "./src/config.ts";
export {
  fileDedupKey,
  isUnderOrEqual,
  pathKey,
  workspaceDisplayPath,
} from "./src/paths.ts";
export { parseContextArgs } from "./src/commands.ts";
export {
  collectExtensionFilesFromBranch,
  formatFileList,
  mergeListedFiles,
} from "./src/loaded.ts";

interface ContextDetails {
  files: string[];
  context?: string;
}

export interface State {
  currentDir: string;
  dirContexts: Map<string, DirState>;
  piLoadedPaths: Set<string>;
  injected: Set<string>;
  inFlight: Set<string>;
  launchDir: string;
  scanGeneration: number;
  extensionFiles: ExtensionLoadedFile[];
}

function emptyLoaded(): LoadedConfig {
  return {
    effective: { ...DEFAULT_CONFIG, files: [...DEFAULT_CONFIG.files] },
    user: {},
    project: {},
    provenance: {
      workingDirOnly: "default",
      hideContents: "default",
      files: "default",
    },
    diagnostics: [],
    userPath: "",
    projectPath: "",
  };
}

let state: State | null = null;
let config: LoadedConfig = emptyLoaded();

function initState(cwd: string): State {
  return {
    currentDir: cwd,
    dirContexts: new Map(),
    piLoadedPaths: new Set(),
    injected: new Set(),
    inFlight: new Set(),
    launchDir: cwd,
    scanGeneration: 0,
    extensionFiles: [],
  };
}

export function restoreLoadedFromContext(s: State, ctx: ExtensionContext): void {
  const files = collectExtensionFilesFromBranch(ctx.sessionManager.getBranch());
  s.extensionFiles = files;
  s.injected = new Set(files.map((f) => f.key));
}

export function applyLoadedConfig(
  next: LoadedConfig,
  discoveryChanged: boolean,
): void {
  config = next;
  if (!discoveryChanged || !state) return;
  state.dirContexts.clear();
  state.scanGeneration += 1;
}

function seedPiLoaded(
  s: State,
  contextFiles: Array<{ path?: string } | string> | undefined,
): void {
  for (const cf of contextFiles ?? []) {
    const p = typeof cf === "string" ? cf : cf?.path;
    if (p) s.piLoadedPaths.add(fileDedupKey(p));
  }
}

export default function piXtContext(pi: ExtensionAPI) {
  state = initState(process.cwd());
  config = loadConfig(process.cwd(), false);

  const renderContextMessage = (
    message: {
      content: string | Array<{ type: string; text?: string }>;
      details?: ContextDetails;
    },
    options: { expanded?: boolean; outputPad?: number },
    theme: { fg: (name: string, text: string) => string },
  ) => {
    if (options.expanded && !config.effective.hideContents) {
      const text = message.details?.context ??
        (typeof message.content === "string"
          ? message.content
          : message.content
              .filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join("\n"));
      return new Text(theme.fg("muted", text), options.outputPad, 0);
    }
    const files = message.details?.files;
    const paths = files && files.length > 0
      ? files.map((path) => workspaceDisplayPath(path, state?.launchDir ?? process.cwd())).join(", ")
      : "context files";
    return new Text(
      theme.fg("customMessageLabel", "[context] loaded ") + theme.fg("muted", paths),
      options.outputPad,
      0,
    );
  };

  pi.registerMessageRenderer<ContextDetails>(CUSTOM_TYPE, renderContextMessage);
  pi.registerMessageRenderer<ContextDetails>(LEGACY_CUSTOM_TYPE, renderContextMessage);

  pi.on("context", (event) => {
    let changed = false;
    const messages = event.messages.map((message) => {
      if (message.role !== "custom" || message.customType !== CUSTOM_TYPE) return message;
      const details = message.details as ContextDetails | undefined;
      if (!details?.context) return message;
      changed = true;
      return { ...message, content: [{ type: "text" as const, text: details.context }] };
    });
    if (changed) return { messages };
  });

  pi.on("tool_result", async (event) => {
    if (!state || event.isError) return;

    let targetDir: string | null = null;

    if (event.toolName === "bash") {
      const command = event.input?.command ?? "";
      const rawOutput = (event.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const output = rawOutput.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "").trim();

      const home = process.env.HOME ?? process.env.USERPROFILE ?? state.currentDir;
      const newDir = resolveCdDir(command, output, state.currentDir, home);

      if (!newDir || !isAbsolute(newDir) || newDir.length < 2) return;
      if (newDir !== state.currentDir) state.currentDir = newDir;
      targetDir = newDir;
    } else {
      targetDir = dirForToolEvent(event.toolName, event.input, state.launchDir);
    }

    if (!targetDir) return;
    const dir = fromBashPath(targetDir);

    if (config.effective.workingDirOnly && !isContainedIn(dir, state.launchDir)) {
      return;
    }

    const dirKey = pathKey(dir);
    if (state.dirContexts.has(dirKey) || state.inFlight.has(dirKey)) return;

    const generation = state.scanGeneration;
    state.inFlight.add(dirKey);
    let fresh: ContextFile[] = [];
    try {
      const files = await discoverContextFiles(
        dir,
        state.launchDir,
        config.effective.files,
        {
          workingDirOnly: config.effective.workingDirOnly,
          launchDir: state.launchDir,
        },
      );
      if (!state) return;
      if (state.scanGeneration !== generation) return;
      fresh = pickNewFiles(state, files);
      if (state.scanGeneration !== generation) {
        for (const f of fresh) state.injected.delete(fileDedupKey(f.path));
        return;
      }
      if (fresh.length === 0) {
        state.dirContexts.set(dirKey, { dir, files });
        return;
      }
      try {
        const context = buildContextBlock(fresh);
        const displayPaths = fresh.map((f) => workspaceDisplayPath(f.path, state!.launchDir));
        await pi.sendMessage(
          {
            customType: CUSTOM_TYPE,
            content: displayPaths.join(", "),
            display: true,
            details: { files: fresh.map((f) => f.path), context },
          },
          { deliverAs: "steer" },
        );
      } catch (err) {
        for (const f of fresh) state.injected.delete(fileDedupKey(f.path));
        console.error(`pi-xt-context: failed to inject context for ${dir}: ${err}`);
        return;
      }
      for (const f of fresh) {
        const key = fileDedupKey(f.path);
        if (!state.extensionFiles.some((e) => e.key === key)) {
          state.extensionFiles.push({ path: f.path, key });
        }
      }
      if (state.scanGeneration !== generation) return;
      state.dirContexts.set(dirKey, { dir, files });
    } finally {
      state?.inFlight.delete(dirKey);
    }
  });

  pi.on("before_agent_start", (event) => {
    if (!state) return;
    seedPiLoaded(state, event.systemPromptOptions?.contextFiles);
  });

  const host: ContextCommandHost = {
    getState: () => state,
    getConfig: () => config,
    setConfig: applyLoadedConfig,
  };
  registerContextCommand(pi, host);

  const onSession = (_event: unknown, ctx: ExtensionContext) => {
    state = initState(ctx.cwd);
    config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    restoreLoadedFromContext(state, ctx);
  };
  pi.on("session_start", onSession);
  pi.on("session_tree", (_event, ctx) => {
    if (!state) return;
    restoreLoadedFromContext(state, ctx);
    state.dirContexts.clear();
    state.scanGeneration += 1;
  });
}
