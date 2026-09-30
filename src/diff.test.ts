import { describe, it, expect } from "vitest";
import { diffLines, formatChangeNotice } from "./diff.ts";

const current = { path: "/proj/AGENTS.md", content: "b\n", stamp: { mtimeMs: 2, size: 2 } };

describe("diffLines", () => {
  it("returns nothing when the text did not move", () => {
    expect(diffLines("a\nb\nc\n", "a\nb\nc\n")).toBe("");
  });

  it("marks a replacement and an addition", () => {
    expect(diffLines("a\nb\nc\n", "a\nB\nc\nd\n")).toBe("-b\n+B\n+d");
  });

  it("bounds the emitted lines and says how many were dropped", () => {
    const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const after = Array.from({ length: 200 }, (_, i) => `LINE ${i}`).join("\n");
    const out = diffLines(before, after).split("\n");
    expect(out).toHaveLength(31);
    expect(out[30]).toBe("… 370 more changed line(s)");
  });

  it("declines to diff a change too large to align", () => {
    const before = Array.from({ length: 500 }, (_, i) => `a${i}`).join("\n");
    const after = Array.from({ length: 500 }, (_, i) => `b${i}`).join("\n");
    expect(diffLines(before, after)).toContain("diff omitted, change too large");
  });

  it("clips a single very long line", () => {
    const out = diffLines("x".repeat(500), "y".repeat(500));
    expect(out.split("\n")[0]).toHaveLength(122);
    expect(out.split("\n")[0].endsWith("…")).toBe(true);
  });
});

describe("formatChangeNotice", () => {
  it("frames the change as a diff, not a second copy", () => {
    const text = formatChangeNotice("/proj/AGENTS.md", {
      path: "/proj/AGENTS.md",
      previous: "a\n",
      current,
    });
    expect(text).toContain("## Context File Changed");
    expect(text).toContain("not a second copy of the file");
    expect(text).toContain("```diff\n-a\n+b\n```");
  });

  it("says so when the held text is gone instead of inventing a diff", () => {
    const text = formatChangeNotice("/proj/AGENTS.md", {
      path: "/proj/AGENTS.md",
      previous: null,
      current,
    });
    expect(text).not.toContain("```diff");
    expect(text).toContain("no diff can be shown");
  });
});
