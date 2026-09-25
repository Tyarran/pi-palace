```
                                                                                          
              ██                                   ▄▄▄▄                                   
              ▀▀                                   ▀▀██                                   
 ██▄███▄    ████               ██▄███▄    ▄█████▄    ██       ▄█████▄   ▄█████▄   ▄████▄  
 ██▀  ▀██     ██               ██▀  ▀██   ▀ ▄▄▄██    ██       ▀ ▄▄▄██  ██▀    ▀  ██▄▄▄▄██ 
 ██    ██     ██      █████    ██    ██  ▄██▀▀▀██    ██      ▄██▀▀▀██  ██        ██▀▀▀▀▀▀ 
 ███▄▄██▀  ▄▄▄██▄▄▄            ███▄▄██▀  ██▄▄▄███    ██▄▄▄   ██▄▄▄███  ▀██▄▄▄▄█  ▀██▄▄▄▄█ 
 ██ ▀▀▀    ▀▀▀▀▀▀▀▀            ██ ▀▀▀     ▀▀▀▀ ▀▀     ▀▀▀▀    ▀▀▀▀ ▀▀    ▀▀▀▀▀     ▀▀▀▀▀  
 ██                            ██                                                         
                                                                                          
```
# 🏛️ pi-palace

> **A memory that actually remembers you and your projects** — automatic [MemPalace](https://github.com/milla-jovovich/mempalace) integration for [pi](https://github.com/earendil-works/pi), with zero commands to type.

pi-palace is an extension for **pi** that plugs the agent into your persistent MemPalace memory: it quietly remembers what matters from your conversations, wakes up at startup already knowing who you are, and files your daily exchanges away in the background — without you ever having to think about it.

---

## ✨ What changes day to day

| Without pi-palace | With pi-palace |
| --- | --- |
| You have to explicitly ask the agent to remember something | Important decisions, discoveries, and preferences are saved automatically |
| Every new session starts from scratch | The agent wakes up with a reminder of who you are and your habits |
| Context lost to compaction is gone for good | An emergency save fires right before context gets compacted |
| Your pi session history just sits there, never used | A daily background pass mines your sessions to enrich memory over time |

---

## 🎯 Features

### 1. 🧠 Automatic conversation checkpointing

Every N exchanges (configurable), the ongoing conversation is reviewed and anything with real future value — decisions made, problems solved, discoveries, expressed preferences — gets filed into MemPalace. Everything else (mechanical actions, trivial details) is skipped. It all happens silently, without interrupting what you're doing.

Each checkpoint routes what it finds to up to three separate wings:
- **User preferences/habits** → `piPalace.userWing`
- **Project items** (decisions, technical notes, problems) → automatically derived from the current working directory's basename
- **Diary entry** → `piPalace.diaryWing`, filed under a fixed `piPalace.agentName` identity so the startup wake-up (which looks up diary entries by that same identity, regardless of which wing they're stored in) always finds it

Beyond drawers, the checkpoint sub-agent also has access to MemPalace's knowledge-graph tools (`mempalace_kg_add`, `mempalace_kg_supersede`, `mempalace_kg_invalidate`) and decides, case by case, whether something is better filed as a free-form drawer or as a clean subject/predicate/object fact worth tracking over time (a tool/model/library in use, an employer, a status — for both user preferences and project facts). A single-valued fact that changes (e.g. switched database) is superseded atomically instead of accumulating as competing drawers.

Under the hood, the save itself isn't executed directly through the session's own MCP connection: it's submitted as a job to the MemPalace daemon's queue and runs once the daemon is free. This avoids checkpoints silently failing when another process (typically the daily mining pass) is already holding the palace's single-writer lock. A failed checkpoint now surfaces an actionable toast instead of a generic one — it's classified (stale MCP server library, corrupted vector index, a mine currently holding the lock, or an unreachable daemon) and points at the specific fix.

### 2. 🚨 Emergency save before compaction

Right before pi compacts the context (and loses part of it), pi-palace steps in to save what was about to disappear. One last chance to not lose anything.

### 3. ☀️ Personalized wake-up on startup

At the start of every session, the agent receives a short digest of who you are — your preferences, working habits, and what's happened recently — injected straight into its context. No need to repeat yourself every time.

### 4. 🧭 Talking to the same person, every time

A search-before-answer recall protocol — reinjected every turn, not just the first — tells the agent to actively search the palace (`mempalace_search`, `mempalace_kg_query`) before answering questions about past work, people, or decisions, instead of guessing from model memory or relying solely on the startup digest. When something in the current conversation genuinely connects to a topic or decision from the past, the agent calls it out — "this is the same idea we discussed about X" — instead of starting from a blank slate. It stays natural: relevant and generous, never a forced callback on every single message. Whatever it retrieves from the palace is always quoted **verbatim**, never summarized or paraphrased — a dedicated instruction enforces this independently of the recall protocol itself.

### 5. ⛏️ Daily background mining

Once a day, a thorough automatic pass goes through your pi session history and enriches your memory from what it finds — complementing the targeted, in-conversation checkpointing above.

### 6. 🔌 Always-ready memory connection

pi-palace keeps a live connection to MemPalace open for the whole session, so reading and writing memory (search, diary, preferences) is instant instead of starting from scratch on every call.

### 7. 🛠️ Manual trigger

The `/checkpoint` command lets you force a save at any time, without waiting for the next automatic trigger.

### 8. 🧹 Palace audit & repair

The `/palace-audit` command runs a read-only `mempalace audit`, walks you through an interactive repair session — one question at a time, recommended option first, nothing done without confirmation (merging duplicate wings/rooms, cleaning up generic tunnels/hallways, agreeing a consistent knowledge-graph vocabulary, structuring flat wings into rooms) — then a `mempalace_sync` pass (dry-run first) to prune drawers whose source files are gone, and closes out with a before/after score diary entry. Requires `piPalace.mcp.full.enabled` (the repair step needs the full server's tunnel/hallway/sync tools). Manual trigger only, never runs in the background.

### 9. 🔒 Every write goes through the daemon

Every `mempalace_*` write tool available in a session — not just checkpoints — is routed through the MemPalace daemon's job queue instead of the session's own MCP connection, and waits for the real result (bounded: it does not block through an entire concurrent mine, only until the palace write lock's refusal is observed). Read-only tools (search, status, KG queries, navigation, …) still call straight through for speed. This closes a gap where any mutating tool call made directly by the agent — not just the dedicated checkpoint path — could fail outright with "Peer MCP writer active" whenever the daemon was mid-mine.

---

## ⚙️ Configuration

All options are set in pi's `settings.json` (global or project), under the `piPalace` key.

| Option | Description | Type | Default |
| --- | --- | --- | --- |
| `piPalace.interval` | Number of exchanges between two automatic saves | `number` | `15` |
| `piPalace.mode` | Save mode: `"silent"` (background) or `"blocking"` (visible/blocking) | `"silent" \| "blocking"` | `"silent"` |
| `piPalace.userWing` | The MemPalace "wing" where your preferences and habits are stored (separate from projects) | `string` | *(none — disables preference filing)* |
| `piPalace.agentName` | Fixed identity used both when writing the diary entry (`agent_name`) and when reading it back at wake-up — keeping both sides locked to the same value guarantees wake-up never misses an entry due to a naming drift | `string` | `"pi"` |
| `piPalace.diaryWing` | The MemPalace "wing" where the checkpoint's diary entry is filed (separate from `userWing` and from the cwd-derived project wing used for decisions/technical/problems items) | `string` | `"diaries"` |
| `piPalace.dailyMine.enabled` | Enable/disable the daily background mining pass | `boolean` | `false` |
| `piPalace.dailyMine.wing` | Target wing for the daily mining pass | `string` | `"pi"` |
| `piPalace.dailyMine.limit` | Max files processed per daily mining run (`0` = unlimited) | `number` | `100` |
| `piPalace.injectWakeUp.enabled` | Enable/disable the personalized wake-up on startup | `boolean` | `true` |
| `piPalace.injectWakeUp.mode` | `"sync"` waits for the wake-up before the first response; `"async"` moves on without it and injects it as soon as it's ready | `"sync" \| "async"` | `"sync"` |
| `piPalace.injectWakeUp.source` | Which wing the wake-up CLI fetch is scoped to: `"user"` uses `piPalace.userWing` (degrades to no wing at all if unset), `"project"` uses the cwd-derived project wing, `"custom"` uses `piPalace.injectWakeUp.wing` (degrades to `"user"` behavior if unset), `null` calls `mempalace wake-up` without any `--wing` at all | `"user" \| "project" \| "custom" \| null` | `"user"` |
| `piPalace.injectWakeUp.wing` | The explicit wing name used when `injectWakeUp.source` is `"custom"` | `string` | *(none)* |
| `piPalace.model.provider` / `piPalace.model.id` | The model used to curate and decide what to keep during a save | `string` / `string` | *(none — disables checkpointing)* |
| `piPalace.mcp.full.enabled` | Enable the optional full MemPalace MCP server (in addition to the mandatory light one) | `boolean` | `false` |
| `piPalace.forceMemoryRecall.enabled` | Enable/disable instructing the agent to call back to past conversations/topics when relevant (has no effect if `injectWakeUp.enabled` is `false`) | `boolean` | `true` |
| `piPalace.forceMemoryRecall.level` | `"sometimes"` calls back only when genuinely relevant, generously but never forced; `"always"` asks for a callback in every response | `"sometimes" \| "always"` | `"sometimes"` |

---

## 🧩 Example configuration

A full `piPalace` block showing every option at its default value:

```json
{
  "piPalace": {
    "interval": 15,
    "mode": "silent",
    "userWing": null,
    "agentName": "pi",
    "diaryWing": "diaries",
    "dailyMine": {
      "enabled": false,
      "wing": "pi",
      "limit": 100
    },
    "model": null,
    "injectWakeUp": {
      "enabled": true,
      "mode": "sync",
      "source": "user",
      "wing": null
    },
    "mcp": {
      "full": { "enabled": false }
    },
    "forceMemoryRecall": {
      "enabled": true,
      "level": "sometimes"
    }
  }
}
```

> `userWing` and `model` have no real default (checkpointing/preference filing stay disabled until set); shown as `null` here only to make every key visible. `injectWakeUp.wing` is only read when `injectWakeUp.source` is `"custom"`.

---

## 🧪 Development

```bash
# Clone and setup
git clone https://github.com/<org>/pi-palace
cd pi-palace
bun install

# Run tests
bun test

# Type-check (devDependencies only — @mariozechner/pi-coding-agent etc. are
# provided at runtime by pi itself, not a runtime dependency of this package)
bun run typecheck
```

> No `lint` script exists yet — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the current dev workflow (edit → `pi reload` → manual verification under real conditions).

---

## 📝 Recent changes

- **Recall improvements**: the memory-callback instruction was rewritten into a search-before-answer protocol (adapted from MemPalace's own `mempalace-recall` skill) and is now reinjected on every turn instead of only the first message, so it stays in force for the whole session. A dedicated verbatim-discipline instruction was added alongside it. The checkpoint sub-agent can now also write knowledge-graph facts (`mempalace_kg_add`/`kg_supersede`/`kg_invalidate`) in addition to drawers. A new `/palace-audit` command runs MemPalace's audit + interactive repair + sync flow. Checkpoint failures now show an actionable, classified toast instead of a generic one.
- **Every write tool now daemon-routed**: previously only `/checkpoint` avoided the session's direct MCP connection for writes; every `mempalace_*` write tool exposed to the agent now goes through the same daemon job queue (blocking for the real result this time, bounded against a concurrent mine via the daemon's own lock-deferral signal) — read-only tools are unaffected.
- **Configurable wake-up wing (`injectWakeUp.source`)**: the startup wake-up used to be hardcoded to `piPalace.userWing`. It's now configurable via `piPalace.injectWakeUp.source` (`"user"` / `"project"` / `"custom"` + `injectWakeUp.wing` / `null`), defaulting to `"user"` for full backward compatibility.
- **Checkpoint saves routed through the daemon's job queue**: `/checkpoint` and automatic saves no longer call MemPalace's light MCP server directly for the write — they submit a fire-and-forget `mcp_tool` job to the MemPalace daemon instead. The light MCP server tries to grab the palace's single-writer lock itself, which used to fail immediately ("Peer MCP writer active", silently dropped in `"silent"` mode) whenever the daemon was mid-mine. Going through the daemon's own queue means the checkpoint durably waits its turn instead of being lost. Trade-off: the tool now reports "queued" instead of the synchronous added/duplicates/errors/diary result.
- **Diary routed to its own wing**: the checkpoint's diary entry now files into `piPalace.diaryWing` (default `"diaries"`) instead of sharing a wing with anything else, and is written under a fixed `piPalace.agentName` (default `"pi"`) — locking write and read (startup wake-up) to the same identity so the wake-up digest never silently misses an entry due to a naming drift.

## 🙏 Credits

- **[MemPalace](https://github.com/milla-jovovich/mempalace)** — the persistent memory system this extension builds on.
- **[pi](https://github.com/earendil-works/pi)** — the coding agent that makes this extension possible.
- **[opencode-mempalace](https://github.com/nguyentamdat/opencode-mempalace)** — inspiration for the memory integration approach on the OpenCode side.

---

## 📄 License

[MIT](./LICENSE)
