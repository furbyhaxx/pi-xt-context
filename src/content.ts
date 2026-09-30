import { readFile, stat } from "node:fs/promises";
import { fileDedupKey } from "./paths.ts";

/** Cap per-file size so one huge/hostile context file can't blow the prompt. */
export const MAX_FILE_BYTES = 64 * 1024;

/** On-disk identity of a file's contents. */
export interface FileStamp {
  mtimeMs: number;
  size: number;
}

export interface ContextText {
  path: string;
  content: string;
  stamp: FileStamp;
}

export function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/** Placeholder for a copy whose stamp was never recorded (pre-0.5.0 sessions). */
export const UNKNOWN_STAMP: FileStamp = { mtimeMs: -1, size: -1 };

export function stampKnown(stamp: FileStamp): boolean {
  return stamp.mtimeMs !== UNKNOWN_STAMP.mtimeMs;
}

interface MemoEntry extends ContextText {
  /**
   * The generation before the current one, kept so a change notice can still
   * diff the text the agent holds after the file has moved once.
   */
  superseded?: { content: string; stamp: FileStamp };
}

const MEMO_MAX = 512;
const memo = new Map<string, MemoEntry>();

/**
 * One text copy per file, shared by every directory that resolves to it. An
 * ancestor context file is otherwise re-read once per touched directory below
 * it, because dedup used to happen after the read. Validated by
 * {mtimeMs, size}, so an unchanged file costs a stat instead of a read.
 */
export async function readContextFile(path: string): Promise<ContextText | null> {
  // Stat first: a missing candidate must not pay for a realpath walk.
  let stats;
  try {
    stats = await stat(path);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;
  const key = fileDedupKey(path);
  const stamp: FileStamp = { mtimeMs: stats.mtimeMs, size: stats.size };
  const hit = memo.get(key);
  if (hit && sameStamp(hit.stamp, stamp)) return { path, content: hit.content, stamp };

  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return null;
  }
  if (content.length > MAX_FILE_BYTES) {
    content = content.slice(0, MAX_FILE_BYTES) + "\n\n[...truncated]";
  }
  if (content.trim().length === 0) return null;

  if (memo.size >= MEMO_MAX) memo.clear();
  const superseded =
    hit?.superseded ?? (hit ? { content: hit.content, stamp: hit.stamp } : undefined);
  memo.set(key, { path, content, stamp, ...(superseded ? { superseded } : {}) });
  return { path, content, stamp };
}

/** The text behind `stamp`, when this process still holds that generation. */
export function heldText(path: string, stamp: FileStamp): string | null {
  const entry = memo.get(fileDedupKey(path));
  if (!entry) return null;
  if (sameStamp(entry.stamp, stamp)) return entry.content;
  if (entry.superseded && sameStamp(entry.superseded.stamp, stamp)) {
    return entry.superseded.content;
  }
  return null;
}
