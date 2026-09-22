import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveConfiguredModel, runCheckpointAgent } from "./checkpoint-agent.js";
import { countRelevantUserMessages, extractAllExchanges, extractRecentExchanges } from "./counter.js";
import { CHECKPOINT_SYSTEM_PROMPT, PRECOMPACT_SYSTEM_PROMPT, TOAST_ERROR, TOAST_SUCCESS } from "./constants.js";
import { maybeRunDailyMine } from "./daily-mine.js";
import { buildPersonalizationContext } from "./personalize.js";
import { type AutosaveSettings, loadAutosaveSettings } from "./settings.js";

export default function (pi: ExtensionAPI) {
	let settings: AutosaveSettings = {
		interval: 15,
		mode: "silent",
		userWing: undefined,
		dailyMine: { enabled: false, wing: "pi" },
		model: undefined,
		injectUserProfile: { enabled: true },
	};
	let lastCheckpointCount = 0;
	// Re-evaluated once per session_start (not per-check) — see the model
	// resolution below. Defaults to disabled until session_start has run.
	let checkpointDisabled = true;
	// Guards before_agent_start, which fires on EVERY prompt, not just the
	// first — profile injection must only be attempted (i.e. actually
	// applied) once per session.
	let profileInjected = false;
	// undefined = fetch still in flight or not started, null = fetch failed,
	// string = ready to inject. Fetched fire-and-forget from session_start so
	// it never blocks the first response — injected on whichever turn it
	// happens to be ready by (often not the very first one, deliberately).
	let profileDigest: string | null | undefined;

	pi.on("session_start", async (_event, ctx) => {
		settings = await loadAutosaveSettings(ctx.cwd);
		lastCheckpointCount = 0;

		if (!settings.model) {
			checkpointDisabled = true;
			if (ctx.hasUI) {
				ctx.ui.notify(
					"pi-mempalace-autosave: no model configured for checkpoint (mempalaceAutosave.model) — checkpoints disabled.",
					"warning",
				);
			}
		} else {
			const resolved = resolveConfiguredModel(ctx, settings.model);
			checkpointDisabled = !resolved;
			if (!resolved && ctx.hasUI) {
				ctx.ui.notify(
					`pi-mempalace-autosave: configured model not found (${settings.model.provider}/${settings.model.id}) — checkpoints disabled.`,
					"warning",
				);
			}
		}

		if (!settings.userWing && ctx.hasUI) {
			ctx.ui.notify(
				'pi-mempalace-autosave: "userWing" is not configured in settings.json (mempalaceAutosave.userWing) — user preference filing will be skipped.',
				"warning",
			);
		}

		// Fire-and-forget — never blocks session_start, even though the daily
		// mine itself awaits the daemon job internally (can take a long time
		// on a large sessions directory). Independent of checkpointDisabled:
		// daily-mine doesn't use the checkpoint sub-agent model at all.
		void maybeRunDailyMine(settings, { hasUI: ctx.hasUI, notify: (msg, level) => ctx.ui.notify(msg, level) });

		profileInjected = false;
		profileDigest = undefined;

		// Fire-and-forget: kicked off here so it's very likely already resolved
		// by the time the SECOND user message triggers before_agent_start (the
		// fetch takes ~2-3s, far less than typical time between messages). The
		// first response is intentionally not delayed to wait for it — accepted
		// trade-off: the very first reply of a session may not be personalized.
		if (settings.injectUserProfile.enabled && settings.userWing) {
			const wing = settings.userWing;
			buildPersonalizationContext(wing)
				.then((d) => {
					profileDigest = d;
				})
				.catch(() => {
					profileDigest = null;
				});
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!settings.injectUserProfile.enabled || profileInjected || !settings.userWing) {
			return;
		}
		if (profileDigest === undefined) {
			// Not ready yet — skip this turn without blocking, try again next
			// turn (profileInjected stays false until an actual attempt lands).
			return;
		}
		profileInjected = true; // one applied attempt per session, success or failure

		if (profileDigest === null) {
			if (ctx.hasUI) ctx.ui.notify("pi-mempalace-autosave: user profile injection unavailable ⚠️", "warning");
			return;
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n<mempalace-user-profile>\n${profileDigest}\n</mempalace-user-profile>`,
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (checkpointDisabled) return;
		if (!settings.userWing) return; // no point running without a target wing configured; see notice above

		const currentCount = countRelevantUserMessages(ctx);
		if (currentCount <= 0) return;
		if (currentCount - lastCheckpointCount < settings.interval) return;
		lastCheckpointCount = currentCount;

		const excerpt = extractRecentExchanges(ctx.sessionManager.getBranch(), settings.interval);
		await triggerCheckpoint(ctx, settings, excerpt, CHECKPOINT_SYSTEM_PROMPT(settings.userWing, ctx.cwd));
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (checkpointDisabled) return;
		if (!settings.userWing) return;

		const excerpt = extractAllExchanges(event.branchEntries);
		if (!excerpt) return;

		// Fire-and-forget (or blocking per settings), but never cancel the
		// compaction itself — silent-by-default behavior, acted on in the plan.
		await triggerCheckpoint(ctx, settings, excerpt, PRECOMPACT_SYSTEM_PROMPT(settings.userWing, ctx.cwd));
	});

	pi.registerCommand("checkpoint", {
		description: "Manually trigger a MemPalace checkpoint (same behavior as the automatic one)",
		handler: async (_args, ctx) => {
			if (checkpointDisabled) {
				ctx.ui.notify("pi-mempalace-autosave: checkpoint disabled (model not configured/found)", "warning");
				return;
			}
			if (!settings.userWing) {
				ctx.ui.notify(
					'pi-mempalace-autosave: "userWing" is not configured in settings.json (mempalaceAutosave.userWing)',
					"warning",
				);
				return;
			}

			// Identical extraction + prompt + trigger path as the automatic
			// agent_end hook, just invoked on demand instead of by the counter.
			const currentCount = countRelevantUserMessages(ctx);
			const excerpt = extractRecentExchanges(ctx.sessionManager.getBranch(), settings.interval);
			await triggerCheckpoint(ctx, settings, excerpt, CHECKPOINT_SYSTEM_PROMPT(settings.userWing, ctx.cwd));

			// Resync the interval counter so the next automatic trigger doesn't
			// fire again immediately right after this manual one.
			lastCheckpointCount = currentCount;
		},
	});
}

async function triggerCheckpoint(
	ctx: Pick<ExtensionContext, "hasUI" | "ui" | "cwd" | "modelRegistry">,
	settings: AutosaveSettings,
	excerpt: string,
	systemPrompt: string,
): Promise<void> {
	const run = async () => {
		try {
			const model = resolveConfiguredModel(ctx, settings.model);
			if (!model) {
				// Should not normally happen (checkpointDisabled guards this),
				// but keep an explicit error path in case settings.model was
				// resolvable at session_start and became unresolvable since.
				throw new Error("configured checkpoint model not available");
			}
			await runCheckpointAgent({ conversationExcerpt: excerpt, systemPrompt, cwd: ctx.cwd, model });
			if (ctx.hasUI) ctx.ui.notify(TOAST_SUCCESS, "info");
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(TOAST_ERROR, "error");
			if (process.env.MEMPALACE_AUTOSAVE_DEBUG) console.error("[pi-mempalace-autosave] error:", err);
		}
	};

	if (settings.mode === "blocking") {
		await run();
	} else {
		void run();
	}
}
