import { dirname } from "node:path";
import { fileDedupKey } from "./paths.ts";
import { UNKNOWN_STAMP, type FileStamp } from "./content.ts";

export const CUSTOM_TYPE = "context";
export const LEGACY_CUSTOM_TYPE = "pi-xt-context";
export const CHANGED_TYPE = "context-changed";

/** Details of an injected block. */
export interface ContextDetails {
  files: string[];
  context: string;
  /**
   * On-disk stamp and scope of each injected copy. A restored session has no
   * memo, so without this it could not tell a later change from a stale agent.
   */
  meta?: InjectedFileMeta[];
}

export interface InjectedFileMeta {
  path: string;
  scopeDir: string;
  mtimeMs: number;
  size: number;
}

/** Details of a change notice; the agent already holds the file's old text. */
export interface ChangeDetails {
  file: string;
  text: string;
}

export interface ExtensionLoadedFile {
  path: string;
  key: string;
  scopeDir: string;
  stamp: FileStamp;
}

export interface BranchEntryLike {
  type?: unknown;
  customType?: unknown;
  details?: unknown;
}

/** Unique extension-injected paths from the active session branch, first-seen order. */
export function collectExtensionFilesFromBranch(
  entries: Iterable<BranchEntryLike>,
): ExtensionLoadedFile[] {
  const out: ExtensionLoadedFile[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry?.type !== "custom_message") continue;
    if (entry.customType !== CUSTOM_TYPE && entry.customType !== LEGACY_CUSTOM_TYPE) continue;
    const details = entry.details as ContextDetails | undefined;
    const files = details?.files;
    if (!Array.isArray(files)) continue;
    const meta = new Map(
      (details?.meta ?? []).map((m) => [m.path, m] as const),
    );
    for (const p of files) {
      if (typeof p !== "string" || p.length === 0) continue;
      const key = fileDedupKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      const m = meta.get(p);
      out.push({
        path: p,
        key,
        scopeDir: m?.scopeDir ?? dirname(p),
        stamp:
          m === undefined
            ? { ...UNKNOWN_STAMP }
            : { mtimeMs: m.mtimeMs, size: m.size },
      });
    }
  }
  return out;
}

export interface ListedFile {
  path: string;
  source: "pi" | "extension";
}

/** Dedup keys of injected files still visible in a message list. */
export function liveKeys(
  messages: Iterable<{ role?: unknown; customType?: unknown; details?: unknown }>,
): Set<string> {
  const keys = new Set<string>();
  for (const message of messages) {
    if (message?.role !== "custom") continue;
    if (message.customType !== CUSTOM_TYPE && message.customType !== LEGACY_CUSTOM_TYPE) {
      continue;
    }
    const files = (message.details as ContextDetails | undefined)?.files;
    if (!Array.isArray(files)) continue;
    for (const p of files) {
      if (typeof p === "string" && p.length > 0) keys.add(fileDedupKey(p));
    }
  }
  return keys;
}

export function mergeListedFiles(
  piFiles: Array<{ path?: unknown } | string>,
  extensionFiles: ExtensionLoadedFile[],
): ListedFile[] {
  const out: ListedFile[] = [];
  const seen = new Set<string>();
  for (const f of piFiles) {
    const path = typeof f === "string" ? f : typeof f?.path === "string" ? f.path : "";
    if (!path) continue;
    const key = fileDedupKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, source: "pi" });
  }
  for (const f of extensionFiles) {
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    out.push({ path: f.path, source: "extension" });
  }
  return out;
}

export function formatFileList(files: ListedFile[]): string {
  if (files.length === 0) return "No context files loaded.";
  const pi = files.filter((f) => f.source === "pi");
  const ext = files.filter((f) => f.source === "extension");
  const lines: string[] = [];
  lines.push("Pi startup:");
  if (pi.length === 0) lines.push("  (none)");
  else for (const f of pi) lines.push(`  ${f.path}`);
  lines.push("Extension:");
  if (ext.length === 0) lines.push("  (none)");
  else for (const f of ext) lines.push(`  ${f.path}`);
  return lines.join("\n");
}
