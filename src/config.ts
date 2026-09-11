import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);
const lockfile = require("proper-lockfile") as {
  lockSync: (file: string, opts?: { realpath?: boolean }) => () => void;
};

export type Provenance = "default" | "user" | "project";
export type ConfigKey = "workingDirOnly" | "hideContents" | "files";

export interface Config {
  /** Only load context files under pi's launch (working) dir. Default true. */
  workingDirOnly: boolean;
  /** TUI never shows injected contents, even expanded. Default false. */
  hideContents: boolean;
  /** Glob patterns relative to each walked directory. Default `["AGENTS.md"]`. */
  files: string[];
}

export const DEFAULT_CONFIG: Config = {
  workingDirOnly: true,
  hideContents: false,
  files: ["AGENTS.md"],
};

export const CONFIG_KEYS: ConfigKey[] = [
  "workingDirOnly",
  "hideContents",
  "files",
];

export interface LoadedConfig {
  effective: Config;
  user: Partial<Config>;
  project: Partial<Config>;
  provenance: Record<ConfigKey, Provenance>;
  diagnostics: string[];
  userPath: string;
  projectPath: string;
}

/** `undefined` = leave alone, `null` = remove override, value = set. */
export type ContextPatch = {
  workingDirOnly?: boolean | null;
  hideContents?: boolean | null;
  files?: string[] | null;
};

export function userSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "settings.json");
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Reject absolute paths, `~`, and `..` segments so patterns cannot escape the walk dir. */
export function validatePattern(pattern: string): string | null {
  let p = pattern.replace(/\\/g, "/").trim();
  if (!p) return "empty pattern";
  while (p.startsWith("./")) p = p.slice(2);
  if (!p) return "empty pattern";
  if (p.startsWith("~") || p.startsWith("/") || /^[a-zA-Z]:\//.test(p)) {
    return "absolute patterns are not supported";
  }
  if (isAbsolute(pattern) || isAbsolute(p)) {
    return "absolute patterns are not supported";
  }
  const segs = p.split("/");
  if (segs.some((s) => s === "..")) {
    return "parent-escaping patterns are not supported";
  }
  return null;
}

export function normalizePattern(pattern: string): string {
  let p = pattern.replace(/\\/g, "/").trim();
  while (p.startsWith("./")) p = p.slice(2);
  return p;
}

function parseFilesValue(
  raw: unknown,
  label: string,
): { files?: string[]; diagnostics: string[] } {
  const diagnostics: string[] = [];
  if (!Array.isArray(raw)) {
    diagnostics.push(`${label}: files must be an array of glob strings`);
    return { diagnostics };
  }
  const files: string[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  for (const item of raw) {
    if (typeof item !== "string") {
      diagnostics.push(`${label}: files entries must be strings`);
      invalid++;
      continue;
    }
    const p = normalizePattern(item);
    const err = validatePattern(p);
    if (err) {
      diagnostics.push(`${label}: ignored pattern ${JSON.stringify(item)} (${err})`);
      invalid++;
      continue;
    }
    if (seen.has(p)) continue;
    seen.add(p);
    files.push(p);
  }
  if (raw.length === 0) return { files: [], diagnostics };
  if (files.length === 0 && invalid > 0) {
    diagnostics.push(`${label}: files had no valid patterns; falling back to a lower scope`);
    return { diagnostics };
  }
  return { files, diagnostics };
}

export function parseContextObject(
  raw: unknown,
  label: string,
): { value: Partial<Config>; diagnostics: string[] } {
  if (raw === undefined) return { value: {}, diagnostics: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      value: {},
      diagnostics: [`${label}: context must be a JSON object`],
    };
  }
  const o = raw as Record<string, unknown>;
  const value: Partial<Config> = {};
  const diagnostics: string[] = [];
  if ("workingDirOnly" in o) {
    if (typeof o.workingDirOnly === "boolean") value.workingDirOnly = o.workingDirOnly;
    else diagnostics.push(`${label}: workingDirOnly must be a boolean`);
  }
  if ("hideContents" in o) {
    if (typeof o.hideContents === "boolean") value.hideContents = o.hideContents;
    else diagnostics.push(`${label}: hideContents must be a boolean`);
  }
  if ("files" in o) {
    const parsed = parseFilesValue(o.files, label);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.files) value.files = parsed.files;
  }
  return { value, diagnostics };
}

function readSettingsFile(path: string, label: string): {
  settings: Record<string, unknown>;
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  try {
    const raw = readFileSync(path, "utf-8");
    const v = JSON.parse(stripBom(raw));
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      diagnostics.push(`${label}: ${path} must be a JSON object`);
      return { settings: {}, diagnostics };
    }
    return { settings: v as Record<string, unknown>, diagnostics };
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "ENOENT") {
      return { settings: {}, diagnostics };
    }
    diagnostics.push(`${label}: ${path}: ${err}`);
    return { settings: {}, diagnostics };
  }
}

function mergeScopes(
  user: Partial<Config>,
  project: Partial<Config>,
): Pick<LoadedConfig, "effective" | "provenance"> {
  const provenance = {
    workingDirOnly: "default",
    hideContents: "default",
    files: "default",
  } as Record<ConfigKey, Provenance>;
  const effective: Config = { ...DEFAULT_CONFIG, files: [...DEFAULT_CONFIG.files] };

  const apply = (src: Partial<Config>, scope: Provenance) => {
    if (src.workingDirOnly !== undefined) {
      effective.workingDirOnly = src.workingDirOnly;
      provenance.workingDirOnly = scope;
    }
    if (src.hideContents !== undefined) {
      effective.hideContents = src.hideContents;
      provenance.hideContents = scope;
    }
    if (src.files !== undefined) {
      effective.files = [...src.files];
      provenance.files = scope;
    }
  };
  apply(user, "user");
  apply(project, "project");
  return { effective, provenance };
}

export function loadConfig(cwd: string, projectTrusted: boolean): LoadedConfig {
  const userPath = userSettingsPath();
  const projectPath = projectSettingsPath(cwd);
  const diagnostics: string[] = [];

  const g = readSettingsFile(userPath, "user");
  diagnostics.push(...g.diagnostics);
  const userParsed = parseContextObject(g.settings.context, "user");
  diagnostics.push(...userParsed.diagnostics);

  let projectParsed: { value: Partial<Config>; diagnostics: string[] } = {
    value: {},
    diagnostics: [],
  };
  if (projectTrusted) {
    const p = readSettingsFile(projectPath, "project");
    diagnostics.push(...p.diagnostics);
    projectParsed = parseContextObject(p.settings.context, "project");
    diagnostics.push(...projectParsed.diagnostics);
  }

  const { effective, provenance } = mergeScopes(userParsed.value, projectParsed.value);
  for (const d of diagnostics) {
    console.error(`pi-xt-context: ${d}`);
  }
  return {
    effective,
    user: userParsed.value,
    project: projectParsed.value,
    provenance,
    diagnostics,
    userPath,
    projectPath,
  };
}

function lockWithRetry(path: string): () => void {
  const maxAttempts = 10;
  const delayMs = 20;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return lockfile.lockSync(path, { realpath: false });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: string }).code)
          : undefined;
      if (code !== "ELOCKED" || attempt === maxAttempts) throw error;
      lastError = error;
      const start = Date.now();
      while (Date.now() - start < delayMs) {
        // spin, matching pi's FileSettingsStorage
      }
    }
  }
  throw lastError ?? new Error("Failed to acquire settings lock");
}

function withSettingsLock(
  path: string,
  fn: (current: string | undefined) => string | undefined,
): void {
  const dir = dirname(path);
  let release: (() => void) | undefined;
  try {
    const fileExists = existsSync(path);
    if (fileExists) release = lockWithRetry(path);
    const current = fileExists ? readFileSync(path, "utf-8") : undefined;
    const next = fn(current);
    if (next === undefined) return;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!release) {
      if (!existsSync(path)) writeFileSync(path, "{}\n", "utf-8");
      release = lockWithRetry(path);
    }
    writeFileSync(path, next, "utf-8");
  } finally {
    try {
      release?.();
    } catch {
      // ignore unlock errors
    }
  }
}

export function saveContextSettings(
  scope: "user" | "project",
  cwd: string,
  patch: ContextPatch,
): { ok: true } | { ok: false; error: string } {
  const path = scope === "user" ? userSettingsPath() : projectSettingsPath(cwd);
  try {
    let error: string | undefined;
    withSettingsLock(path, (current) => {
      let settings: Record<string, unknown>;
      if (current === undefined || current.trim() === "") {
        settings = {};
      } else {
        try {
          const v = JSON.parse(stripBom(current));
          if (!v || typeof v !== "object" || Array.isArray(v)) {
            error = `${path} must be a JSON object; refusing to overwrite it`;
            return undefined;
          }
          settings = v as Record<string, unknown>;
        } catch (err) {
          error = `${path} is not valid JSON; refusing to overwrite it (${err})`;
          return undefined;
        }
      }

      const existing = settings.context;
      if (
        existing !== undefined &&
        existing !== null &&
        (typeof existing !== "object" || Array.isArray(existing))
      ) {
        error = `${path}: "context" must be a JSON object; refusing to overwrite it`;
        return undefined;
      }

      const ctx: Record<string, unknown> =
        existing && typeof existing === "object" && !Array.isArray(existing)
          ? { ...(existing as Record<string, unknown>) }
          : {};

      if (patch.workingDirOnly === null) delete ctx.workingDirOnly;
      else if (patch.workingDirOnly !== undefined) ctx.workingDirOnly = patch.workingDirOnly;

      if (patch.hideContents === null) delete ctx.hideContents;
      else if (patch.hideContents !== undefined) ctx.hideContents = patch.hideContents;

      if (patch.files === null) delete ctx.files;
      else if (patch.files !== undefined) ctx.files = patch.files;

      if (Object.keys(ctx).length === 0) delete settings.context;
      else settings.context = ctx;

      return JSON.stringify(settings, null, 2) + "\n";
    });
    if (error) return { ok: false, error };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `failed to save ${path}: ${err}` };
  }
}

export interface ScopeDraft {
  inherit: Record<ConfigKey, boolean>;
  workingDirOnly: boolean;
  hideContents: boolean;
  files: string[];
}

export function filesEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function buildSettingsPatch(
  initial: ScopeDraft,
  draft: ScopeDraft,
): ContextPatch {
  const patch: ContextPatch = {};

  const applyBool = (key: "workingDirOnly" | "hideContents") => {
    if (draft.inherit[key]) {
      if (!initial.inherit[key]) patch[key] = null;
      return;
    }
    if (initial.inherit[key] || initial[key] !== draft[key]) patch[key] = draft[key];
  };
  applyBool("workingDirOnly");
  applyBool("hideContents");

  if (draft.inherit.files) {
    if (!initial.inherit.files) patch.files = null;
  } else if (initial.inherit.files || !filesEqual(initial.files, draft.files)) {
    patch.files = [...draft.files];
  }
  return patch;
}

export function patchIsEmpty(patch: ContextPatch): boolean {
  return (
    patch.workingDirOnly === undefined &&
    patch.hideContents === undefined &&
    patch.files === undefined
  );
}

export function discoveryConfigChanged(a: Config, b: Config): boolean {
  return a.workingDirOnly !== b.workingDirOnly || !filesEqual(a.files, b.files);
}

export function parseFilesEditorText(text: string): {
  files: string[];
  errors: string[];
} {
  const files: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const p = normalizePattern(line);
    if (!p) continue;
    const err = validatePattern(p);
    if (err) {
      errors.push(`${p}: ${err}`);
      continue;
    }
    if (seen.has(p)) continue;
    seen.add(p);
    files.push(p);
  }
  return { files, errors };
}

export function formatPatterns(files: string[]): string {
  return files.length === 0 ? "(none)" : files.join(" · ");
}

export function provenanceLabel(p: Provenance): string {
  return p;
}
