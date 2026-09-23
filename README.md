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

### 2. 🚨 Emergency save before compaction

Right before pi compacts the context (and loses part of it), pi-palace steps in to save what was about to disappear. One last chance to not lose anything.

### 3. ☀️ Personalized wake-up on startup

At the start of every session, the agent receives a short digest of who you are — your preferences, working habits, and what's happened recently — injected straight into its context. No need to repeat yourself every time.

### 4. ⛏️ Daily background mining

Once a day, a thorough automatic pass goes through your pi session history and enriches your memory from what it finds — complementing the targeted, in-conversation checkpointing above.

### 5. 🔌 Always-ready memory connection

pi-palace keeps a live connection to MemPalace open for the whole session, so reading and writing memory (search, diary, preferences) is instant instead of starting from scratch on every call.

### 6. 🛠️ Manual trigger

The `/checkpoint` command lets you force a save at any time, without waiting for the next automatic trigger.

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
| `piPalace.model.provider` / `piPalace.model.id` | The model used to curate and decide what to keep during a save | `string` / `string` | *(none — disables checkpointing)* |
| `piPalace.mcp.full.enabled` | Enable the optional full MemPalace MCP server (in addition to the mandatory light one) | `boolean` | `false` |

---

## 🧪 Development

```bash
# Clone and setup
git clone https://github.com/<org>/pi-palace
cd pi-palace
bun install

# Run tests
bun test
```

> No `build`/`lint` script exists yet — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the current dev workflow (edit → `pi reload` → manual verification under real conditions).

---

## 📝 Recent changes

- **Diary routed to its own wing**: the checkpoint's diary entry now files into `piPalace.diaryWing` (default `"diaries"`) instead of sharing a wing with anything else, and is written under a fixed `piPalace.agentName` (default `"pi"`) — locking write and read (startup wake-up) to the same identity so the wake-up digest never silently misses an entry due to a naming drift.

## 🙏 Credits

- **[MemPalace](https://github.com/milla-jovovich/mempalace)** — the persistent memory system this extension builds on.
- **[pi](https://github.com/earendil-works/pi)** — the coding agent that makes this extension possible.
- **[opencode-mempalace](https://github.com/nguyentamdat/opencode-mempalace)** — inspiration for the memory integration approach on the OpenCode side.

---

## 📄 License

[MIT](./LICENSE)
