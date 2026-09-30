# AGENTS.md

Pi extension: auto-load nested context files on directory touch.

## Commands

- `npm test` — `vitest run`
- `npx vitest run -t "name"` — one test
- No build step; pi loads TypeScript directly

## Layout

- `index.ts` — factory, `tool_result` injection, change notices, compaction re-injection
- `src/config.ts` — `settings.json` `"context"` load/save/merge
- `src/content.ts` — one text copy per file, validated by `{mtimeMs, size}`
- `src/decide.ts` — inject / notice / skip, given what the model can already see
- `src/diff.ts` — bounded line diff and the change-notice text
- `src/discovery.ts` — walk-up glob discovery
- `src/commands.ts` — `/context` `[list|config]`
- `src/paths.ts` / `src/loaded.ts` — path keys, branch reconstruction
- `bench/` — 300-leaf dedup benchmark (`npm run bench`, needs `strace`)

## Rules

- Await discovery inside `tool_result` so steer lands before the next LLM call
- Never hand the model the same text twice: read, injected, and post-compaction
  visibility all come from `decide()`, never from an ad-hoc check
- A file the model read is never injected, but is still tracked for changes —
  "don't inject it" and "don't tell me it moved" are separate decisions
- `context` and `session_compact` are the only trustworthy sources for what the
  model can still see (`buildSessionProjection()`), not what was ever injected
- Do not add `@earendil-works/pi-tui` to package.json (pi aliases it). Vitest uses `test/*-stub.ts`
- `getAgentDir()` already honors `PI_CODING_AGENT_DIR`; tests must set it
- Project `settings.json` is trust-gated
- Default `files` is `["AGENTS.md"]` only
- Keep `/context config` edits as a draft until Save
- Injection is durable; config changes cannot retract history
