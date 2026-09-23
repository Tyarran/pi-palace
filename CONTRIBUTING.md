# Contributing to pi-palace

Thanks for contributing! 🙌 This document describes the rules to follow when proposing changes to this repository.

## 🎨 Code conventions

- **Strict TypeScript**, functional style (functions + exported interfaces) — no classes in the existing modules.
- **Indentation: tabs** (no spaces) — explicit maintainer preference for all TypeScript code.
- Large system prompts are generator functions (`(args) => \`template\``) in `constants.ts`, not separate `.md` files.
- Temporary debug logs (`console.error`) are tolerated but should be gated behind a verbosity-control environment variable if the pattern becomes widespread (e.g. `DEBUG_MEMPALACE_AUTOSAVE`).
- UI notifications always go through a defensive function like `safeNotify` (the callback may run after the synchronous turn that triggered it has ended).

## 🛠️ Development workflow

- Test suite via `bun test` (see [AGENTS.md](./AGENTS.md#-tests) and the README's [Development](./README.md#-development) section). No `build`/`lint` script in `package.json` as of today — verify before assuming one exists.
- Usual dev cycle: edit code → `pi reload` (reload the extension) → test under real conditions in a pi session (`/checkpoint`, `STATUS`, `DIARY <agent> LAST N`) to confirm content is filed in the right wing / under the right identity.
- Pragmatic debugging approach: add temporary `console.log`/`console.error`, review, then clean up before committing.
- This repo uses **Jujutsu (jj)**, not just git — check `jj log`/`jj status` in addition to `git` when relevant.

## 📝 Commit messages

Commit messages must follow the **[Conventional Commits](https://www.conventionalcommits.org/)** convention, **on a single line** (no multi-line body):

```text
<type>: <description>
```

Examples:
- `feat: add forceMemoryRecall option to prompt proactive memory callbacks`
- `fix: route checkpoint diary to a configurable wing`
- `chore: update readme`

Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`.

## ⚠️ Points of caution

- `settings.ts::loadAutosaveSettings` has high complexity and a large fan-out — handle with care when modifying it (it's the source of truth for merging global/project settings).
- Any change touching the `agentName`/`diaryWing` identity must preserve write (checkpoint) ↔ read (wake-up) consistency, or entries risk becoming silently invisible.
- `README.md` precisely documents all `piPalace.*` options: keep it up to date with every config option added/renamed.
