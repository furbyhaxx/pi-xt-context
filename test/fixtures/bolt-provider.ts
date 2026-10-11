import { createAssistantMessageEventStream, type AssistantMessage, type TextContent, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import piXtContext from "../../index.ts";

function startChildInstance(): void {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  piXtContext({
    registerMessageRenderer() {},
    registerCommand() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(name, handler);
    },
  } as never);
  handlers.get("session_start")?.({}, {
    cwd: process.cwd(),
    isProjectTrusted: () => false,
    sessionManager: {
      getBranch: () => [],
      buildSessionProjection: () => ({ messages: [] }),
    },
  });
  handlers.get("context")?.({ messages: [] }, {});
}

export default function (pi: ExtensionAPI) {
  piXtContext(pi);
  let turn = 0;
  pi.registerProvider("xt-context-fixture", {
    baseUrl: "http://unused.invalid",
    apiKey: "fixture",
    api: "xt-context-fixture",
    models: [{ id: "fixture", name: "Context fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024 }],
    streamSimple(model) {
      if (turn === 1) startChildInstance();
      const stream = createAssistantMessageEventStream();
      const steps: Array<ToolCall | TextContent> = [
        { type: "toolCall", id: "cd", name: "bash", arguments: { command: `cd ${join(process.cwd(), "nested")} && pwd` } },
        { type: "toolCall", id: "read", name: "read", arguments: { path: join(process.cwd(), "nested", "file.txt"), offset: 1, limit: 5 } },
        { type: "text", text: "fixture complete" },
      ];
      const content = [steps[turn++] ?? { type: "text" as const, text: "fixture complete" }];
      const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now() };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
        stream.end();
      });
      return stream;
    },
  });
}
