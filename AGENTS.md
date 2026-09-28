# AGENTS.md

Instructions for AI agents working on this repository.

## 🏛️ Overview

**pi-palace** is an extension for the [pi](https://github.com/earendil-works/pi) agent that automatically plugs the [MemPalace](https://github.com/milla-jovovich/mempalace) persistent memory system into pi sessions: automatic checkpoints, emergency save before compaction, personalized wake-up on startup, daily background mining, and a centralized MCP connection.

This is a **local pi package** (declared via `"pi": { "extensions": ["./src/index.ts"] }` in `package.json`), not a standalone application. The `src/index.ts` entry point exports the extension through the `ExtensionAPI` from `@mariozechner/pi-coding-agent`.

## 📁 Code structure

Source lives in `src/`, tests live in a parallel `tests/` directory (mirroring `mempalace-pi`'s layout rather than the older flat-root-with-co-located-tests convention):

```
pi-palace/
├── src/            # implementation — everything below is src/<file>
├── tests/          # *.test.ts, one per module, importing from ../src/<file>.js
├── README.md / AGENTS.md / CONTRIBUTING.md / CLAUDE.md
└── package.json / tsconfig.json / mise.toml
```

| File (under `src/`) | Role |
| --- | --- |
| `index.ts` | Extension entry point: pi hooks (`session_start`, `session_shutdown`, `before_agent_start`, `agent_end`, `session_before_compact`), the `/checkpoint` command, global orchestration |
| `settings.ts` | Reads/merges `piPalace` settings (global + project), `AutosaveSettings` typing |
| `constants.ts` | System prompts (`CHECKPOINT_SYSTEM_PROMPT`, `PRECOMPACT_SYSTEM_PROMPT`) and toast texts |
| `checkpoint-agent.ts` | Resolves the configured model + runs the checkpoint sub-agent |
| `checkpoint-tool.ts` | Defines the `mempalace_checkpoint` tool exposed to the sub-agent |
| `counter.ts` | Counts relevant exchanges to trigger an auto-checkpoint every N messages |
| `mcp-manager.ts` | Initializes/manages the MCP connections to MemPalace (light and full, each individually toggleable, never both disabled at once); branches the **full** connection's read path between stdio and the HTTP hub per `piPalace.mcp.transport` (light is always stdio when enabled — see `hub-manager.ts`) |
| `persistent-mcp-client.ts` | Stdio JSON-RPC MCP client kept open for the whole session |
| `hub-manager.ts` | Lifecycle of the shared read-only HTTP MCP hub (`mempalace serve --read-only`) used when `piPalace.mcp.transport === "http"` |
| `hub-client.ts` | HTTP JSON-RPC client for the hub (`tools/list`/`tools/call` over `/mcp`) |
| `hub-token.ts` | Generates/persists pi-palace's own bearer token for the hub |
| `write-routing.ts` | Ensures MemPalace's `write_routing.cli`/`write_routing.hooks` policy (`~/.mempalace/config.json`) is set, without overwriting an explicit existing value |
| `daemon-client.ts` | Communication with the daemon for daily mining |
| `daily-mine.ts` | Triggers the daily background mining pass |
| `daily-mine-state.ts` | Persists state (last run date) for daily mining |
| `wake-up.ts` | Fetches the welcome digest (user preferences + diary) on startup |
| `wake-up-cli.ts` | CLI/standalone variant of the wake-up |

## 🧠 Key concepts

- **3 distinct wings** used by a checkpoint:
  - `piPalace.userWing`: user preferences/habits
  - a wing derived from `basename(cwd)`: project items (decisions, problems, technical notes)
  - `piPalace.diaryWing` (default `"diaries"`): diary entry, filed under a fixed `piPalace.agentName` identity (default `"pi"`)
- **Diary write/read separation**: writing (checkpoint) and reading (wake-up) must use the exact same `agent_name`, otherwise wake-up won't find the entry (a "silent drift" already hit and fixed — see `constants.ts` and `index.ts`).
- **Isolated sub-agent** for checkpointing: run via `createAgentSession()` with no extensions (`noExtensions: true`), tools restricted to `mempalace_checkpoint` (`noTools: 'builtin'`), system prompt injected via `appendSystemPromptOverride`. This avoids a direct Python call into MemPalace (deemed fragile) in favor of a real stdio JSON-RPC MCP client.
- **Two save modes** (`piPalace.mode`): `"silent"` (fire-and-forget, no retry) or `"blocking"` (visible, blocking).
- **Emergency save**: on `session_before_compact`, a more aggressive checkpoint (`PRECOMPACT_SYSTEM_PROMPT`) fires in silent mode to avoid losing anything before compaction.
- All configuration goes through the `piPalace` namespace in `settings.json` (global or project). See the full table in `README.md`.

## 🧪 Tests

- Test runner: **`bun test`** (bun installed/pinned via `mise` — see `mise.toml`).
- Run the full suite: `bun test` (or `npm test`, which proxies to `bun test`).
- `test` and `typecheck` (`tsc --noEmit`) are wired up in `package.json`; no `build`/`lint` script exists yet. `devDependencies` (`@mariozechner/pi-*`, `typebox`, `@types/*`) exist solely to make `typecheck` possible locally — pi provides these at runtime, they are not runtime dependencies of this package.
- Test files live in `tests/`, one per module, named `*.test.ts` (e.g. `tests/counter.test.ts` covers `src/counter.ts`), importing from `../src/<module>.js`.
- If `bun` isn't on the `PATH`, install it via `mise install` (the project pins it in `mise.toml`).

## 🤝 Contributing

For code conventions, the development workflow, commit message rules (Conventional Commits), and points of caution, see **[CONTRIBUTING.md](./CONTRIBUTING.md)**.

> ⚠️ Commit messages: Conventional Commits, **single line only, no multi-line body** (`<type>: <description>`). Do not add a body/footer even to explain rationale — see [CONTRIBUTING.md § Commit messages](./CONTRIBUTING.md#-commit-messages).
