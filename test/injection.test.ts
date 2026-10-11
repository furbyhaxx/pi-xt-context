import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { reads } = vi.hoisted(() => ({ reads: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    readFile: (path: string, options: never) => {
      reads.push(String(path));
      return actual.readFile(path, options);
    },
  };
});

const { default: piXtContext } = await import("../index.ts");

interface SentMessage {
  customType: string;
  content: string | Array<{ type: string; text?: string }>;
  details: { files?: string[]; context?: string; file?: string; text?: string };
}

let agentDir = "";
let root = "";
let prevAgentDir: string | undefined;

beforeEach(async () => {
  reads.length = 0;
  prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  agentDir = await mkdtemp(join(tmpdir(), "pxt-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  root = await mkdtemp(join(tmpdir(), "pxt-inject-"));
});

afterEach(async () => {
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  await rm(agentDir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

/** Mirrors pi: `visible` is the projection the model actually receives. */
async function harness(branch: unknown[] = [], sendDelayMs = 0, queueSteers = false) {
  const handlers = new Map<string, Array<(e: unknown, c: unknown) => unknown>>();
  const messages: SentMessage[] = [];
  let visible: unknown[] = [];
  const queued: unknown[] = [];
  let turn = 0;

  const pi = {
    registerMessageRenderer: () => {},
    registerCommand: () => {},
    on(event: string, handler: (e: unknown, c: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage: async (message: SentMessage) => {
      if (sendDelayMs > 0) await new Promise((done) => setTimeout(done, sendDelayMs));
      messages.push(message);
      branch.push({ type: "custom_message", ...message });
      (queueSteers ? queued : visible).push({ role: "custom", details: message.details, ...message });
    },
  };
  const ctx = {
    cwd: root,
    isProjectTrusted: () => true,
    sessionManager: {
      getBranch: () => branch,
      buildSessionProjection: () => ({ entries: [], messages: visible }),
    },
  };

  piXtContext(pi as never);

  const run = async (event: string, payload: unknown): Promise<unknown> => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) {
      result = await handler(payload, ctx);
    }
    return result;
  };

  await run("session_start", { type: "session_start", reason: "startup" });
  await run("before_agent_start", { type: "before_agent_start" });

  return {
    messages,
    async reload() {
      await run("session_start", { type: "session_start", reason: "reload" });
    },
    blocks: () => messages.filter((m) => m.customType === "context"),
    notices: () => messages.filter((m) => m.customType === "context-changed"),
    async touch(dir: string) {
      await run("tool_result", {
        type: "tool_result",
        toolName: "ls",
        input: { path: dir },
        content: [{ type: "text", text: "" }],
        isError: false,
      });
    },
    async read(file: string, input: Record<string, unknown> = {}) {
      await run("tool_result", {
        type: "tool_result",
        toolName: "read",
        input: { path: file, ...input },
        content: [{ type: "text", text: "…body…" }],
        isError: false,
      });
    },
    async nextTurn() {
      turn += 1;
      await run("turn_start", { type: "turn_start", turnIndex: turn, timestamp: 0 });
    },
    /** The model's next view of the conversation. */
    async llmCall() {
      if (queued.length > 0) visible.push(queued.shift());
      const result = (await run("context", { type: "context", messages: visible })) as
        | { messages: unknown[] }
        | undefined;
      if (result?.messages) visible = result.messages;
    },
    /** Compaction that dropped every injected block, then the boundary event. */
    async compact(dropInjected: boolean) {
      if (dropInjected) {
        visible = visible.filter(
          (m) => (m as { customType?: string }).customType !== "context",
        );
      }
      await run("session_compact", {
        type: "session_compact",
        compactionEntry: { type: "compaction", id: "c1", firstKeptEntryId: "k1" },
        fromExtension: false,
        reason: "threshold",
        willRetry: false,
      });
    },
  };
}

async function tree(leaves: number): Promise<{ root: string; leaf: (i: number) => string }> {
  await mkdir(join(root, "pkg", "sub"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "root rules\n");
  await writeFile(join(root, "pkg", "AGENTS.md"), "pkg rules\n");
  await writeFile(join(root, "pkg", "sub", "AGENTS.md"), "sub rules\n");
  for (let i = 0; i < leaves; i++) {
    const dir = join(root, "pkg", "sub", `leaf-${i}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "AGENTS.md"), `leaf ${i} rules\n`);
  }
  return { root, leaf: (i: number) => join(root, "pkg", "sub", `leaf-${i}`) };
}

describe("content dedup", () => {
  it("isolates parent and subagent extension instances", async () => {
    await tree(1);
    const parent = await harness();
    await parent.touch(root);
    await parent.llmCall();
    const child = await harness();
    await child.llmCall();
    await parent.nextTurn();
    await parent.touch(root);
    expect(parent.blocks()).toHaveLength(1);
    await child.touch(root);
    expect(child.blocks()).toHaveLength(1);
  });

  it("injects each shared file once across concurrent directory touches", async () => {
    const { leaf } = await tree(5);
    const h = await harness([], 30);
    await Promise.all(Array.from({ length: 5 }, (_, i) => h.touch(leaf(i))));
    const paths = h.blocks().flatMap((b) => b.details.files ?? []);
    expect(paths).toHaveLength(8);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("keeps queued blocks pending until a context event actually sees them", async () => {
    const { leaf } = await tree(2);
    const h = await harness([], 0, true);
    await h.touch(leaf(0));
    await h.touch(leaf(1));
    expect(h.blocks()).toHaveLength(2);
    await h.llmCall();
    await h.nextTurn();
    await h.touch(leaf(1));
    expect(h.blocks()).toHaveLength(2);
    await h.llmCall();
    await h.nextTurn();
    await h.touch(leaf(1));
    expect(h.blocks()).toHaveLength(2);
  });

  it("treats null read pagination as a complete read", async () => {
    await tree(1);
    const h = await harness();
    const file = join(root, "AGENTS.md");
    await h.read(file, { offset: null, limit: null });
    expect(h.blocks().flatMap((b) => b.details.files ?? [])).not.toContain(file);
  });
  it("reads a shared ancestor once and serves every directory below it", async () => {
    const { leaf } = await tree(5);
    const h = await harness();
    for (let i = 0; i < 5; i++) await h.touch(leaf(i));

    for (const shared of ["AGENTS.md", join("pkg", "AGENTS.md"), join("pkg", "sub", "AGENTS.md")]) {
      expect(reads.filter((p) => p === join(root, shared))).toHaveLength(1);
    }
    // One block per leaf, each carrying only what the agent did not have yet.
    expect(h.blocks()).toHaveLength(5);
    expect(h.blocks()[0].details.files).toEqual([
      join(leaf(0), "AGENTS.md"),
      join(root, "pkg", "sub", "AGENTS.md"),
      join(root, "pkg", "AGENTS.md"),
      join(root, "AGENTS.md"),
    ]);
    expect(h.blocks()[1].details.files).toEqual([join(leaf(1), "AGENTS.md")]);
    expect(reads.filter((p) => p === join(leaf(3), "AGENTS.md"))).toHaveLength(1);
  });

  it("does not inject a file the agent read itself", async () => {
    const { leaf } = await tree(1);
    const h = await harness();
    await h.read(join(root, "AGENTS.md"));
    await h.touch(leaf(0));

    expect(h.blocks()).toHaveLength(1);
    expect(h.blocks()[0].details.files).not.toContain(join(root, "AGENTS.md"));
    expect(h.blocks()[0].details.files).toContain(join(leaf(0), "AGENTS.md"));
  });

  it("notices a change to a file the agent read, and never injects it", async () => {
    const { leaf } = await tree(1);
    const h = await harness();
    const file = join(leaf(0), "AGENTS.md");
    await h.read(file);
    await h.llmCall();
    expect(h.blocks().flatMap((b) => b.details.files ?? [])).not.toContain(file);

    await writeFile(file, "leaf 0 rules\nan extra line the agent has not seen\n");
    await h.nextTurn();
    await h.touch(leaf(0));

    expect(h.notices()).toHaveLength(1);
    expect(h.notices()[0].details.text).toContain("+an extra line the agent has not seen");
    expect(h.notices()[0].details.text).not.toContain("## Project Context Files");
    expect(h.blocks().flatMap((b) => b.details.files ?? [])).not.toContain(file);
  });

  it("stays silent for an agent-read file that did not change", async () => {
    const { leaf } = await tree(1);
    const h = await harness();
    await h.read(join(leaf(0), "AGENTS.md"));
    await h.llmCall();
    await h.nextTurn();
    await h.touch(leaf(0));
    expect(h.notices()).toHaveLength(0);
  });

  it("does not re-read a file it is already holding", async () => {
    const { leaf } = await tree(1);
    const h = await harness();
    await h.touch(leaf(0));
    const afterFirst = reads.length;
    await h.llmCall();
    await h.nextTurn();
    await h.touch(leaf(1));
    expect(reads.length).toBe(afterFirst);
  });
});

describe("change notification", () => {
  it("sends a bounded diff instead of a second copy when a file changes", async () => {
    const { leaf } = await tree(1);
    const h = await harness();
    await h.touch(leaf(0));
    await h.llmCall();

    const file = join(leaf(0), "AGENTS.md");
    await writeFile(file, `leaf 0 rules\nan extra line the agent has not seen\n`);
    await h.nextTurn();
    await h.touch(leaf(0));

    expect(h.blocks()).toHaveLength(1);
    expect(h.notices()).toHaveLength(1);
    const text = h.notices()[0].details.text ?? "";
    expect(text).toContain("## Context File Changed");
    expect(text).toContain("+an extra line the agent has not seen");
    expect(text).not.toContain("## Project Context Files");
    expect(text.split("\n").length).toBeLessThan(60);
  });

  it("stays silent when only a file timestamp changed", async () => {
    await tree(1);
    const h = await harness();
    await h.touch(root);
    await h.llmCall();
    const later = new Date(Date.now() + 10_000);
    await utimes(join(root, "AGENTS.md"), later, later);
    await h.nextTurn();
    await h.touch(root);
    expect(h.messages).toHaveLength(1);
  });

  it("reports each new revision once, across later turns and directories", async () => {
    const { leaf } = await tree(2);
    const h = await harness();
    await h.touch(leaf(0));
    await h.llmCall();
    const file = join(root, "AGENTS.md");
    await writeFile(file, "root rules\nfirst addition\n");
    await h.nextTurn();
    await h.touch(leaf(0));
    await h.llmCall();
    await h.nextTurn();
    await h.touch(leaf(1));
    expect(h.notices()).toHaveLength(1);
    await writeFile(file, "root rules\nfirst addition\nsecond addition\n");
    await h.nextTurn();
    await h.touch(leaf(1));
    expect(h.notices()).toHaveLength(2);
    expect(h.notices()[1].details.text).toContain("+second addition");
    expect(h.notices()[1].details.text).not.toContain("+first addition");
    await h.llmCall();
    await writeFile(file, "root rules\nfirst addition\nsecond addition\nthird addition\n");
    await h.nextTurn();
    await h.touch(leaf(0));
    expect(h.notices()).toHaveLength(3);
    expect(h.notices()[2].details.text).toContain("+third addition");
    expect(h.notices()[2].details.text).not.toContain("+second addition");
  });

  it("sends nothing at all when nothing changed", async () => {
    const { leaf } = await tree(1);
    const h = await harness();
    await h.touch(leaf(0));
    await h.llmCall();
    await h.nextTurn();
    await h.touch(leaf(0));
    expect(h.messages).toHaveLength(1);
  });

  it("bounds the diff when a file is rewritten wholesale", async () => {
    const { leaf } = await tree(1);
    const h = await harness();
    await h.touch(leaf(0));
    await h.llmCall();
    const lines = Array.from({ length: 900 }, (_, i) => `rewritten line ${i}`).join("\n");
    await writeFile(join(leaf(0), "AGENTS.md"), `${lines}\n`);
    await h.nextTurn();
    await h.touch(leaf(0));

    const text = h.notices()[0].details.text ?? "";
    const diffLines = text.split("```diff\n")[1].split("\n```")[0].split("\n");
    expect(diffLines.length).toBeLessThanOrEqual(31);
    expect(text).toContain("more changed line(s)");
  });
});

describe("exclusion boundaries", () => {
  it("never reads or injects excluded context from a nested tool touch", async () => {
    const { leaf } = await tree(1);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ context: { exclude: ["pkg/**"] } }));
    const h = await harness();
    await h.touch(leaf(0));
    expect(h.blocks().flatMap((b) => b.details.files ?? [])).toEqual([join(root, "AGENTS.md")]);
    expect(reads.some((p) => p.startsWith(join(root, "pkg")))).toBe(false);
  });

  it("stops notices and compaction reinjection after exclusions are saved", async () => {
    const { leaf } = await tree(1);
    const h = await harness();
    await h.touch(leaf(0));
    await h.llmCall();
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ context: { exclude: ["pkg/**"] } }));
    await h.reload();
    await writeFile(join(leaf(0), "AGENTS.md"), "excluded revision\n");
    await h.nextTurn();
    await h.touch(leaf(0));
    expect(h.notices()).toHaveLength(0);
    await h.compact(true);
    expect(h.blocks()).toHaveLength(2);
    expect(h.blocks()[1].details.files).toEqual([join(root, "AGENTS.md")]);
  });
});

describe("compaction boundary", () => {
  it("re-injects a file whose block the boundary hid", async () => {
    const { leaf } = await tree(1);
    const h = await harness();
    await h.touch(leaf(0));
    await h.llmCall();
    await h.compact(true);

    expect(h.blocks()).toHaveLength(2);
    expect(h.blocks()[1].details.files).toEqual(h.blocks()[0].details.files);
    expect(h.blocks()[1].details.context).toContain("leaf 0 rules");
  });

  it("injects nothing when the block survived the boundary", async () => {
    const { leaf } = await tree(1);
    const h = await harness();
    await h.touch(leaf(0));
    await h.llmCall();
    await h.compact(false);
    expect(h.messages).toHaveLength(1);
  });

  it("re-injects the current text when the file changed and the block was hidden", async () => {
    const { leaf } = await tree(1);
    const h = await harness();
    await h.touch(leaf(0));
    await h.llmCall();
    await writeFile(join(leaf(0), "AGENTS.md"), "leaf 0 rules, rewritten\n");
    await h.compact(true);

    expect(h.notices()).toHaveLength(0);
    expect(h.blocks()).toHaveLength(2);
    expect(h.blocks()[1].details.context).toContain("rewritten");
  });

  it("adopts the on-disk stamp of a session entry that recorded none", async () => {
    const { leaf } = await tree(1);
    const h = await harness([
      {
        type: "custom_message",
        customType: "pi-xt-context",
        details: { files: [join(root, "AGENTS.md")], context: "…" },
      },
    ]);
    await h.touch(leaf(0));
    await h.llmCall();
    await h.nextTurn();
    await h.touch(leaf(0));

    expect(h.notices()).toHaveLength(0);
    expect(h.blocks()[0].details.files).toContain(join(root, "AGENTS.md"));
  });
});
