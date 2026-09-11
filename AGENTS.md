# AGENTS.md

Pi extension: auto-load nested context files on directory touch.

## Commands

- `npm test` — `vitest run`
- `npx vitest run -t "name"` — one test
- No build step; pi loads TypeScript directly

## Layout

- `index.ts` — factory, `tool_result` injection, session restore
- `src/config.ts` — `settings.json` `"context"` load/save/merge
- `src/discovery.ts` — walk-up glob discovery
- `src/commands.ts` — `/context` `[list|config]`
- `src/paths.ts` / `src/loaded.ts` — path keys, branch reconstruction

## Rules

- Await discovery inside `tool_result` so steer lands before the next LLM call
- Do not add `@earendil-works/pi-tui` to package.json (pi aliases it). Vitest uses `test/*-stub.ts`
- `getAgentDir()` already honors `PI_CODING_AGENT_DIR`; tests must set it
- Project `settings.json` is trust-gated
- Default `files` is `["AGENTS.md"]` only
- Keep `/context config` edits as a draft until Save
- Injection is durable; config changes cannot retract history
