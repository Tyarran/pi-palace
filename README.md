# pi-mempalace-autosave

A pi extension that automatically feeds [MemPalace](https://github.com/MemPalace/mempalace) with the content of your pi sessions — no manual intervention, no skills or commands to remember.

Two complementary mechanisms:

1. **Curated checkpoint** — an isolated LLM sub-agent periodically reads the conversation, extracts what has real future value (decisions, discoveries, preferences...), and files it into MemPalace via `mempalace_checkpoint`.
2. **Daily exhaustive mine** — once a day, the entirety of `~/.pi/agent/sessions/` is mined verbatim (no curation), guaranteeing full recall even for content the checkpoint would have judged trivial in the moment.

---

## Why two mechanisms?

> A script like `update-memory.sh` only makes sense for sources that can't feed memory automatically (Slack, wiki, reports...). For pi conversations, the extension has native access to the session lifecycle — this should be a feature of the extension, not an external script.

The curated checkpoint and the exhaustive mine are **not redundant**: the first captures *signal* (what matters), the second guarantees *recall* (nothing is lost, even what seemed trivial at the time). This mirrors MemPalace's own recommended architecture (save hooks + periodic `mempalace sweep`/`mine`).

---

## Installation

Place the folder at `~/.pi/agent/extensions/pi-mempalace-autosave/` (auto-discovered by pi). Requires:
- The `mempalace` CLI installed and on `PATH` (`uv tool install mempalace` or `pipx install mempalace`)
- A configured model (see below) — **without it, checkpointing is disabled**

---

## Configuration

In `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project):

```json
{
  "mempalaceAutosave": {
    "interval": 15,
    "mode": "silent",
    "userWing": "romain",
    "model": {
      "provider": "anthropic",
      "id": "claude-haiku-4-5"
    },
    "dailyMine": {
      "enabled": false,
      "wing": "pi"
    },
    "injectUserProfile": {
      "enabled": true
    }
  }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `interval` | `number` | `15` | Number of user messages between two automatic checkpoints |
| `mode` | `"silent" \| "blocking"` | `"silent"` | `silent` = runs in the background, never interrupts the conversation. `blocking` = waits for the checkpoint to finish before continuing |
| `userWing` | `string` | *(none)* | Wing where detected preferences/working habits are filed, and where the startup profile digest is scoped from. **Required** for checkpointing and profile injection to work |
| `model.provider` / `model.id` | `string` | *(none)* | Model used by the curation sub-agent. **Required** — any provider supported (Anthropic, OpenAI, Google...). No default on purpose: lets you swap models after a benchmark without favoring one provider |
| `dailyMine.enabled` | `boolean` | `false` | Enables the daily exhaustive mine of pi sessions |
| `dailyMine.wing` | `string` | `"pi"` | Target wing for the daily mine |
| `injectUserProfile.enabled` | `boolean` | `true` | Enables the startup profile digest (MemPalace wake-up injected into the system prompt) |

### Why no default model?

Unlike `interval` or `mode`, `model` **deliberately has no default value**. If missing or not found (wrong provider/id, no API key for that provider), a toast explicitly warns and **disables checkpointing** (periodic, pre-compaction, and the manual command) rather than silently falling back to an assumed model. This keeps the extension generic and avoids masking a configuration mistake.

The **daily mine is not affected** by this — it doesn't use any LLM.

---

## How it works

### Automatic checkpoint (`agent_end`)

Every `interval` user messages (excluding slash commands), an isolated sub-agent (in-memory session, with no access to the main session's extensions/skills/tools, only the `mempalace_checkpoint` tool) analyzes the recent exchange and decides what to save:

- **Decisions**, **discoveries**, **resolved problems**, **project context** → filed under the wing dynamically detected from `cwd` (same convention as `mempalace mine`)
- **Preferences and working habits** → filed under `userWing`
- One **AAAK diary** entry summarizing the exchange
- Nothing trivial gets saved — if the exchange has no future value, no drawer is created

### Emergency save (`session_before_compact`)

Before any context compaction, the same mechanism fires with the entire branch being compacted (not just recent messages), in "be thorough" mode. Compaction is **not blocked** — the save happens in parallel.

### Manual command (`/checkpoint`)

Triggers the exact same pipeline as the automatic one, on demand. Resyncs the interval counter to avoid an immediate double-trigger right after.

### Daily mine (`session_start`, if `dailyMine.enabled`)

At most once per calendar day (state persisted in `~/.mempalace/hook_state/pi-mempalace-autosave-daily-mine.json`), the extension:

1. Checks/starts the MemPalace daemon if needed
2. Submits a `mempalace mine ~/.pi/agent/sessions/ --mode convos` job with a fixed `dedupe_key`, so no concurrent pi session can submit an active duplicate
3. Shows an "in progress" toast

⚠️ Submission does **not** wait for the mine to actually finish (`wait=False`) — a job can end up behind a long queue on the daemon, and waiting would block pi's process exit. There is therefore **no completion toast**: success means "accepted into the queue", not "mining finished".

MemPalace natively supports the pi session format (detected by JSON structure, not by path) — no prior conversion needed.

### Startup profile injection (`before_agent_start`, if `injectUserProfile.enabled`)

Fetches `mempalace wake-up --wing <userWing>` (CLI, L0 identity + L1 essential story, ~600-900 tokens) and injects it **silently** into the system prompt — never shown as a visible message.

The fetch is kicked off **fire-and-forget at `session_start`**, not awaited before the first response. In practice this means the very first reply of a session is usually *not* personalized (the fetch takes ~2-3s, so it typically finishes before the second message), while every later turn benefits from it as soon as it's ready. This was a deliberate trade-off after testing: awaiting the fetch inside `before_agent_start` blocked the first response, adding several seconds of latency before the agent could say anything.

Injection itself still only happens **once** per session, on whichever turn the digest happens to be ready by — guarded so it's never re-applied on subsequent turns.

`mempalace_diary_read` was tried twice and dropped both times. First, awaited synchronously: it added ~30s to the first response (our one-shot MCP client spawns a fresh `mempalace-mcp` process per call, paying a full chromadb/onnxruntime/embedding-model startup cost every time). Second, after making the fetch fire-and-forget: the response was no longer delayed, but the spawned child process kept the Node process itself alive for ~30s before exit — harmless in interactive mode, but breaks `pi -p` / scripting use cases. Instead, the injected digest includes a note telling the agent it can call `mempalace_diary_read` itself on demand, through its own already-connected MCP session (fast, no extra process spawn).

On failure (e.g. a palace write lock held by another process), a discreet warning toast fires once the fetch resolves — never blocks startup.

---

## File structure

```
index.ts               # Hooks (agent_end, session_before_compact, session_start) + /checkpoint command
constants.ts             # Sub-agent system prompts, toast text
settings.ts                # Reading/validating settings.json config
counter.ts                   # Relevant-message counting + exchange extraction
checkpoint-agent.ts             # Isolated session (pi SDK) running the curation
checkpoint-tool.ts                 # mempalace_checkpoint tool for the sub-agent
mcp-client.ts                        # Minimal MCP JSON-RPC stdio client (spawns mempalace-mcp)
daily-mine.ts                          # Daily mine orchestration
daemon-client.ts                         # MemPalace daemon management + job submission with dedupe_key
daily-mine-state.ts                        # Persisted state (last mine date)
personalize.ts                               # Startup user profile digest (wake-up)
wake-up-cli.ts                                 # `mempalace wake-up` CLI wrapper
```

---

## Why a homemade MCP client instead of `pi-mcp-adapter`?

The checkpoint sub-agent runs in an isolated session (`createAgentSession`, `SessionManager.inMemory()`, `DefaultResourceLoader` with every discovery flag disabled). Reusing the main session's MCP connection isn't possible (private internal state in `pi-mcp-adapter`, no public API) — and importing `mempalace.mcp_server`'s internal Python modules directly proved fragile in practice (output redirected to stderr, read-only behavior outside the server context). The minimal MCP JSON-RPC client (`mcp-client.ts`) spawns `mempalace-mcp` for a single call, over the standard, documented, stable protocol.

## Why the daemon for the daily mine but not for checkpointing?

The checkpoint (`mempalace_checkpoint`) is a single, fast call — the direct MCP protocol is enough. The daily mine can cover thousands of files and needs to be **deduplicated across concurrent sessions**: the MemPalace daemon, with its sequential job queue and native `dedupe_key` support, is the only mechanism that guarantees a single job of this kind runs at a time without reinventing our own lock.

---

## Debugging

```bash
MEMPALACE_AUTOSAVE_DEBUG=1 pi
```

Prints internal errors (checkpoint failures, job submission failures) to stderr.
