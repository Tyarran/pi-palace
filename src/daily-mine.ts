import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";
import { DAILY_MINE_DEDUPE_KEY, ensureDaemonRunning, submitDailyMineJob } from "./daemon-client.js";
import { type DailyMineState, readState, todayISO, writeState } from "./daily-mine-state.js";
import type { AutosaveSettings } from "./settings.js";

export interface MinimalUi {
	hasUI: boolean;
	notify: (message: string, level: "info" | "warning" | "error") => void;
}

/**
 * Injectable collaborators — defaults are the real implementations. Exists
 * so tests can stub the daemon/state without `mock.module`, which is global
 * to the bun process and would leak into other test files.
 */
export interface DailyMineDeps {
	ensureDaemonRunning: () => Promise<boolean>;
	submitDailyMineJob: (
		sessionsDir: string,
		wing: string,
		limit: number,
		dedupeKey: string | null,
	) => Promise<{ success: boolean; error?: string }>;
	readState: () => Promise<DailyMineState | null>;
	writeState: (state: DailyMineState) => Promise<void>;
	todayISO: () => string;
	sessionsDir: () => string;
}

const defaultDeps: DailyMineDeps = {
	ensureDaemonRunning,
	submitDailyMineJob,
	readState,
	writeState,
	todayISO,
	sessionsDir: () => join(getAgentDir(), "sessions"),
};

/**
 * Runs at most once per calendar day, across all pi sessions: a full
 * verbatim mine of ~/.pi/agent/sessions/ into a dedicated wing. Complements
 * the curated checkpoint (agent_end) rather than replacing it — see the
 * brainstorm session decision: scripts like update-memory.sh only make
 * sense for sources that can't self-feed memory; pi conversations can, via
 * this extension.
 */
export async function maybeRunDailyMine(
	settings: AutosaveSettings,
	ctx: MinimalUi,
	deps: DailyMineDeps = defaultDeps,
): Promise<void> {
	if (!settings.dailyMine.enabled) return;

	const state = await deps.readState();
	const today = deps.todayISO();
	// Checked against lastAttemptDate, not lastSuccessDate: a failed attempt
	// must not retry within the same day (retry next day only, per decision).
	if (state?.lastAttemptDate === today) return;

	// Written BEFORE doing any work, to shrink the race window between two
	// pi sessions starting near-simultaneously (dedupe_key on the daemon
	// side is the real safety net for that race; this is a first line of
	// defense that also avoids submitting a doomed-to-be-redundant job).
	await deps.writeState({ ...state, lastAttemptDate: today });

	const ok = await submitSessionsMine(settings, ctx, deps, {
		label: "quotidien",
		dedupeKey: DAILY_MINE_DEDUPE_KEY,
	});

	// lastSuccessDate intentionally left untouched on failure — retries tomorrow.
	if (ok) await deps.writeState({ lastAttemptDate: today, lastSuccessDate: today });
}

/**
 * On-demand variant (`/palace-mine`): same source, wing and limit as the
 * daily mine, but ignores `dailyMine.enabled` and the once-a-day guard, never
 * reads or writes the daily state, and passes no dedupe_key (never coalesced
 * with a daily job). Fire-and-forget like the daily mine.
 */
export async function runManualMine(
	settings: AutosaveSettings,
	ctx: MinimalUi,
	deps: DailyMineDeps = defaultDeps,
): Promise<boolean> {
	return submitSessionsMine(settings, ctx, deps, { label: "manuel", dedupeKey: null });
}

/**
 * Shared core: ensures the daemon is up, notifies, and submits the job.
 * Returns true when the job was accepted into the daemon queue.
 */
async function submitSessionsMine(
	settings: AutosaveSettings,
	ctx: MinimalUi,
	deps: DailyMineDeps,
	opts: { label: string; dedupeKey: string | null },
): Promise<boolean> {
	const daemonOk = await deps.ensureDaemonRunning();
	if (!daemonOk) {
		if (ctx.hasUI) ctx.notify(`MemPalace : impossible de démarrer le daemon pour le minage ${opts.label} ❌`, "error");
		return false;
	}

	if (ctx.hasUI) ctx.notify(`MemPalace : minage ${opts.label} des sessions pi en cours...`, "info");

	// wait=False under the hood: "success" here means the job was accepted
	// into the daemon queue, not that mining actually finished. No
	// completion toast is shown (deliberate trade-off — waiting for the
	// real result could block behind an arbitrarily long queue and delay
	// pi's own process exit, as observed during testing).
	const result = await deps.submitDailyMineJob(
		deps.sessionsDir(),
		settings.dailyMine.wing,
		settings.dailyMine.limit,
		opts.dedupeKey,
	);

	if (!result.success && ctx.hasUI) ctx.notify(`MemPalace : minage ${opts.label} échoué ❌`, "error");
	return result.success;
}
