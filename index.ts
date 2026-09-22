import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveConfiguredModel, runCheckpointAgent } from "./checkpoint-agent.js";
import { countRelevantUserMessages, extractAllExchanges, extractRecentExchanges } from "./counter.js";
import { CHECKPOINT_SYSTEM_PROMPT, PRECOMPACT_SYSTEM_PROMPT, TOAST_ERROR, TOAST_SUCCESS } from "./constants.js";
import { maybeRunDailyMine } from "./daily-mine.js";
import { initMcpManager, type McpManager } from "./mcp-manager.js";
import { buildPersonalizationContext } from "./personalize.js";
import { type AutosaveSettings, loadAutosaveSettings } from "./settings.js";

/**
 * Notifies defensively for callbacks that may run well after the triggering
 * event's synchronous turn (fire-and-forget promises, deferred MCP setup).
 * ctx can go stale in the meantime — observed in practice with `pi -p`,
 * whose process can tear the session down before a slow MCP handshake
 * resolves; accessing ctx.hasUI on a stale ctx throws and crashes the whole
 * process. There is nothing useful to do if that happens (no one is left
 * to show a toast to), so the error is swallowed.
 */
function safeNotify(ctx: Pick<ExtensionContext, "hasUI" | "ui">, message: string, level: "info" | "warning" | "error"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	} catch {
		// ctx stale — nothing to do.
	}
}

export default function (pi: ExtensionAPI) {
	let settings: AutosaveSettings = {
		interval: 15,
		mode: "silent",
		userWing: undefined,
		dailyMine: { enabled: false, wing: "pi" },
		model: undefined,
		injectUserProfile: { enabled: true },
		mcp: { full: { enabled: false } },
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
	// The persistent MCP connections (light mandatory, full opt-in), shared
	// by the main session's registered tools AND the checkpoint sub-agent /
	// profile digest — see mcp-manager.ts for why this replaced the old
	// one-shot-per-call clients.
	let mcpManager: McpManager | null = null;

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

		mcpManager?.close();
		mcpManager = null;
		profileInjected = false;
		profileDigest = undefined;

		// Fire-and-forget — connecting to the MCP servers and registering their
		// tools (tools/list can take a while under palace contention, same
		// order of magnitude as the ~30s costs fought earlier this project) must
		// never block session_start. Newly registered tools still appear
		// immediately in the running session once ready (no /reload needed), so
		// this only delays WHEN palace_query/palace_exec become callable, not
		// the session's responsiveness.
		const wing = settings.userWing;
		const injectProfile = settings.injectUserProfile.enabled;
		initMcpManager(pi, settings)
			.then((manager) => {
				mcpManager = manager;
				if (injectProfile && wing) {
					buildPersonalizationContext(wing, manager)
						.then((d) => {
							profileDigest = d;
						})
						.catch(() => {
							profileDigest = null;
						});
				}
			})
			.catch((err) => {
				safeNotify(ctx, "pi-mempalace-autosave: MCP connection failed ❌", "error");
				if (process.env.MEMPALACE_AUTOSAVE_DEBUG) console.error("[pi-mempalace-autosave] MCP init error:", err);
				profileDigest = null;
			});

		// Fire-and-forget — never blocks session_start, even though the daily
		// mine itself awaits the daemon job internally (can take a long time
		// on a large sessions directory). Independent of checkpointDisabled:
		// daily-mine doesn't use the checkpoint sub-agent model at all.
		void maybeRunDailyMine(settings, { hasUI: true, notify: (msg, level) => safeNotify(ctx, msg, level) });
	});

	pi.on("session_shutdown", async () => {
		mcpManager?.close();
		mcpManager = null;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (process.env.MEMPALACE_AUTOSAVE_DEBUG) {
			console.error(
				"[pi-mempalace-autosave] DEBUG before_agent_start: enabled=",
				settings.injectUserProfile.enabled,
				"profileInjected=",
				profileInjected,
				"userWing=",
				settings.userWing,
				"profileDigest=",
				profileDigest === undefined ? "undefined (not ready)" : profileDigest === null ? "null (failed)" : `ready (${profileDigest.length} chars)`,
			);
		}
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
			if (process.env.MEMPALACE_AUTOSAVE_DEBUG) console.error("[pi-mempalace-autosave] DEBUG profile injection FAILED (digest null)");
			return;
		}

		if (process.env.MEMPALACE_AUTOSAVE_DEBUG) {
			console.error(`[pi-mempalace-autosave] DEBUG profile injection APPLIED (${profileDigest.length} chars added to system prompt):`);
			console.error(profileDigest);
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n<mempalace-user-profile>\n${profileDigest}\n</mempalace-user-profile>`,
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (checkpointDisabled || !mcpManager) return;
		if (!settings.userWing) return; // no point running without a target wing configured; see notice above

		const currentCount = countRelevantUserMessages(ctx);
		if (currentCount <= 0) return;
		if (currentCount - lastCheckpointCount < settings.interval) return;
		lastCheckpointCount = currentCount;

		const excerpt = extractRecentExchanges(ctx.sessionManager.getBranch(), settings.interval);
		await triggerCheckpoint(ctx, settings, mcpManager, excerpt, CHECKPOINT_SYSTEM_PROMPT(settings.userWing, ctx.cwd));
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (checkpointDisabled || !mcpManager) return;
		if (!settings.userWing) return;

		const excerpt = extractAllExchanges(event.branchEntries);
		if (!excerpt) return;

		// Fire-and-forget (or blocking per settings), but never cancel the
		// compaction itself — silent-by-default behavior, acted on in the plan.
		await triggerCheckpoint(ctx, settings, mcpManager, excerpt, PRECOMPACT_SYSTEM_PROMPT(settings.userWing, ctx.cwd));
	});

	pi.registerCommand("checkpoint", {
		description: "Manually trigger a MemPalace checkpoint (same behavior as the automatic one)",
		handler: async (_args, ctx) => {
			if (checkpointDisabled || !mcpManager) {
				ctx.ui.notify("pi-mempalace-autosave: checkpoint disabled (model not configured/found, or MCP unavailable)", "warning");
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
			await triggerCheckpoint(ctx, settings, mcpManager, excerpt, CHECKPOINT_SYSTEM_PROMPT(settings.userWing, ctx.cwd));

			// Resync the interval counter so the next automatic trigger doesn't
			// fire again immediately right after this manual one.
			lastCheckpointCount = currentCount;
		},
	});
}

async function triggerCheckpoint(
	ctx: Pick<ExtensionContext, "hasUI" | "ui" | "cwd" | "modelRegistry">,
	settings: AutosaveSettings,
	mcpManager: McpManager,
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
			await runCheckpointAgent({ conversationExcerpt: excerpt, systemPrompt, cwd: ctx.cwd, model, mcpManager });
			safeNotify(ctx, TOAST_SUCCESS, "info");
		} catch (err) {
			safeNotify(ctx, TOAST_ERROR, "error");
			if (process.env.MEMPALACE_AUTOSAVE_DEBUG) console.error("[pi-mempalace-autosave] error:", err);
		}
	};

	if (settings.mode === "blocking") {
		await run();
	} else {
		void run();
	}
}
