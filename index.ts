/**
 * pi-xt-context
 *
 * Automatically loads nested context files (default: AGENTS.md) when the model
 * works in a directory — by `cd`-ing into it, or by touching a file there with
 * any file tool (read/edit/write/grep/ls/find). Context is injected the moment a
 * dir is touched — before the model's next response (discovery is awaited
 * inside the tool_result hook).
 *
 * The agent never receives the same text twice: a file it read itself is never
 * injected, a file whose text moved gets a bounded diff notice instead of a
 * second copy, and a file whose injection a compaction boundary dropped is
 * injected again because the agent no longer holds it.
 *
 * Complements pi's own startup loader (deduped against it).
 *
 * Config lives under the top-level "context" key in pi settings.json
 * (user: <agentDir>/settings.json, project: <cwd>/.pi/settings.json).
 * `/context` (overview), `/context list`, `/context config`.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isAbsolute, resolve } from "node:path";
import { registerContextCommand, type ContextCommandHost } from "./src/commands.ts";
import {
  DEFAULT_CONFIG,
  loadConfig,
  type LoadedConfig,
} from "./src/config.ts";
import {
  heldText,
  readContextFile,
  sameStamp,
  stampKnown,
  type ContextText,
  type FileStamp,
} from "./src/content.ts";
import { decide } from "./src/decide.ts";
import { formatChangeNotice } from "./src/diff.ts";
import {
  buildContextBlock,
  dirForToolEvent,
  discoverContextFiles,
  resolveCdDir,
  type ContextFile,
  type DirState,
} from "./src/discovery.ts";
import {
  collectExtensionFilesFromBranch,
  liveKeys,
  CHANGED_TYPE,
  CUSTOM_TYPE,
  LEGACY_CUSTOM_TYPE,
  type ChangeDetails,
  type ContextDetails,
  type ExtensionLoadedFile,
  type InjectedFileMeta,
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
  liveKeys,
  mergeListedFiles,
} from "./src/loaded.ts";
export {
  heldText,
  readContextFile,
  sameStamp,
  stampKnown,
  UNKNOWN_STAMP,
  type FileStamp,
} from "./src/content.ts";
export { decide, type ContextAction } from "./src/decide.ts";
export { diffLines, formatChangeNotice, type FileChange } from "./src/diff.ts";

/** An injected file plus the on-disk stamp of the exact text the agent holds. */
export interface TrackedFile {
  path: string;
  key: string;
  scopeDir: string;
  stamp: FileStamp;
}

export interface State {
  currentDir: string;
  dirContexts: Map<string, DirState>;
  piLoadedPaths: Set<string>;
  /** Files the agent read with the read tool this session. */
  agentRead: Set<string>;
  tracked: Map<string, TrackedFile>;
  /** Tracked files whose injected text is still in the model's context. */
  live: Set<string>;
  /** Injected since the last `context` event; treated as live until observed. */
  pending: Set<string>;
  liveKnown: boolean;
  inFlight: Set<string>;
  launchDir: string;
  scanGeneration: number;
  turn: number;
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
    agentRead: new Set(),
    tracked: new Map(),
    live: new Set(),
    pending: new Set(),
    liveKnown: false,
    inFlight: new Set(),
    launchDir: cwd,
    scanGeneration: 0,
    turn: 0,
  };
}

export function restoreLoadedFromContext(s: State, ctx: ExtensionContext): void {
  const files = collectExtensionFilesFromBranch(ctx.sessionManager.getBranch());
  s.tracked = new Map(
    files.map((f) => [
      f.key,
      { path: f.path, key: f.key, scopeDir: f.scopeDir, stamp: f.stamp },
    ]),
  );
  s.live = liveKeys(ctx.sessionManager.buildSessionProjection().messages);
  s.pending.clear();
  s.liveKnown = true;
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
  contextFiles: Array<{ path?: string }> | string[] | undefined,
): void {
  for (const cf of contextFiles ?? []) {
    const p = typeof cf === "string" ? cf : cf?.path;
    if (p) s.piLoadedPaths.add(fileDedupKey(p));
  }
}

function isLive(s: State, key: string): boolean {
  return s.live.has(key) || s.pending.has(key);
}

function inScope(s: State, scopeDir: string): boolean {
  return !config.effective.workingDirOnly || isContainedIn(scopeDir, s.launchDir);
}

/**
 * Whether the agent's copy of a tracked file differs from disk. A session entry
 * written before stamps existed carries none, so the first observation adopts
 * what is on disk instead of reporting a change that cannot be described.
 */
function changedSince(tracked: TrackedFile, stamp: FileStamp): boolean {
  if (!stampKnown(tracked.stamp)) {
    tracked.stamp = stamp;
    return false;
  }
  return !sameStamp(tracked.stamp, stamp);
}

/**
 * A read result only reaches the model for a complete, top-level read: a nested
 * call's output stays inside its parent tool result, and a partial read gives
 * the model a slice, not the file.
 */
function noteAgentRead(s: State, event: ToolResultEvent): void {
  if (event.toolName !== "read" || event.parentToolCallId) return;
  const input = event.input;
  if (input.offset !== undefined || input.limit !== undefined) return;
  const raw = input.path ?? input.file_path;
  if (typeof raw !== "string" || raw.length === 0) return;
  const abs = isAbsolute(raw) ? raw : resolve(s.launchDir, raw);
  s.agentRead.add(fileDedupKey(fromBashPath(abs)));
}

type RenderOptions = Parameters<MessageRenderer>[1];
type RenderTheme = Parameters<MessageRenderer>[2];

function metaFor(files: ContextFile[]): InjectedFileMeta[] {
  return files.map((f) => ({
    path: f.path,
    scopeDir: f.scopeDir,
    mtimeMs: f.stamp.mtimeMs,
    size: f.stamp.size,
  }));
}

function displayPaths(s: State, files: ContextFile[]): string {
  return files.map((f) => workspaceDisplayPath(f.path, s.launchDir)).join(", ");
}

async function sendBlock(
  pi: ExtensionAPI,
  s: State,
  files: ContextFile[],
): Promise<void> {
  const details: ContextDetails = {
    files: files.map((f) => f.path),
    context: buildContextBlock(files),
    meta: metaFor(files),
  };
  await pi.sendMessage(
    { customType: CUSTOM_TYPE, content: displayPaths(s, files), display: true, details },
    { deliverAs: "steer" },
  );
  for (const f of files) {
    const key = fileDedupKey(f.path);
    s.tracked.set(key, { path: f.path, key, scopeDir: f.scopeDir, stamp: f.stamp });
    s.pending.add(key);
  }
}

async function sendNotice(
  pi: ExtensionAPI,
  s: State,
  path: string,
  previous: string | null,
  current: ContextText,
): Promise<void> {
  const details: ChangeDetails = {
    file: path,
    text: formatChangeNotice(path, { path, previous, current }),
  };
  await pi.sendMessage(
    {
      customType: CHANGED_TYPE,
      content: workspaceDisplayPath(path, s.launchDir),
      display: true,
      details,
    },
    { deliverAs: "steer" },
  );
}

export default function piXtContext(pi: ExtensionAPI) {
  state = initState(process.cwd());
  config = loadConfig(process.cwd(), false);

  const renderContextMessage = (
    message: {
      content: string | Array<{ type: string; text?: string }>;
      details?: ContextDetails;
    },
    options: RenderOptions,
    theme: RenderTheme,
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

  const renderChangeMessage = (
    message: { details?: ChangeDetails },
    options: RenderOptions,
    theme: RenderTheme,
  ) => {
    const file = message.details?.file;
    return new Text(
      theme.fg("customMessageLabel", "[context] changed ") +
        theme.fg(
          "muted",
          file ? workspaceDisplayPath(file, state?.launchDir ?? process.cwd()) : "context file",
        ),
      options.outputPad,
      0,
    );
  };

  pi.registerMessageRenderer<ContextDetails>(CUSTOM_TYPE, renderContextMessage);
  pi.registerMessageRenderer<ContextDetails>(LEGACY_CUSTOM_TYPE, renderContextMessage);
  pi.registerMessageRenderer<ChangeDetails>(CHANGED_TYPE, renderChangeMessage);

  pi.on("context", (event) => {
    let changed = false;
    const messages = event.messages.map((message) => {
      if (message.role !== "custom") return message;
      if (message.customType === CHANGED_TYPE) {
        const details = message.details as ChangeDetails | undefined;
        if (!details?.text) return message;
        changed = true;
        return { ...message, content: [{ type: "text" as const, text: details.text }] };
      }
      if (message.customType !== CUSTOM_TYPE) return message;
      const details = message.details as ContextDetails | undefined;
      if (!details?.context) return message;
      changed = true;
      return { ...message, content: [{ type: "text" as const, text: details.context }] };
    });
    if (state) {
      state.live = liveKeys(event.messages);
      state.pending.clear();
      state.liveKnown = true;
    }
    if (changed) return { messages };
  });

  const discoverDir = async (
    s: State,
    dir: string,
    dirKey: string,
    generation: number,
  ): Promise<void> => {
    const files = await discoverContextFiles(dir, s.launchDir, config.effective.files, {
      workingDirOnly: config.effective.workingDirOnly,
      launchDir: s.launchDir,
    });
    if (state !== s || s.scanGeneration !== generation) return;

    const fresh: ContextFile[] = [];
    const keys: string[] = [];
    for (const file of files) {
      const key = fileDedupKey(file.path);
      keys.push(key);
      const tracked = s.tracked.get(key);
      if (s.agentRead.has(key) && !tracked) {
        // The agent read this file itself, so it is never injected — but it is
        // a loaded context file, and this read is the best baseline we have for
        // its stamp. Adopting silently beats reporting a change we cannot diff.
        s.tracked.set(key, {
          path: file.path,
          key,
          scopeDir: file.scopeDir,
          stamp: file.stamp,
        });
        continue;
      }
      const action = decide({
        piLoaded: s.piLoadedPaths.has(key),
        agentRead: s.agentRead.has(key),
        injected: tracked !== undefined,
        live: isLive(s, key),
        liveKnown: s.liveKnown,
        changed: tracked ? changedSince(tracked, file.stamp) : false,
      });
      if (action === "inject") {
        fresh.push(file);
      } else if (action === "notice" && tracked) {
        const previous = heldText(file.path, tracked.stamp);
        try {
          await sendNotice(pi, s, file.path, previous, {
            path: file.path,
            content: file.content,
            stamp: file.stamp,
          });
        } catch (err) {
          console.error(`pi-xt-context: failed to report change of ${file.path}: ${err}`);
        }
        if (state !== s || s.scanGeneration !== generation) return;
      }
    }
    if (fresh.length > 0) {
      try {
        await sendBlock(pi, s, fresh);
      } catch (err) {
        console.error(`pi-xt-context: failed to inject context for ${dir}: ${err}`);
        return;
      }
      if (state !== s || s.scanGeneration !== generation) return;
    }
    s.dirContexts.set(dirKey, { dir, files: keys, turn: s.turn });
  };

  const recheckDir = async (
    s: State,
    record: DirState,
    generation: number,
  ): Promise<void> => {
    for (const key of record.files) {
      const tracked = s.tracked.get(key);
      if (!tracked) continue;
      const previous = heldText(tracked.path, tracked.stamp);
      const current = await readContextFile(tracked.path);
      if (state !== s || s.scanGeneration !== generation) return;
      if (!current) continue;
      const action = decide({
        piLoaded: s.piLoadedPaths.has(key),
        agentRead: s.agentRead.has(key),
        injected: true,
        live: isLive(s, key),
        liveKnown: s.liveKnown,
        changed: changedSince(tracked, current.stamp),
      });
      if (action === "notice") {
        try {
          await sendNotice(pi, s, current.path, previous, current);
        } catch (err) {
          console.error(`pi-xt-context: failed to report change of ${current.path}: ${err}`);
        }
        if (state !== s || s.scanGeneration !== generation) return;
      } else if (action === "inject") {
        try {
          await sendBlock(pi, s, [
            { path: current.path, content: current.content, stamp: current.stamp, scopeDir: tracked.scopeDir },
          ]);
        } catch (err) {
          console.error(`pi-xt-context: failed to re-inject ${current.path}: ${err}`);
        }
        if (state !== s || s.scanGeneration !== generation) return;
      }
    }
    record.turn = s.turn;
  };

  pi.on("tool_result", async (event) => {
    if (!state || event.isError) return;
    const s = state;
    noteAgentRead(s, event);

    let targetDir: string | null = null;

    if (event.toolName === "bash") {
      const command = event.input?.command ?? "";
      const rawOutput = (event.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const output = rawOutput.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "").trim();

      const home = process.env.HOME ?? process.env.USERPROFILE ?? s.currentDir;
      const newDir = resolveCdDir(command, output, s.currentDir, home);

      if (!newDir || !isAbsolute(newDir) || newDir.length < 2) return;
      if (newDir !== s.currentDir) s.currentDir = newDir;
      targetDir = newDir;
    } else {
      targetDir = dirForToolEvent(event.toolName, event.input, s.launchDir);
    }

    if (!targetDir) return;
    const dir = fromBashPath(targetDir);

    if (config.effective.workingDirOnly && !isContainedIn(dir, s.launchDir)) {
      return;
    }

    const dirKey = pathKey(dir);
    const known = s.dirContexts.get(dirKey);
    if (s.inFlight.has(dirKey) || (known && known.turn === s.turn)) return;

    const generation = s.scanGeneration;
    s.inFlight.add(dirKey);
    try {
      if (known) await recheckDir(s, known, generation);
      else await discoverDir(s, dir, dirKey, generation);
    } finally {
      s.inFlight.delete(dirKey);
    }
  });

  pi.on("turn_start", (event) => {
    if (state) state.turn = event.turnIndex;
  });

  // Compaction rewrites the model's context. `buildSessionProjection()` is the
  // same projection pi sends to the provider, so what it omits is what the agent
  // no longer holds — and those files have to come back.
  pi.on("session_compact", async (_event, ctx) => {
    if (!state) return;
    const s = state;
    s.live = liveKeys(ctx.sessionManager.buildSessionProjection().messages);
    s.pending.clear();
    s.liveKnown = true;

    const hidden = [...s.tracked.values()].filter(
      (t) =>
        !s.live.has(t.key) &&
        !s.piLoadedPaths.has(t.key) &&
        !s.agentRead.has(t.key) &&
        inScope(s, t.scopeDir),
    );
    if (hidden.length === 0) return;

    const files: ContextFile[] = [];
    for (const t of hidden) {
      if (state !== s) return;
      const text = await readContextFile(t.path);
      if (!text) continue;
      files.push({
        path: text.path,
        content: text.content,
        stamp: text.stamp,
        scopeDir: t.scopeDir,
      });
    }
    if (files.length === 0) return;
    try {
      await sendBlock(pi, s, files);
    } catch (err) {
      console.error(`pi-xt-context: failed to re-inject after compaction: ${err}`);
    }
  });

  pi.on("before_agent_start", (event) => {
    if (!state) return;
    seedPiLoaded(state, event.systemPromptOptions?.contextFiles);
  });

  const host: ContextCommandHost = {
    getState: () =>
      state
        ? {
            currentDir: state.currentDir,
            launchDir: state.launchDir,
            extensionFiles: [...state.tracked.values()]
              .filter((t) => !state!.agentRead.has(t.key))
              .map(
                (t): ExtensionLoadedFile => ({
                  path: t.path,
                  key: t.key,
                  scopeDir: t.scopeDir,
                  stamp: t.stamp,
                }),
              ),
          }
        : null,
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
