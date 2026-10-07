import { describe, expect, test } from "bun:test";
import { DAILY_MINE_DEDUPE_KEY } from "../src/daemon-client.js";
import type { DailyMineState } from "../src/daily-mine-state.js";
import { type DailyMineDeps, maybeRunDailyMine, runManualMine } from "../src/daily-mine.js";
import type { AutosaveSettings } from "../src/settings.js";

function makeSettings(enabled: boolean): AutosaveSettings {
	return { dailyMine: { enabled, wing: "pi-test", limit: 42 } } as unknown as AutosaveSettings;
}

function makeHarness(opts: { state?: DailyMineState | null; daemonOk?: boolean; submitOk?: boolean } = {}) {
	const calls = {
		submit: [] as Array<{ sessionsDir: string; wing: string; limit: number; dedupeKey: string | null }>,
		readState: 0,
		writes: [] as DailyMineState[],
		ensureDaemon: 0,
	};
	const deps: DailyMineDeps = {
		ensureDaemonRunning: async () => {
			calls.ensureDaemon++;
			return opts.daemonOk ?? true;
		},
		submitDailyMineJob: async (sessionsDir, wing, limit, dedupeKey) => {
			calls.submit.push({ sessionsDir, wing, limit, dedupeKey });
			return opts.submitOk === false ? { success: false, error: "boom" } : { success: true };
		},
		readState: async () => {
			calls.readState++;
			return opts.state ?? null;
		},
		writeState: async (s) => {
			calls.writes.push(s);
		},
		todayISO: () => "2026-10-08",
		sessionsDir: () => "/fake/sessions",
	};
	const toasts: Array<{ message: string; level: string }> = [];
	const ui = { hasUI: true, notify: (message: string, level: string) => toasts.push({ message, level }) };
	return { calls, deps, toasts, ui: ui as Parameters<typeof runManualMine>[1] };
}

describe("runManualMine", () => {
	test("mines even when dailyMine.enabled is false, with the configured wing/limit", async () => {
		const h = makeHarness();
		const ok = await runManualMine(makeSettings(false), h.ui, h.deps);
		expect(ok).toBe(true);
		expect(h.calls.submit).toEqual([{ sessionsDir: "/fake/sessions", wing: "pi-test", limit: 42, dedupeKey: null }]);
	});

	test("ignores the once-a-day guard and never touches the daily state", async () => {
		const h = makeHarness({ state: { lastAttemptDate: "2026-10-08", lastSuccessDate: "2026-10-08" } });
		await runManualMine(makeSettings(true), h.ui, h.deps);
		expect(h.calls.submit).toHaveLength(1);
		expect(h.calls.readState).toBe(0);
		expect(h.calls.writes).toEqual([]);
	});

	test("notifies progress once, then nothing more on success", async () => {
		const h = makeHarness();
		await runManualMine(makeSettings(false), h.ui, h.deps);
		expect(h.toasts).toHaveLength(1);
		expect(h.toasts[0]?.level).toBe("info");
	});

	test("error toast and no submission when the daemon cannot start", async () => {
		const h = makeHarness({ daemonOk: false });
		const ok = await runManualMine(makeSettings(false), h.ui, h.deps);
		expect(ok).toBe(false);
		expect(h.calls.submit).toHaveLength(0);
		expect(h.toasts.map((t) => t.level)).toEqual(["error"]);
	});

	test("error toast when the job is refused", async () => {
		const h = makeHarness({ submitOk: false });
		const ok = await runManualMine(makeSettings(false), h.ui, h.deps);
		expect(ok).toBe(false);
		expect(h.toasts.map((t) => t.level)).toEqual(["info", "error"]);
	});

	test("emits no toast without UI", async () => {
		const h = makeHarness({ submitOk: false });
		const ui = { hasUI: false, notify: () => h.toasts.push({ message: "x", level: "x" }) };
		await runManualMine(makeSettings(false), ui, h.deps);
		expect(h.toasts).toHaveLength(0);
	});
});

describe("maybeRunDailyMine (unchanged behavior)", () => {
	test("does nothing when disabled", async () => {
		const h = makeHarness();
		await maybeRunDailyMine(makeSettings(false), h.ui, h.deps);
		expect(h.calls.ensureDaemon).toBe(0);
		expect(h.calls.submit).toHaveLength(0);
	});

	test("does nothing when already attempted today", async () => {
		const h = makeHarness({ state: { lastAttemptDate: "2026-10-08" } });
		await maybeRunDailyMine(makeSettings(true), h.ui, h.deps);
		expect(h.calls.submit).toHaveLength(0);
		expect(h.calls.writes).toEqual([]);
	});

	test("on success: writes attempt first, submits with the daily dedupe key, then records success", async () => {
		const h = makeHarness({ state: { lastAttemptDate: "2026-10-07", lastSuccessDate: "2026-10-07" } });
		await maybeRunDailyMine(makeSettings(true), h.ui, h.deps);
		expect(h.calls.submit[0]?.dedupeKey).toBe(DAILY_MINE_DEDUPE_KEY);
		expect(h.calls.writes).toEqual([
			{ lastAttemptDate: "2026-10-08", lastSuccessDate: "2026-10-07" },
			{ lastAttemptDate: "2026-10-08", lastSuccessDate: "2026-10-08" },
		]);
	});

	test("on failure: only the attempt date is written, no success date", async () => {
		const h = makeHarness({ submitOk: false });
		await maybeRunDailyMine(makeSettings(true), h.ui, h.deps);
		expect(h.calls.writes).toEqual([{ lastAttemptDate: "2026-10-08" }]);
	});
});
