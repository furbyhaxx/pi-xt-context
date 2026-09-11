# Configuration

pi-xt-context reads and writes a top-level `"context"` object in Pi's
`settings.json`. It does **not** use a separate `on-demand-context.json`.

## Files

| Scope | Path |
|---|---|
| User | `<agentDir>/settings.json` |
| Project | `<cwd>/.pi/settings.json` |

`<agentDir>` is Pi's config directory (`~/.pi/agent` by default). Set
`PI_CODING_AGENT_DIR` to override it — the same variable Pi itself honors.
Project settings use the session working directory, not the bash-tracked dir
and not a Git root.

Project settings are honored only when the project is trusted. An untrusted
project cannot steer a user/global extension.

## Schema

```json
{
  "context": {
    "workingDirOnly": true,
    "hideContents": false,
    "files": ["AGENTS.md"]
  }
}
```

Unrelated Pi settings in the same file are left untouched. Unknown keys inside
`context` are preserved on save.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `workingDirOnly` | boolean | `true` | Only load matches under Pi's launch directory. `cd` still updates the tracked dir. |
| `hideContents` | boolean | `false` | TUI keeps the compact `loaded <paths>` line even when tool output is expanded. The LLM still receives full contents. |
| `files` | string[] | `["AGENTS.md"]` | Glob patterns expanded at each walked directory. An empty array disables extension discovery. |

Precedence is **defaults < user < trusted project**, per key. A `files` array
**replaces** the inherited list; it is not concatenated.

Invalid values are ignored with a diagnostic and the lower valid scope is used.
`/context` shows those warnings.

This extension does **not** change Pi's own startup loader. Pi may still inject
`AGENTS.md` / `CLAUDE.md` at the launch directory independently.

## Patterns

Patterns are relative to **each directory** on the walk from the touched dir
up to Pi's launch dir (or the filesystem root when `workingDirOnly` is off).

| Pattern | Effect |
|---|---|
| `AGENTS.md` | Exact filename in that directory only |
| `AGENTS*.md` | Local filenames (`AGENTS.md`, `AGENTS.override.md`, …) |
| `.pi/context/*.md` | Files in that relative directory |
| `{AGENTS.md,CLAUDE.md}` | Brace expansion (commas are part of the pattern) |
| `**/*.md` | Recursive from that directory |

There is no implicit whole-project scan. The default exact `AGENTS.md` pattern
does not recurse. A `**` pattern **can** load files in subtrees the model has
not otherwise touched — use it deliberately.

Specificity is the ancestor at which the pattern was expanded, not how nested
the matched file is. A hit on `.pi/context/rules.md` is scoped to the directory
that owns `.pi/context/`, not treated as “deeper” than that directory's
`AGENTS.md`.

Unsupported (rejected at config load / editor save):

- Absolute patterns (`/etc/passwd`, `C:/…`, `~/…`)
- Parent-escaping segments (`../AGENTS.md`)

`workingDirOnly` also applies to match paths after symlink resolution, so a
link inside the project cannot pull in a file outside it.

## Slash command

`/context` — overview (counts, dirs, effective settings, provenance).

`/context list` — unique loaded paths labeled Pi startup vs extension.

`/context config` — TUI configurator. Pick user or project scope, edit a draft,
Save or Cancel. Project scope is offered only when the project is trusted.
Resetting a key removes the override so the lower scope applies; it does not
copy the effective value into the file.

Globs are edited one per line. Do not comma-split a line.

A user-scope save that is still overridden by project settings is reported
explicitly.

Changing `files` or `workingDirOnly` clears the per-directory scan cache.
Already injected files stay in the session (injection is durable). A **new
session** is required to drop previously injected context. `hideContents` only
affects TUI rendering.

## Migrating from on-demand-context.json

Older releases used:

- `~/.pi/agent/on-demand-context.json`
- `<project>/.pi/on-demand-context.json`

Those files are **not** read anymore. Copy `workingDirOnly` / `hideContents`
under `"context"` in the corresponding `settings.json`. Leave the old files
in place if you want; they are not deleted.

Default discovery is now `AGENTS.md` only. To restore Claude-style filenames:

```json
{
  "context": {
    "files": ["AGENTS.md", "CLAUDE.md"]
  }
}
```
