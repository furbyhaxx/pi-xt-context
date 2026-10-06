# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Fixed

- Load `proper-lockfile` through a normal import rather than `createRequire`, so
  compiled Pi-Bolt 0.7.0 can resolve its `graceful-fs` dependency. Settings locking
  is unchanged. Added settings-lock tests and an opt-in real-Bolt startup test
  (`PI_BOLT_BINARY=/path/to/pi-bolt npm test`).

## [0.5.0] — 2026-09-30

Minor, not patch: 0.5.0 changes what the model receives in two user-visible ways
that did not exist in 0.4.1 — diff notices for context files that change on disk
(including files the model read itself), and re-injection of context a
compaction boundary dropped. No configuration, command, or settings schema
changed, so there is nothing to break.

### Added

- **A context file that changes now produces a diff notice instead of going
  stale, and never a second copy.** Previously a file modified mid-session was
  simply never re-injected, so the model kept working from text that no longer
  existed on disk. A touched directory is now re-checked once per turn: an
  unchanged file injects nothing, a changed one sends a short notice with a
  bounded diff (at most 30 lines, each clipped to 120 characters; a change too
  large to align is reported as counts). This covers every loaded context file,
  including one the model read itself — the model holds a snapshot either way,
  and must be told when it stops matching disk. The model is told, and is not
  given a second copy of a file it already holds.
- **A context file the agent read itself is never injected.** A complete,
  top-level `read` of a discovered context file marks it as already in the
  session, so discovery skips it — and keeps tracking its stamp, so a later edit
  still produces the notice above. Partial (`offset`/`limit`) and nested reads
  do not count as having the file — the model never saw the whole file in those
  cases. If the file is first discovered after the read (no baseline for the
  stamp the model read), the on-disk state is adopted silently rather than
  reporting a change that cannot be diffed.
- **Injected context is restored after compaction drops it.** `session_compact`
  compares the injected set against `sessionManager.buildSessionProjection()`,
  the same projection pi sends to the provider, and re-injects what the boundary
  hid while the file's directory is still in scope. Each injected block records
  the `{mtimeMs, size}` it was built from, so a restored session can still tell
  a later change from a stale model.

### Changed

- **Context file contents are read once per file, not once per directory.** The
  ancestor walk deduplicated *after* reading, so a shared `AGENTS.md` was
  re-read for every directory below it and `state.dirContexts` retained the full
  text of every file per touched directory for the whole session. Contents now
  live in one memo keyed by path and validated by `{mtimeMs, size}`; a touched
  directory records only the keys it contributed. Measured on the 300-leaf
  benchmark (`npm run bench`, 303 context files): 1,200 → 303 file reads (3.96x
  redundancy → none) and 165,220 → ~133,000 total syscalls (−19%). Syscalls that
  touch the tree rise 9,920 → 11,723, because an unchanged file is now
  validated with a stat instead of re-read.
- Context transcript rows now use `[context] loaded <workspace-relative paths>`,
  and change notices render as `[context] changed <path>`.
- Session tree rows now use `[context]: <workspace-relative paths>` instead of
  previewing injected context contents. Existing `pi-xt-context` session entries
  remain supported.
- Verified against pi 0.87.0 with no code change: the extension reads custom-message entries structurally, and its handlers do not touch the surfaces 0.87 changed.

## [0.4.1] — 2026-09-30

### Fixed

- **Context discovery no longer re-resolves the same paths for every touched
  directory.** `realpathSync` costs one syscall per path component and was being
  called twice per ancestor level per touched directory — 87,962 `statx` calls to
  walk 300 directories over two passes, of which 95% came from re-resolving
  ancestors that had not changed. Resolved paths are now memoized in a bounded
  (1024-entry) session cache. Measured on a 300-leaf tree: 87,962 → 8,329
  `statx` (−90.5%), 109,654 → 30,026 total filesystem syscalls (−72.6%), and
  2,366 ms → 1,414 ms median wall time.
- **Glob patterns no longer walk dependency and VCS trees.** A `context.files`
  entry such as `**/AGENTS.md` descended into `node_modules` and `.git` at every
  ancestor of every touched directory, matching vendored files as project
  context. Both trees are now excluded from glob expansion. Non-glob patterns
  (the `AGENTS.md` default) are unaffected.

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
