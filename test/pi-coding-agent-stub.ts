// Minimal stand-in for @earendil-works/pi-coding-agent under vitest.
// getAgentDir() honors PI_CODING_AGENT_DIR so config tests stay hermetic.
import { join } from "node:path";
import { tmpdir } from "node:os";

export const CONFIG_DIR_NAME = ".pi";

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(tmpdir(), "pi-test-agent-stub");
}

export function getSettingsListTheme() {
  return {
    label: (t: string) => t,
    value: (t: string) => t,
    description: (t: string) => t,
    cursor: ">",
    hint: (t: string) => t,
  };
}
