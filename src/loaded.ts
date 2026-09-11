import { fileDedupKey } from "./paths.ts";

export const CUSTOM_TYPE = "pi-xt-context";

export interface ExtensionLoadedFile {
  path: string;
  key: string;
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
    if (entry.customType !== CUSTOM_TYPE) continue;
    const details = entry.details as { files?: unknown } | undefined;
    const files = details?.files;
    if (!Array.isArray(files)) continue;
    for (const p of files) {
      if (typeof p !== "string" || p.length === 0) continue;
      const key = fileDedupKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path: p, key });
    }
  }
  return out;
}

export interface ListedFile {
  path: string;
  source: "pi" | "extension";
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
