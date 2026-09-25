import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveConfiguredModel, runCheckpointAgent } from "./checkpoint-agent.js";
import { countRelevantUserMessages, extractAllExchanges, extractRecentExchanges } from "./counter.js";
import {
	CHECKPOINT_SYSTEM_PROMPT,
	MEMORY_RECALL_INSTRUCTION,
	PALACE_AUDIT_PROTOCOL,
	PRECOMPACT_SYSTEM_PROMPT,
	TOAST_ERROR_FOR,
	TOAST_STARTED,
	TOAST_SUCCESS,
	VERBATIM_DISCIPLINE_INSTRUCTION,
} from "./constants.js";
import { classifyMempalaceError } from "./daemon-client.js";
import { maybeRunDailyMine } from "./daily-mine.js";
import { initMcpManager, type McpManager } from "./mcp-manager.js";
import { fetchDiaryDigest, fetchWakeUpDigest, resolveWakeUpWing } from "./wake-up.js";
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

/**
 * Gated debug logger — see CONTRIBUTING.md's "Temporary debug logs" note:
 * tolerated when gated behind a verbosity-control env var, which this
 * centralizes into a single call site instead of a scattered
 * `if (process.env.MEMPALACE_AUTOSAVE_DEBUG) console.error(...)` per site.
 */
function debugLog(...parts: unknown[]): void {
	if (!process.env.MEMPALACE_AUTOSAVE_DEBUG) return;
	const log = console.error;
	try {
		log("[pi-palace]", ...parts);
	} catch {
		// best-effort debug logging only — a formatting/console failure must
		// never crash the session over a log line.
	}
}

export default function (pi: ExtensionAPI) {
	let settings: AutosaveSettings = {
		interval: 15,
		mode: "silent",
		userWing: undefined,
		agentName: "pi",
		diaryWing: "diaries",
		dailyMine: { enabled: false, wing: "pi", limit: 100 },
		model: undefined,
		injectWakeUp: { enabled: true, mode: "sync", source: "user" },
		mcp: { full: { enabled: false } },
		forceMemoryRecall: { enabled: true, level: "sometimes" },
	};
	let lastCheckpointCount = 0;
	// Re-evaluated once per session_start (not per-check) — see the model
	// resolution below. Defaults to disabled until session_start has run.
	let checkpointDisabled = true;
	// Guards ONLY the wake-up digest fetch (point 1/5 changed this: the
	// recall protocol + verbatim discipline blocks are now reinjected on
	// EVERY turn instead, see before_agent_start below — a session-wide
	// behavior instruction has to stay in force past the first message to
	// be meaningful). This flag still ensures the "sync" mode's blocking
	// wake-up fetch (~2-3s) is only attempted once per session, not on every
	// turn.
	let wakeUpFetchAttempted = false;
	// undefined = fetch still in flight or not started (async mode only, see
	// below), null = fetch failed, string = ready. Only populated in "async"
	// mode — in "sync" mode wake-up is fetched directly inside
	// before_agent_start instead, so this stays unused there.
	let wakeUpDigest: string | null | undefined;
	// ALWAYS fire-and-forget regardless of injectWakeUp.mode — diary_read is
	// never awaited by before_agent_start, in either mode (see wake-up.ts).
	let diaryDigest: string | null | undefined;
	// The wing (possibly null — a legitimate "call the CLI without --wing"
	// state, see resolveWakeUpWing) the wake-up fetch is scoped to for this
	// session, resolved once in session_start from injectWakeUp.source.
	let resolvedWing: string | null = null;
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
					"pi-palace: no model configured for checkpoint (piPalace.model) — checkpoints disabled.",
					"warning",
				);
			}
		} else {
			const resolved = resolveConfiguredModel(ctx, settings.model);
			checkpointDisabled = !resolved;
			if (!resolved && ctx.hasUI) {
				ctx.ui.notify(
					`pi-palace: configured model not found (${settings.model.provider}/${settings.model.id}) — checkpoints disabled.`,
					"warning",
				);
			}
		}

		if (!settings.userWing && ctx.hasUI) {
			ctx.ui.notify(
				'pi-palace: "userWing" is not configured in settings.json (piPalace.userWing) — user preference filing will be skipped.',
				"warning",
			);
		}

		mcpManager?.close();
		mcpManager = null;
		wakeUpFetchAttempted = false;
		wakeUpDigest = undefined;
		diaryDigest = undefined;

		resolvedWing = resolveWakeUpWing(settings, ctx.cwd);
		const injectEnabled = settings.injectWakeUp.enabled;

		// Fire-and-forget — connecting to the MCP servers and registering their
		// tools (tools/list can take a while under palace contention, same
		// order of magnitude as the ~30s costs fought earlier this project) must
		// never block session_start. Newly registered tools still appear
		// immediately in the running session once ready (no /reload needed), so
		// this only delays WHEN palace_query/palace_exec become callable, not
		// the session's responsiveness. diary_read (always best-effort, never
		// awaited by before_agent_start regardless of injectWakeUp.mode) rides
		// along once the connection is ready.
		initMcpManager(pi, settings)
			.then((manager) => {
				mcpManager = manager;
				// diary_read is keyed on agentName, not on any wing — independent of
				// injectWakeUp.source/resolvedWing.
				if (injectEnabled) {
					fetchDiaryDigest(manager, settings.agentName)
						.then((d) => {
							diaryDigest = d;
						})
						.catch(() => {
							diaryDigest = null;
						});
				}
			})
			.catch((err) => {
				safeNotify(ctx, "pi-palace: MCP connection failed ❌", "error");
				debugLog("MCP init error:", err);
				diaryDigest = null;
			});

		// wake-up is only pre-fetched fire-and-forget in "async" mode. In "sync"
		// mode it's fetched directly inside before_agent_start instead, so the
		// first response actually waits for it.
		if (injectEnabled && settings.injectWakeUp.mode === "async") {
			fetchWakeUpDigest(resolvedWing)
				.then((d) => {
					wakeUpDigest = d;
				})
				.catch(() => {
					wakeUpDigest = null;
				});
		}

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
		if (!settings.injectWakeUp.enabled) {
			return;
		}

		let wakeUpPart: string | null;
		if (settings.injectWakeUp.mode === "sync") {
			if (wakeUpFetchAttempted) {
				// Already fetched (or attempted) once this session — "sync" mode
				// only pays its blocking latency on the first turn. Later turns
				// reuse whatever the first attempt produced (cached below), even
				// if it was null (failure isn't retried mid-session).
				wakeUpPart = wakeUpDigest ?? null;
			} else {
				// Blocks THIS turn (i.e. the response) for the wake-up fetch alone
				// (~2-3s) — the whole point of "sync" mode: guarantee the first
				// response is personalized, at the cost of that latency. resolvedWing
				// may be null (source: null, or a degraded "user"/"custom") — the CLI
				// is then called without --wing, which is a valid attempt, not a skip.
				wakeUpFetchAttempted = true;
				wakeUpPart = await fetchWakeUpDigest(resolvedWing).catch(() => null);
				wakeUpDigest = wakeUpPart; // cache for later turns, mirroring "async" mode's own cache
			}
		} else {
			// "async" mode: wakeUpDigest is populated fire-and-forget from
			// session_start (see below) — undefined means "not ready yet", not
			// "never will be", so later turns keep picking up whatever landed.
			wakeUpPart = wakeUpDigest ?? null;
		}

		// diary_read: take whatever is available RIGHT NOW, never wait for it
		// (see wake-up.ts) — in "sync" mode this is almost always still
		// undefined/missing on the FIRST turn, since the MCP connection has
		// barely started by the time the fast wake-up fetch resolves, but
		// reliably present by later turns since this hook now re-reads it
		// every time instead of only once.
		const parts = [wakeUpPart, diaryDigest].filter((p): p is string => Boolean(p));

		debugLog(
			"DEBUG wake-up injection: mode=",
			settings.injectWakeUp.mode,
			"wakeUpPart=",
			wakeUpPart ? `${wakeUpPart.length} chars` : "missing",
			"diaryDigest=",
			diaryDigest ? `${diaryDigest.length} chars` : "missing",
		);

		// forceMemoryRecall (protocol) and the verbatim discipline block are
		// behavior instructions, not memory content — reinjected every turn
		// regardless of whether an actual digest is available this time, so
		// the search-before-answer protocol stays in force for the whole
		// session (see MEMORY_RECALL_INSTRUCTION's doc comment in constants.ts).
		const recallInstruction = settings.forceMemoryRecall.enabled
			? `\n\n${MEMORY_RECALL_INSTRUCTION(settings.forceMemoryRecall.level)}\n\n${VERBATIM_DISCIPLINE_INSTRUCTION}`
			: "";

		if (parts.length === 0 && !recallInstruction) {
			if (ctx.hasUI && !wakeUpFetchAttempted) ctx.ui.notify("pi-palace: wake-up injection unavailable ⚠️", "warning");
			return;
		}

		const digestBlock = parts.length > 0 ? `\n\n<mempalace-user-profile>\n${parts.join("\n\n")}\n</mempalace-user-profile>` : "";
		return {
			systemPrompt: `${event.systemPrompt}${digestBlock}${recallInstruction}`,
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
		await triggerCheckpoint(ctx, settings, excerpt, CHECKPOINT_SYSTEM_PROMPT(settings.userWing, ctx.cwd, settings.diaryWing, settings.agentName));
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (checkpointDisabled || !mcpManager) return;
		if (!settings.userWing) return;

		const excerpt = extractAllExchanges(event.branchEntries);
		if (!excerpt) return;

		// Fire-and-forget (or blocking per settings), but never cancel the
		// compaction itself — silent-by-default behavior, acted on in the plan.
		await triggerCheckpoint(ctx, settings, excerpt, PRECOMPACT_SYSTEM_PROMPT(settings.userWing, ctx.cwd, settings.diaryWing, settings.agentName));
	});

	pi.registerCommand("checkpoint", {
		description: "Manually trigger a MemPalace checkpoint (same behavior as the automatic one)",
		handler: async (_args, ctx) => {
			if (checkpointDisabled || !mcpManager) {
				ctx.ui.notify("pi-palace: checkpoint disabled (model not configured/found, or MCP unavailable)", "warning");
				return;
			}
			if (!settings.userWing) {
				ctx.ui.notify(
					'pi-palace: "userWing" is not configured in settings.json (piPalace.userWing)',
					"warning",
				);
				return;
			}

			// Identical extraction + prompt + trigger path as the automatic
			// agent_end hook, just invoked on demand instead of by the counter.
			const currentCount = countRelevantUserMessages(ctx);
			const excerpt = extractRecentExchanges(ctx.sessionManager.getBranch(), settings.interval);
			await triggerCheckpoint(ctx, settings, excerpt, CHECKPOINT_SYSTEM_PROMPT(settings.userWing, ctx.cwd, settings.diaryWing, settings.agentName));

			// Resync the interval counter so the next automatic trigger doesn't
			// fire again immediately right after this manual one.
			lastCheckpointCount = currentCount;
		},
	});

	// Points 3+4 — audit + interactive repair + sync, run inline in the MAIN
	// session (not an isolated sub-agent like /checkpoint) so the agent has
	// bash (for `mempalace audit`/`mempalace rooms propose|apply`) AND every
	// registered mempalace_* tool available, all write tools now daemon-routed
	// via mcp-manager.ts. Manual trigger only — no background automation.
	pi.registerCommand("palace-audit", {
		description: "Run a MemPalace palace health audit, then an interactive repair + sync session",
		handler: async (_args, ctx) => {
			if (!mcpManager) {
				ctx.ui.notify("pi-palace: MCP unavailable — cannot run a palace audit", "warning");
				return;
			}
			if (!settings.mcp.full.enabled) {
				ctx.ui.notify(
					'pi-palace: the full MemPalace MCP server is disabled (piPalace.mcp.full.enabled) — the repair step needs its tunnel/hallway/sync tools, enable it first',
					"warning",
				);
				return;
			}
			pi.sendUserMessage(PALACE_AUDIT_PROTOCOL);
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
		// Fired in both modes ("silent" and "blocking") — in "silent" mode this
		// is the only visible sign a checkpoint is even happening, since the
		// hook returns immediately afterwards without waiting for it.
		safeNotify(ctx, TOAST_STARTED, "info");
		try {
			const model = resolveConfiguredModel(ctx, settings.model);
			if (!model) {
				// Should not normally happen (checkpointDisabled guards this),
				// but keep an explicit error path in case settings.model was
				// resolvable at session_start and became unresolvable since.
				throw new Error("configured checkpoint model not available");
			}
			await runCheckpointAgent({ conversationExcerpt: excerpt, systemPrompt, cwd: ctx.cwd, model });
			safeNotify(ctx, TOAST_SUCCESS, "info");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			safeNotify(ctx, TOAST_ERROR_FOR(classifyMempalaceError(message)), "error");
			if (process.env.MEMPALACE_AUTOSAVE_DEBUG) console.error("[pi-palace] error:", err);
		}
	};

	if (settings.mode === "blocking") {
		await run();
	} else {
		void run();
	}
}
