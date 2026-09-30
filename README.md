# pi-xt-context

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that
auto-loads nested context files when the model works in a directory — by
`cd`-ing into it, or by touching a file there with `read` / `edit` / `write` /
`grep` / `ls` / `find`.

Pi already loads context for the **launch directory** at startup. Deeper trees
stay invisible until something in them is touched. This extension injects those
nested files once, durably, before the model's next response.

Default pattern: `AGENTS.md`. Configure additional globs in `settings.json`.

## What the model receives

A file is never handed over twice:

- **Read by the agent** — if the session already read it with the `read` tool,
  it is not injected. The model has it.
- **Unchanged** — injected once. Later touches of the same directory inject
  nothing.
- **Changed on disk** — a short notice with a bounded diff (30 lines), not a
  second copy of the file. Read it again if the change matters.
- **Dropped by compaction** — if pi's compaction hid the injected block and the
  directory is still in scope, the file is injected again, because the model no
  longer holds it.

Ancestor files shared by many directories are read once per session and reused.

## Install

```bash
pi install git:github.com/furbyhaxx/pi-xt-context
```

Or a local checkout:

```bash
pi install /path/to/pi-xt-context
```

Then restart pi, or `/reload`.

## Commands

| Command | What it does |
|---|---|
| `/context` | Overview: loaded counts, directories, effective settings |
| `/context list` | Unique loaded paths (Pi startup vs extension) |
| `/context config` | Interactive user/project settings editor (TUI) |

No LLM call. Changing discovery settings cannot un-inject files already in the
session — start a new session for that.

## Configuration

Settings live under `"context"` in Pi's `settings.json` (user and trusted
project). `PI_CODING_AGENT_DIR` is honored via Pi's `getAgentDir()`.

See [docs/configuration.md](docs/configuration.md) for the schema, glob
semantics, trust rules, and migration from `on-demand-context.json`.

## Development

```bash
npm install
npm test
```

No build step: pi loads `index.ts` (and `src/`) as TypeScript.

`npm run bench` measures context-file reads and syscalls over a synthetic
300-leaf tree (needs `strace`).

## License

MIT — see [LICENSE](LICENSE).
