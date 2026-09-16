# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Changed

- Context transcript rows now use `[context] loaded <workspace-relative paths>`.
- Session tree rows now use `[context]: <workspace-relative paths>` instead of
  previewing injected context contents. Existing `pi-xt-context` session entries
  remain supported.

## [0.4.0] — 2026-09-11

Forked as **pi-xt-context**. Breaking config and command changes; historical
entries below describe the upstream `pi-on-demand-context` releases.

### Changed

- Package renamed to unscoped `pi-xt-context`.
- Config moved into Pi `settings.json` under the top-level `"context"` key
  (user: `<agentDir>/settings.json`, project: `<cwd>/.pi/settings.json`).
  `PI_CODING_AGENT_DIR` is honored through Pi's `getAgentDir()`. Project
  settings remain trust-gated.
- Default discovery is `AGENTS.md` only (no implicit `CLAUDE.md`).
- `/list-context`, `/odc-working-dir-only`, and `/odc-hide-contents` replaced
  by `/context`, `/context list`, and `/context config`.
- Durable message `customType` is `pi-xt-context`.
- Path dedup is case-sensitive on POSIX.

### Added

- `context.files` glob list (replaces inherited arrays; `[]` disables
  extension discovery). Patterns expand per walked directory.
- `/context config` TUI editor with user/project scope, inherit/reset, and
  one-glob-per-line files editing.
- Session-branch reconstruction of already injected files so `/context list`
  and dedup survive `/reload`, `/resume`, and `/fork`.

### Removed

- Reading `on-demand-context.json`. Copy `workingDirOnly` / `hideContents`
  into `settings.json` `context` yourself; legacy files are not deleted.

## [0.3.1] — 2026-08-18

### Fixed

- **Dedup keys normalized** — the per-dir cache (`dirContexts`) and the
  in-flight set are keyed by the normalized `pathKey(dir)` (case-insensitive
  on Windows), so a differently-cased spelling of an already-scanned dir no
  longer triggers a redundant re-scan or a second `/list-context` entry.
  `/list-context` still shows the original path spelling.
- **Symlink/junction aliases dedup** — context files are keyed by their
  canonical realpath, so the same physical file reached through a symlink,
  junction, or a different spelling (including one seen by pi's own startup
  loader) is injected only once.
- **Injection failure retries** — if the context message fails to send, the
  "injected" marks are rolled back and the dir is not cached, so the next
  touch of that dir re-discovers and retries instead of the context being
  silently lost for the session.

## [0.3.0] — 2026-08-17

### Added

- **`workingDirOnly` config option — on by default**
  ([#1](https://github.com/Quartermaster-Labs/pi-on-demand-context/issues/1)) —
  context files are only loaded under pi's working (launch) directory, with
  no configuration needed. Touching files or `cd`-ing outside the project
  loads nothing (the tracked working dir still moves), so unrelated
  `CLAUDE.md` files — e.g. `~/CLAUDE.md` or a package manager's — no longer
  leak in from stray touches. Set `"workingDirOnly": false` to restore the
  old walk-up-to-filesystem-root behavior.
- **`hideContents` config option** ([#1](https://github.com/Quartermaster-Labs/pi-on-demand-context/issues/1)) —
  when `true`, the TUI never shows the injected file contents, even when tool
  output is expanded; the `loaded <paths>` line stays compact. The LLM still
  receives the full contents.
- Config files, project overrides global per key:
  `~/.pi/agent/on-demand-context.json` (global) and
  `<project>/.pi/on-demand-context.json` (per-project, honored only for
  trusted projects). Re-read at every session start, including `/reload`.
- `/odc-working-dir-only on|off` and `/odc-hide-contents on|off` — toggle
  the options at runtime without editing any file; they apply immediately and
  persist to the global config.
- `/list-context` now shows the active config next to the loaded files.

## [0.2.0] — 2026-08-17

### Added

- Compact TUI rendering: injections now show as a single line
  `loaded <path>, <path>` in the transcript (via
  `pi.registerMessageRenderer`); expanding tool output reveals the full text.
  Previously the entire markdown block was dumped into the transcript.
- `CHANGELOG.md` (this file).

### Fixed

- **Injection timing** — the `tool_result` hook now awaits discovery and
  injection. pi's agent loop drains the steering queue only at iteration
  boundaries (after tool execution, before the next LLM call); with the old
  fire-and-forget discovery the drain ran before the async file reads
  finished, so context landed one full assistant turn after the `cd` — after
  the model had already replied to the tool result. The `loaded ...` line now
  appears immediately after the tool result, before the model's next thinking
  block.
- **Deepest-first ordering** — removed a stray `.reverse()` in
  `discoverContextFiles` that flipped multi-depth results to shallowest-first,
  corrupting the "most specific" / "N level(s) up — broader" depth tags
  (deepest file was tagged as the broadest). Invisible in single-depth trees;
  a regression test with a 3-level tree now pins the ordering.

### Changed

- Dropped the `@earendil-works/pi-tui` npm dependency: pi's extension loader
  aliases pi packages (`pi-tui`, `pi-coding-agent`, `pi-agent-core`, `pi-ai`,
  `typebox`) to the host's own copy for every extension, so extensions never
  declare them. Vitest has no such loader and resolves the import via
  `test/pi-tui-stub.ts` instead.
- Rewrote the README; `CHANGELOG.md` is now shipped in the npm package.

## [0.1.4] — never published

Version was bumped in preparation for the changes that shipped as
[0.2.0]; nothing was released under this number.

## [0.1.3] — 2026-06-28

- No content changes (version bump).

## [0.1.2] — 2026-06-28

### Added

- Restored the MIT `LICENSE` file in the published package.

### Changed

- README notes the prior `@radu0120` scope.

## [0.1.1] — 2026-06-28

### Changed

- Republished under the `@quartermaster-labs` scope (formerly
  `@radu0120/pi-on-demand-context`).

## [0.1.0] — 2026-06-26

### Added

- Initial release: auto-loads `CLAUDE.md` / `AGENTS.md` when the model `cd`s
  into a new directory (bash `cd`, with `&& pwd` / `; pwd` support for
  `cd -`, `~`, `$VAR`, `$(...)`, and paths with spaces).
- File-tool triggers: `read` / `edit` / `write` load the file's directory;
  `grep` / `ls` / `find` load the searched directory. Neither moves the bash
  working dir.
- One-time, durable injection (never re-sent; deduped against pi's startup
  loader via `systemPromptOptions.contextFiles`).
- Walk-up from the touched dir to pi's launch dir; 64 KB per-file cap.
- `/list-context` command.
