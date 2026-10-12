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
    "files": ["AGENTS.md"],
    "exclude": ["reference/**", "vendor/**"]
  }
}
```

Unrelated Pi settings in the same file are left untouched. Unknown keys inside
`context` are preserved on save.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `workingDirOnly` | boolean | `true` | Only load matches under Pi's launch directory. `cd` still updates the tracked dir. |
| `hideContents` | boolean | `false` | TUI keeps the compact `[context] loaded <workspace-relative paths>` line even when tool output is expanded. The LLM still receives full contents. |
| `files` | string[] | `["AGENTS.md"]` | Glob patterns expanded at each walked directory. An empty array disables extension discovery. |

| `exclude` | string[] | `[]` | Launch-directory-relative globs for files or subtrees to skip. |

Precedence is **defaults < user < trusted project**, per key. Each `files` or
`exclude` array **replaces** its inherited list; it is not concatenated.

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

## Exclusions

To keep a cloned reference repository's instructions out of automatic context:

```json
{
  "context": {
    "exclude": [".project/researches/_sources/**"]
  }
}
```

Unlike `files`, exclusions are relative to Pi's **launch directory**, so their
meaning does not change when the model touches deeper directories. A directory
match excludes its whole subtree: `reference`, `reference/`, and `reference/**`
all exclude that tree. Use `**/reference/**` to exclude reference trees anywhere
in the workspace, or `**/AGENTS.override.md` to exclude a filename anywhere.
Dot directories, wildcards and brace globs are supported. Leading `!` negation,
absolute paths and `..` segments are rejected.

Exclusions apply to exact filenames, recursive include patterns, symlink targets,
change notices and post-compaction re-injection. Touching an excluded tree can
still load non-excluded parent instructions. They do not block manual reads or
change Pi's own startup loader.

Saving exclusions stops future automatic loading; text already in the session
remains until it is compacted out or a new session is started.

## Remote locations

When `workbench` publishes its optional version-1 service, file tool paths and
bash `cwd` resolve through that service, including plain paths under `/remote`
and explicit `file://` paths. Without the service, local behavior is unchanged.
Remote bash scans its resolved `cwd` even without a `cd`; a simple `cd` is tracked
relative to that location, with the resulting path taken from `pwd` when present.

Remote walks continue to the remote filesystem root `/`. `workingDirOnly` is
ignored remotely: the local launch directory is not a remote boundary. Context
files are keyed and displayed as `ssh://host[:port]/absolute/path`, keeping hosts,
ports and local paths separate.

- Literal includes and simple `*`, `?`, and bracket globs expand at each ancestor
  with Bash `nullglob` and `dotglob`. `**` includes are skipped; brace expansion
  and extglobs are unsupported remotely. Local glob behavior is unchanged.
- Exclusions use Bash pattern matching against the path and each parent prefix.
  Their base is the current remote default directory on that same host, or `/`
  for an explicit host that is not the remote default. `*` can span `/` in these
  exclusion patterns. Brace exclusions and symlink-target exclusions are not
  supported remotely; matching is lexical. A matched directory skips its subtree.
- One SSH execution discovers an ancestor chain or rechecks a directory's known
  files. Content is capped at 64 KiB before transfer; tab-separated frames encode
  paths and content as base64. Unchanged stamps transfer metadata only. Repeated
  touches of the same directory within one turn do not execute another scan.
- The remote host needs Bash 4+ and GNU coreutils (`stat`, `date`, `head`, `base64`,
  `tr`). Stamps use modification time in milliseconds plus byte size.
- SSH/service failures are logged once per host and port per session. Further
  automatic scans of that endpoint are skipped until a new session or reload;
  tool results are not changed or failed. Local discovery remains available.

User and trusted local project configuration still select the patterns. Remote
Pi settings are not loaded. Remote context retains the usual read deduplication,
change notices and post-compaction re-injection.

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

Changing `files`, `exclude` or `workingDirOnly` clears the per-directory scan cache.
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
