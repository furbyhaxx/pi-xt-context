// Drives the real extension (index.ts) over the synthetic tree from
// bench/make-tree.mjs and reports how many messages it injects.
//
//   PI_CODING_AGENT_DIR=<dir> strace -f -o trace.log \
//     node --import ./bench/alias.mjs bench/dedup.mjs <root>
//
// Kept free of tree construction so the trace contains only the extension's work.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import piXtContext from "../index.ts";

const root = process.argv[2];
if (!root) throw new Error("usage: dedup.mjs <root>");

// Same patterns the owner's profile configures, so per-ancestor lookups match.
await writeFile(
  join(process.env.PI_CODING_AGENT_DIR, "settings.json"),
  JSON.stringify({
    context: {
      files: ["AGENTS.md", "AGENTS.*.md", "PRODUCT.md", "CONTRIBUTING.md", "DESIGN.md"],
    },
  }),
);

const handlers = new Map();
const on = (event, handler) => {
  const list = handlers.get(event) ?? [];
  list.push(handler);
  handlers.set(event, list);
};
const emit = (event, payload, ctx) =>
  (handlers.get(event) ?? []).map((h) => h(payload, ctx));

const branch = [];
const injected = [];
const pi = {
  registerMessageRenderer: () => {},
  registerCommand: () => {},
  on,
  sendMessage: async (message, options) => {
    injected.push({ customType: message.customType, options });
    branch.push({
      type: "custom_message",
      customType: message.customType,
      details: message.details,
    });
  },
};

const projection = () => ({ entries: [], messages: [] });
const ctx = {
  cwd: root,
  isProjectTrusted: () => true,
  sessionManager: {
    getBranch: () => branch,
    buildSessionProjection: projection,
  },
};

piXtContext(pi);
emit("session_start", { type: "session_start", reason: "startup" }, ctx);
emit("before_agent_start", { type: "before_agent_start", systemPromptOptions: {} }, ctx);

const leaves = Number(process.env.BENCH_LEAVES ?? 300);
for (let i = 0; i < leaves; i++) {
  const event = {
    type: "tool_result",
    toolName: "read",
    input: { path: join(root, "pkg", "sub", `leaf-${i}`, "probe.txt") },
    content: [{ type: "text", text: "probe\n" }],
    isError: false,
  };
  for (const handler of handlers.get("tool_result") ?? []) await handler(event, ctx);
}

console.log(JSON.stringify({ leaves, messages: injected.length }));
