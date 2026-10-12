import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import piXtContext from "../index.ts";

const exec = promisify(execFile);
let root: string;
let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(async () => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  root = await mkdtemp(join(tmpdir(), "pxt-remote-"));
  agentDir = await mkdtemp(join(tmpdir(), "pxt-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(join(root, "a", "b"), { recursive: true });
  await writeFile(join(root, "a", "AGENTS.md"), "parent rules\n");
  await writeFile(join(root, "a", "b", "AGENTS.md"), "child rules\n");
});

afterEach(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
  await rm(agentDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const remote = (path: string, host = "fake") => `ssh://${host}${path}`;

async function harness(defaultRemote = false, servicePresent = true, requestOnly = false) {
  type Location = { kind: "local"; path: string } | { kind: "ssh"; host: string; path: string };
  const events = new EventEmitter();
  interface Message {
    customType: string;
    content: string;
    details: { files: string[]; context: string; text: string };
  }
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const messages: Message[] = [];
  const outputs: string[] = [];
  let visible: unknown[] = [];
  const service = {
    version: 1 as const,
    defaultLocation: () => defaultRemote ? remote(join(root, "a", "b")) : root,
    resolve: vi.fn(async (raw: string | undefined): Promise<Location> => {
      if (raw?.startsWith("ssh://")) {
        const match = raw.match(/^ssh:\/\/([^/]+)(\/[\s\S]*)$/)!;
        return { kind: "ssh", host: match[1], path: match[2] };
      }
      if (raw?.startsWith("file://")) return { kind: "local", path: raw.slice(7) };
      return defaultRemote
        ? { kind: "ssh", host: "fake", path: resolve(root, "a", "b", raw ?? ".") }
        : { kind: "local", path: resolve(root, raw ?? ".") };
    }),
    format: (location: Location) => location.kind === "ssh" ? remote(location.path, location.host) : location.path,
    exec: vi.fn(async (_location: Location, script: string) => {
      const result = await exec("bash", ["-c", script], { maxBuffer: 2 * 1024 * 1024 });
      outputs.push(result.stdout);
      return result.stdout;
    }),
  };
  if (servicePresent) events.on("workbench:service-request", (reply) => reply(service));
  const ctx = {
    cwd: root,
    isProjectTrusted: () => true,
    sessionManager: {
      getBranch: () => messages.map((message) => ({ type: "custom_message", ...message })),
      buildSessionProjection: () => ({ messages: visible }),
    },
  };
  piXtContext({
    events,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    sendMessage: async (message: Message) => {
      messages.push(message);
      visible.push({ role: "custom", ...message });
    },
  } as never);
  const run = async (name: string, event = {}) => handlers.get(name)?.(event, ctx);
  if (servicePresent && !requestOnly) events.emit("workbench:service", service);
  await run("session_start");
  return {
    messages, service, outputs, run,
    async touch(toolName: string, input: Record<string, unknown>, output = "") {
      await run("tool_result", { toolName, input, content: [{ type: "text", text: output }], isError: false });
    },
    async compact() {
      await run("context", { messages: visible });
      visible = [];
      await run("context", { messages: visible });
      await run("session_compact");
    },
  };
}

describe("remote context", () => {
  it("injects ssh ancestors most specific first and executes once per turn", async () => {
    const h = await harness();
    await h.touch("read", { path: remote(join(root, "a", "b", "file.txt")) });
    expect(h.messages[0].details.files).toEqual([
      remote(join(root, "a", "b", "AGENTS.md")), remote(join(root, "a", "AGENTS.md")),
    ]);
    expect(h.messages[0].details.context).toContain("child rules");
    expect(h.messages[0].content).toContain("ssh://fake/");
    await h.touch("ls", { path: remote(join(root, "a", "b")) });
    expect(h.service.exec).toHaveBeenCalledTimes(1);
  });

  it("rechecks in one exec without unchanged content and notices an edited file", async () => {
    const h = await harness();
    const path = remote(join(root, "a", "b"));
    await h.touch("ls", { path });
    await h.run("turn_start", { turnIndex: 1 });
    await h.touch("ls", { path });
    expect(h.service.exec).toHaveBeenCalledTimes(2);
    expect(h.outputs[1]).not.toContain(Buffer.from("child rules\n").toString("base64"));
    expect(h.messages).toHaveLength(1);
    await writeFile(join(root, "a", "b", "AGENTS.md"), "child rules\nnew rule\n");
    await h.run("turn_start", { turnIndex: 2 });
    await h.touch("ls", { path });
    expect(h.service.exec).toHaveBeenCalledTimes(3);
    expect(h.messages[1].customType).toBe("context-changed");
    expect(h.messages[1].details.text).toContain("+new rule");
  });

  it("resolves plain and omitted paths under the remote default through a requested service", async () => {
    const h = await harness(true, true, true);
    await h.touch("read", { path: "file.txt" });
    await h.touch("ls", {});
    expect(h.messages[0].details.files[0]).toBe(remote(join(root, "a", "b", "AGENTS.md")));
    expect(h.service.resolve).toHaveBeenCalledWith("file.txt");
    expect(h.service.exec).toHaveBeenCalledTimes(1);
  });

  it("tracks remote bash cwd, relative cd and prefixed pwd output", async () => {
    const h = await harness();
    await h.touch("bash", { cwd: remote(join(root, "a")), command: "cd b && pwd" }, `[${remote(join(root, "a"))}]\n${join(root, "a", "b")}`);
    expect(h.messages[0].details.files[0]).toBe(remote(join(root, "a", "b", "AGENTS.md")));
    expect(h.service.resolve).toHaveBeenCalledWith(remote(join(root, "a")));
    const plain = await harness();
    await plain.touch("bash", { cwd: remote(join(root, "a")), command: "cd b" });
    expect(plain.messages[0].details.files[0]).toBe(remote(join(root, "a", "b", "AGENTS.md")));
    const noCd = await harness(true);
    await noCd.touch("bash", { command: "printf hello" });
    expect(noCd.messages[0].details.files[0]).toBe(remote(join(root, "a", "b", "AGENTS.md")));
  });

  it("does not inject remote context read by the agent and restores hidden remote files", async () => {
    const h = await harness();
    const file = remote(join(root, "a", "b", "AGENTS.md"));
    await h.touch("read", { path: file });
    expect(h.messages[0].details.files).not.toContain(file);
    await h.compact();
    expect(h.messages).toHaveLength(2);
    expect(h.messages[1].details.files).toEqual([remote(join(root, "a", "AGENTS.md"))]);
    expect(h.service.exec).toHaveBeenCalledTimes(2);
  });

  it("isolates remote host keys from local paths and other hosts", async () => {
    const h = await harness();
    await h.touch("ls", { path: remote(join(root, "a", "b")) });
    await h.touch("ls", { path: remote(join(root, "a", "b"), "other") });
    await h.touch("ls", { path: join(root, "a", "b") });
    expect(h.messages).toHaveLength(3);
    expect(h.messages[1].details.files[0]).toBe(remote(join(root, "a", "b", "AGENTS.md"), "other"));
    expect(h.messages[2].details.files[0]).toBe(join(root, "a", "b", "AGENTS.md"));
  });

  it("logs a failing host only once per session and skips later connections", async () => {
    const h = await harness(true);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    h.service.exec.mockRejectedValue(new Error("Host key verification failed"));
    await h.touch("ls", {});
    await h.run("turn_start", { turnIndex: 1 });
    await h.touch("ls", { path: "elsewhere" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(h.service.exec).toHaveBeenCalledTimes(1);
    expect(h.service.resolve).toHaveBeenCalledTimes(1);
    expect(h.messages).toHaveLength(0);
    await h.run("session_start");
    await h.touch("ls", {});
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("suppresses repeated remote resolution failures and leaves forced local paths usable", async () => {
    const h = await harness(true);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    h.service.resolve.mockRejectedValueOnce(new Error("SSH unreachable"));
    await h.touch("ls", {});
    await h.touch("ls", {});
    expect(h.service.resolve).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    await h.touch("read", { path: `file://${join(root, "a", "b", "file.txt")}` });
    expect(h.messages[0].details.files[0]).toBe(join(root, "a", "b", "AGENTS.md"));
  });

  it("does not connect when remote discovery is disabled", async () => {
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ context: { files: [] } }));
    const h = await harness(true);
    await h.touch("ls", {});
    expect(h.service.exec).not.toHaveBeenCalled();
    expect(h.messages).toHaveLength(0);
  });

  it("supports simple dot globs, excludes remote-default-relative files and skips globstar", async () => {
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ context: {
      files: ["AGENTS.md", "*.rules.md", "**/recursive.md"], exclude: ["skip.rules.md"],
    } }));
    const dir = join(root, "a", "b");
    await writeFile(join(dir, ".hidden.rules.md"), "dot rules\n");
    await writeFile(join(dir, "skip.rules.md"), "must not transfer\n");
    await writeFile(join(dir, "recursive.md"), "globstar rules\n");
    const h = await harness(true);
    await h.touch("ls", {});
    expect(h.messages[0].details.files).toContain(remote(join(dir, ".hidden.rules.md")));
    expect(h.messages[0].details.files).not.toContain(remote(join(dir, "skip.rules.md")));
    expect(h.messages[0].details.files).not.toContain(remote(join(dir, "recursive.md")));
    expect(h.outputs[0]).not.toContain(Buffer.from("must not transfer\n").toString("base64"));
  });

  it("frames unusual paths and caps transferred content at 64 KiB", async () => {
    const dir = join(root, "a", "b", "space '\t\nfolder");
    await mkdir(dir);
    await writeFile(join(dir, "AGENTS.md"), "x".repeat(70 * 1024));
    const h = await harness();
    await h.touch("ls", { path: remote(dir) });
    expect(h.messages[0].details.files[0]).toBe(remote(join(dir, "AGENTS.md")));
    expect(h.messages[0].details.context).toContain("x".repeat(64 * 1024) + "\n\n[...truncated]");
    expect(h.messages[0].details.context).not.toContain("x".repeat(64 * 1024 + 1));
  });

  it("keeps local bash non-cd behavior unchanged when the service is present", async () => {
    const h = await harness();
    await h.touch("bash", { command: "pwd" });
    expect(h.messages).toHaveLength(0);
    await h.touch("bash", { command: "cd a/b" });
    expect(h.messages[0].details.files[0]).toBe(join(root, "a", "b", "AGENTS.md"));
  });

  it("keeps local discovery unchanged with and without the service", async () => {
    for (const present of [false, true]) {
      const h = await harness(false, present);
      await h.touch("read", { path: join(root, "a", "b", "file.txt") });
      expect(h.messages[0].details.files).toEqual([
        join(root, "a", "b", "AGENTS.md"), join(root, "a", "AGENTS.md"),
      ]);
      expect(h.service.exec).not.toHaveBeenCalled();
    }
  });
});
