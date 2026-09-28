import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";
import { ensureDaemonRunning, submitDailyMineJob } from "./daemon-client.js";
import { readState, todayISO, writeState } from "./daily-mine-state.js";
import type { AutosaveSettings } from "./settings.js";

export interface MinimalUi {
	hasUI: boolean;
	notify: (message: string, level: "info" | "warning" | "error") => void;
}

/**
 * Runs at most once per calendar day, across all pi sessions: a full
 * verbatim mine of ~/.pi/agent/sessions/ into a dedicated wing. Complements
 * the curated checkpoint (agent_end) rather than replacing it — see the
 * brainstorm session decision: scripts like update-memory.sh only make
 * sense for sources that can't self-feed memory; pi conversations can, via
 * this extension.
 */
export async function maybeRunDailyMine(settings: AutosaveSettings, ctx: MinimalUi): Promise<void> {
	if (!settings.dailyMine.enabled) return;

	const state = await readState();
	const today = todayISO();
	// Checked against lastAttemptDate, not lastSuccessDate: a failed attempt
	// must not retry within the same day (retry next day only, per decision).
	if (state?.lastAttemptDate === today) return;

	// Written BEFORE doing any work, to shrink the race window between two
	// pi sessions starting near-simultaneously (dedupe_key on the daemon
	// side is the real safety net for that race; this is a first line of
	// defense that also avoids submitting a doomed-to-be-redundant job).
	await writeState({ ...state, lastAttemptDate: today });

	const daemonOk = await ensureDaemonRunning();
	if (!daemonOk) {
		if (ctx.hasUI) ctx.notify("MemPalace : impossible de démarrer le daemon pour le minage quotidien ❌", "error");
		return;
	}

	if (ctx.hasUI) ctx.notify("MemPalace : minage quotidien des sessions pi en cours...", "info");

	const sessionsDir = join(getAgentDir(), "sessions");
	// wait=False under the hood: "success" here means the job was accepted
	// into the daemon queue, not that mining actually finished. No
	// completion toast is shown (deliberate trade-off — waiting for the
	// real result could block behind an arbitrarily long queue and delay
	// pi's own process exit, as observed during testing).
	const result = await submitDailyMineJob(sessionsDir, settings.dailyMine.wing, settings.dailyMine.limit);

	if (result.success) {
		await writeState({ lastAttemptDate: today, lastSuccessDate: today });
	} else {
		if (ctx.hasUI) ctx.notify("MemPalace : minage quotidien échoué ❌", "error");
		// lastSuccessDate intentionally left untouched — retries tomorrow.
	}
}
