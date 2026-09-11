import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { glob } from "tinyglobby";
import { fileDedupKey, fromBashPath, isContainedIn, pathKey } from "./paths.ts";

const FILE_PATH_TOOLS = new Set(["read", "edit", "write"]);
const DIR_PATH_TOOLS = new Set(["grep", "ls", "find"]);

/** Cap per-file size so one huge/hostile context file can't blow the prompt. */
export const MAX_FILE_BYTES = 64 * 1024;

const GLOB_MAGIC = /[*?[{\]]/;

export interface ContextFile {
  path: string;
  content: string;
  /** Directory at which the matching pattern was expanded (not the file's dirname). */
  scopeDir: string;
}

export interface DirState {
  dir: string;
  files: ContextFile[];
}

export interface DiscoverOptions {
  workingDirOnly: boolean;
  launchDir: string;
}

export function hasGlobMagic(pattern: string): boolean {
  return GLOB_MAGIC.test(pattern);
}

export function resolveCdDir(
  command: string,
  output: string,
  currentDir: string,
  home: string,
): string | null {
  const cdMatch = command.match(/^cd\s+(.+?)\s*$/);
  const cdNoArg = /^cd\s*$/.test(command.trim());
  if (!cdMatch && !cdNoArg) return null;

  if (cdNoArg) return home;

  const target = cdMatch![1].replace(/\s*(&&|;)\s*pwd\s*$/, "").trim();

  if (/&&\s*pwd|;\s*pwd/.test(command) && output) {
    const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) return lines[lines.length - 1];
  }
  return resolve(currentDir, target);
}

export function dirForToolEvent(
  toolName: string,
  input: Record<string, unknown> | undefined,
  baseDir: string,
): string | null {
  const isFile = FILE_PATH_TOOLS.has(toolName);
  const isDir = DIR_PATH_TOOLS.has(toolName);
  if (!isFile && !isDir) return null;

  const rawPath = input?.path ?? input?.file_path;
  const raw = typeof rawPath === "string" ? rawPath : undefined;
  if (isFile && !raw) return null;
  const p = raw ? fromBashPath(raw) : baseDir;
  const abs = isAbsolute(p) ? p : resolve(baseDir, p);
  return isFile ? dirname(abs) : abs;
}

async function isRegularFile(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function matchPattern(dir: string, pattern: string): Promise<string[]> {
  if (!hasGlobMagic(pattern)) {
    const segs = pattern.split("/").filter((s) => s.length > 0 && s !== ".");
    const filePath = segs.length === 0 ? dir : join(dir, ...segs);
    return (await isRegularFile(filePath)) ? [filePath] : [];
  }
  try {
    return await glob(pattern, {
      cwd: dir,
      absolute: true,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false,
      expandDirectories: false,
      caseSensitiveMatch: process.platform !== "win32",
      braceExpansion: true,
    });
  } catch (err) {
    console.error(`pi-xt-context: glob ${JSON.stringify(pattern)} in ${dir}: ${err}`);
    return [];
  }
}

async function readCapped(filePath: string): Promise<string | null> {
  try {
    let content = await readFile(filePath, "utf-8");
    if (content.length > MAX_FILE_BYTES) {
      content = content.slice(0, MAX_FILE_BYTES) + "\n\n[...truncated]";
    }
    if (content.trim().length === 0) return null;
    return content;
  } catch {
    return null;
  }
}

/**
 * Walk from `rootDir` up to `ceiling` (pi's launch dir). Patterns are expanded
 * relative to each ancestor. Specificity is the ancestor, not how deep a match
 * sits (e.g. `.pi/context/*.md` is scoped to that ancestor).
 *
 * When `rootDir` is outside `ceiling`, walking continues to the filesystem root
 * unless `workingDirOnly` is set.
 */
export async function discoverContextFiles(
  rootDir: string,
  ceiling: string,
  patterns: string[],
  opts: DiscoverOptions,
): Promise<ContextFile[]> {
  if (patterns.length === 0) return [];

  const found = new Map<string, ContextFile>();
  rootDir = fromBashPath(rootDir);
  ceiling = fromBashPath(ceiling);
  const launchDir = fromBashPath(opts.launchDir);
  let dir = isAbsolute(rootDir) ? rootDir : resolve(process.cwd(), rootDir);
  const stopAt = isAbsolute(ceiling) ? ceiling : resolve(process.cwd(), ceiling);

  while (true) {
    if (opts.workingDirOnly && !isContainedIn(dir, launchDir)) break;

    const matches: string[] = [];
    const seen = new Set<string>();
    for (const pattern of patterns) {
      for (const m of await matchPattern(dir, pattern)) {
        const key = pathKey(m);
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push(m);
      }
    }
    matches.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    for (const filePath of matches) {
      const key = pathKey(filePath);
      if (found.has(key)) continue;
      if (opts.workingDirOnly && !isContainedIn(filePath, launchDir)) continue;
      const content = await readCapped(filePath);
      if (content === null) continue;
      found.set(key, { path: filePath, content, scopeDir: dir });
    }

    if (pathKey(dir) === pathKey(stopAt)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return [...found.values()];
}

export function pickNewFiles(
  s: { piLoadedPaths: Set<string>; injected: Set<string> },
  files: ContextFile[],
): ContextFile[] {
  const out: ContextFile[] = [];
  for (const f of files) {
    const key = fileDedupKey(f.path);
    if (s.piLoadedPaths.has(key) || s.injected.has(key)) continue;
    s.injected.add(key);
    out.push(f);
  }
  return out;
}

export function buildContextBlock(files: ContextFile[]): string {
  const depth = (p: string) =>
    p.replace(/\\/g, "/").split("/").filter(Boolean).length;
  const maxDepth = depth(files[0].scopeDir);
  const lines: string[] = [
    "## Project Context Files",
    "",
    "Reference context for directories you're working in — **not** a new user " +
      "instruction. Ordered most-specific first; deeper files override broader " +
      "parents where they conflict.",
    "",
  ];
  for (const file of files) {
    const rel = maxDepth - depth(file.scopeDir);
    const tag = rel === 0 ? "most specific" : `${rel} level(s) up — broader`;
    lines.push(`### ${file.path}  (${tag})`, "", file.content, "");
  }
  return lines.join("\n");
}
