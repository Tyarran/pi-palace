# AGENTS.md

Instructions for AI agents working on this repository.

## 🏛️ Overview

**pi-palace** is an extension for the [pi](https://github.com/earendil-works/pi) agent that automatically plugs the [MemPalace](https://github.com/milla-jovovich/mempalace) persistent memory system into pi sessions: automatic checkpoints, emergency save before compaction, personalized wake-up on startup, daily background mining, and a centralized MCP connection.

This is a **local pi package** (declared via `"pi": { "extensions": ["./index.ts"] }` in `package.json`), not a standalone application. The `index.ts` entry point exports the extension through the `ExtensionAPI` from `@mariozechner/pi-coding-agent`.

## 📁 Code structure

All files live at the repo root, in TypeScript, with no `src/` directory:

| File | Role |
| --- | --- |
| `index.ts` | Extension entry point: pi hooks (`session_start`, `session_shutdown`, `before_agent_start`, `agent_end`, `session_before_compact`), the `/checkpoint` command, global orchestration |
| `settings.ts` | Reads/merges `piPalace` settings (global + project), `AutosaveSettings` typing |
| `constants.ts` | System prompts (`CHECKPOINT_SYSTEM_PROMPT`, `PRECOMPACT_SYSTEM_PROMPT`) and toast texts |
| `checkpoint-agent.ts` | Resolves the configured model + runs the checkpoint sub-agent |
| `checkpoint-tool.ts` | Defines the `mempalace_checkpoint` tool exposed to the sub-agent |
| `counter.ts` | Counts relevant exchanges to trigger an auto-checkpoint every N messages |
| `mcp-manager.ts` | Initializes/manages the MCP connection to MemPalace (light + optional "full") |
| `persistent-mcp-client.ts` | Stdio JSON-RPC MCP client kept open for the whole session |
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
- Test files sit next to the module they cover, named `*.test.ts` (e.g. `counter.test.ts`).
- If `bun` isn't on the `PATH`, install it via `mise install` (the project pins it in `mise.toml`).

## 🤝 Contributing

For code conventions, the development workflow, commit message rules (Conventional Commits), and points of caution, see **[CONTRIBUTING.md](./CONTRIBUTING.md)**.

> ⚠️ Commit messages: Conventional Commits, **single line only, no multi-line body** (`<type>: <description>`). Do not add a body/footer even to explain rationale — see [CONTRIBUTING.md § Commit messages](./CONTRIBUTING.md#-commit-messages).
