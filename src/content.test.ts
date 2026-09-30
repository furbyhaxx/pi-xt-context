import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { heldText, readContextFile, sameStamp, MAX_FILE_BYTES } from "./content.ts";

async function withTree(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pxt-content-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("readContextFile", () => {
  it("returns null for a missing path, a directory, and an empty file", async () => {
    await withTree(async (root) => {
      await mkdir(join(root, "dir"), { recursive: true });
      await writeFile(join(root, "empty.md"), "   \n");
      expect(await readContextFile(join(root, "nope.md"))).toBeNull();
      expect(await readContextFile(join(root, "dir"))).toBeNull();
      expect(await readContextFile(join(root, "empty.md"))).toBeNull();
    });
  });

  it("caps oversized files", async () => {
    await withTree(async (root) => {
      const file = join(root, "big.md");
      await writeFile(file, "x".repeat(MAX_FILE_BYTES + 10));
      const text = await readContextFile(file);
      expect(text?.content.endsWith("[...truncated]")).toBe(true);
      expect(text?.content.length).toBeLessThan(MAX_FILE_BYTES + 20);
    });
  });

  it("serves the memoized text until the file moves", async () => {
    await withTree(async (root) => {
      const file = join(root, "AGENTS.md");
      await writeFile(file, "one\n");
      const first = await readContextFile(file);
      const again = await readContextFile(file);
      expect(again?.content).toBe("one\n");
      expect(again?.stamp).toEqual(first?.stamp);

      await writeFile(file, "one\ntwo\n");
      const moved = await readContextFile(file);
      expect(moved?.content).toBe("one\ntwo\n");
      expect(sameStamp(moved!.stamp, first!.stamp)).toBe(false);
    });
  });

  it("hands back the generation the agent holds, and admits when it cannot", async () => {
    await withTree(async (root) => {
      const file = join(root, "AGENTS.md");
      await writeFile(file, "one\n");
      const first = (await readContextFile(file))!;
      expect(heldText(file, first.stamp)).toBe("one\n");

      await writeFile(file, "one\ntwo\n");
      await readContextFile(file);
      expect(heldText(file, first.stamp)).toBe("one\n");
      expect(heldText(file, { mtimeMs: -1, size: -1 })).toBeNull();
      expect(heldText(join(root, "other.md"), first.stamp)).toBeNull();
    });
  });
});
