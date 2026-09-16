import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

/** msys/git-bash emits `/c/Users/...`; node fs on win32 needs `C:\...`. No-op on POSIX. */
export function fromBashPath(p: string): string {
  if (process.platform !== "win32") return p;
  const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}` : p;
}

/** Dedup key for directories: bash→win, unify separators, lowercase only on win32. */
export function pathKey(p: string): string {
  const s = fromBashPath(p).replace(/\\/g, "/");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/**
 * Canonical dedup key for a context file: realpath so symlink/junction aliases
 * of the same physical file collapse. Falls back to pathKey when unresolvable.
 * Display always uses the as-found path.
 */
export function fileDedupKey(p: string): string {
  try {
    return pathKey(realpathSync(p));
  } catch {
    return pathKey(p);
  }
}

/** Prefer a workspace-relative, slash-normalized display path when contained. */
export function workspaceDisplayPath(filePath: string, workspace: string): string {
  const rel = relative(workspace, filePath);
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!rel || outside) return filePath;
  return rel.replace(/\\/g, "/");
}

/**
 * True if `child` is `parent` or anywhere inside its subtree.
 * Normalizes bash→win format and separators; case-insensitive only on win32.
 */
export function isUnderOrEqual(child: string, parent: string): boolean {
  const c = fromBashPath(child).replace(/\\/g, "/");
  const p = fromBashPath(parent).replace(/\\/g, "/");
  const win = process.platform === "win32";
  const a = win ? c.toLowerCase() : c;
  const b = win ? p.toLowerCase() : p;
  return a === b || a.startsWith(b.endsWith("/") ? b : b + "/");
}

/** Containment after resolving symlinks, so a link inside the project cannot leak `/etc`. */
export function isContainedIn(child: string, parent: string): boolean {
  try {
    return isUnderOrEqual(realpathSync(child), realpathSync(parent));
  } catch {
    try {
      return isUnderOrEqual(child, realpathSync(parent));
    } catch {
      return isUnderOrEqual(child, parent);
    }
  }
}
