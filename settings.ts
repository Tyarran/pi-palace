import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type CheckpointMode = "silent" | "blocking";
export type InjectWakeUpMode = "sync" | "async";
export type InjectWakeUpSource = "user" | "project" | "custom" | null;
export type MemoryRecallLevel = "sometimes" | "always";

export interface DailyMineSettings {
	enabled: boolean;
	wing: string;
	// Max files processed per run (mempalace mine's own --limit convention:
	// 0 = unlimited). Caps the worst case for someone installing the
	// extension after a long pi history — spreads a big backlog over
	// several days instead of one very long first run.
	limit: number;
}

export interface ModelSettings {
	provider: string;
	id: string;
}

export interface InjectWakeUpSettings {
	enabled: boolean;
	// "sync": the first response waits for the wake-up fetch (CLI, ~2-3s) —
	// guarantees the first message is personalized, at the cost of latency.
	// "async": fire-and-forget from session_start, injected whichever turn
	// it happens to be ready by (may not be the first one). diary_read is
	// ALWAYS best-effort/async regardless of this mode — never awaited, so
	// in "sync" mode it will most often be missing from the injected digest
	// (the MCP connection has barely started by the time wake-up resolves).
	mode: InjectWakeUpMode;
	// Which wing the wake-up CLI fetch ("mempalace wake-up") is scoped to.
	// "user": piPalace.userWing (default, backward-compatible) — degrades to
	// null (CLI called without --wing) if userWing isn't set. "project":
	// the cwd-derived project wing (same basename(cwd) convention as the
	// checkpoint's project items). "custom": the `wing` field below —
	// degrades to "user" behavior if `wing` isn't set. null: call the CLI
	// without --wing at all (its own default scope, whatever that is).
	source: InjectWakeUpSource;
	// Only used when source === "custom".
	wing?: string;
}

export interface McpSettings {
	// light has no toggle — always connected, it's the mandatory baseline.
	full: { enabled: boolean };
}

export interface ForceMemoryRecallSettings {
	enabled: boolean;
	// "sometimes": the injected instruction asks the model to reference past
	// topics/decisions only when genuinely relevant, generously but never
	// forced. "always": asks for a callback in every single response,
	// regardless of relevance — experimental, kept for evaluation. Has no
	// effect if injectWakeUp.enabled is false, since there is then no digest
	// for the instruction to point back to (see index.ts).
	level: MemoryRecallLevel;
}

export interface AutosaveSettings {
	interval: number;
	mode: CheckpointMode;
	userWing: string | undefined;
	// Fixed identity used both when WRITING the diary entry (agent_name in
	// checkpoint's diary payload) and when READING it back at wake-up
	// (diary_read's agent_name filter). Keeping both sides locked to the same
	// configured value (rather than leaving agent_name to the checkpoint
	// sub-agent's own judgment) guarantees wake-up never silently misses
	// entries due to a naming drift. Has a real default ("pi") — unlike
	// userWing/model, there's no useful "disabled" state for this one.
	agentName: string;
	// Dedicated wing for the checkpoint's diary entry, separate from userWing
	// (profile only) and from the cwd-derived project wing (items). Has a
	// real default ("diaries") so diary filing works out of the box.
	diaryWing: string;
	dailyMine: DailyMineSettings;
	// No default on purpose: absence means checkpoint features are disabled
	// (see index.ts) rather than silently falling back to a hardcoded model.
	model: ModelSettings | undefined;
	injectWakeUp: InjectWakeUpSettings;
	mcp: McpSettings;
	forceMemoryRecall: ForceMemoryRecallSettings;
}

const DEFAULTS: Omit<AutosaveSettings, "model"> = {
	interval: 15,
	mode: "silent",
	userWing: undefined,
	agentName: "pi",
	diaryWing: "diaries",
	dailyMine: {
		enabled: false,
		wing: "pi",
		limit: 100,
	},
	// Unlike dailyMine, enabled by default: startup wake-up injection is
	// considered low-risk (read-only, best-effort, silent on failure).
	// mode defaults to "sync": guaranteeing a personalized first response is
	// preferred over shaving off a couple seconds of first-response latency.
	injectWakeUp: {
		enabled: true,
		mode: "sync",
		source: "user",
	},
	mcp: {
		full: { enabled: false },
	},
	// Same low-risk rationale as injectWakeUp: read-only, best-effort, and
	// silently a no-op when there's no digest to callback to. "sometimes" is
	// the default level — generous but never forced (see the type above).
	forceMemoryRecall: {
		enabled: true,
		level: "sometimes",
	},
};

interface RawSettingsShape {
	piPalace?: Partial<{
		interval: number;
		mode: CheckpointMode;
		userWing: string;
		agentName: string;
		diaryWing: string;
		dailyMine: Partial<DailyMineSettings>;
		model: Partial<ModelSettings>;
		injectWakeUp: Partial<InjectWakeUpSettings> & { source?: InjectWakeUpSource };
		mcp: Partial<{ full: Partial<{ enabled: boolean }> }>;
		forceMemoryRecall: Partial<ForceMemoryRecallSettings>;
	}>;
}

async function readJsonSafe(path: string): Promise<RawSettingsShape | undefined> {
	try {
		const text = await readFile(path, "utf8");
		return JSON.parse(text) as RawSettingsShape;
	} catch {
		return undefined;
	}
}

/**
 * Reads the `piPalace` namespace from global + project settings.json,
 * merging project over global (matching pi's own settings precedence).
 * There is no documented ExtensionContext API for arbitrary custom settings
 * namespaces, so we read the files directly — same approach other extensions
 * (e.g. piJj) rely on via their own top-level settings key.
 */
export async function loadAutosaveSettings(cwd: string): Promise<AutosaveSettings> {
	const globalPath = join(homedir(), ".pi", "agent", "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");

	const [globalRaw, projectRaw] = await Promise.all([readJsonSafe(globalPath), readJsonSafe(projectPath)]);

	const merged = {
		...DEFAULTS,
		...globalRaw?.piPalace,
		...projectRaw?.piPalace,
	};

	const interval = Number.isFinite(merged.interval) && merged.interval > 0 ? Math.floor(merged.interval) : DEFAULTS.interval;
	const mode: CheckpointMode = merged.mode === "blocking" ? "blocking" : "silent";
	const userWing = typeof merged.userWing === "string" && merged.userWing.trim() ? merged.userWing.trim() : undefined;
	const agentName = typeof merged.agentName === "string" && merged.agentName.trim() ? merged.agentName.trim() : DEFAULTS.agentName;
	const diaryWing = typeof merged.diaryWing === "string" && merged.diaryWing.trim() ? merged.diaryWing.trim() : DEFAULTS.diaryWing;

	const rawDailyMine = {
		...DEFAULTS.dailyMine,
		...globalRaw?.piPalace?.dailyMine,
		...projectRaw?.piPalace?.dailyMine,
	};
	const dailyMine: DailyMineSettings = {
		enabled: rawDailyMine.enabled === true,
		wing: typeof rawDailyMine.wing === "string" && rawDailyMine.wing.trim() ? rawDailyMine.wing.trim() : DEFAULTS.dailyMine.wing,
		limit: Number.isFinite(rawDailyMine.limit) && (rawDailyMine.limit as number) >= 0 ? Math.floor(rawDailyMine.limit as number) : DEFAULTS.dailyMine.limit,
	};

	const rawModel = projectRaw?.piPalace?.model ?? globalRaw?.piPalace?.model;
	const model: ModelSettings | undefined =
		rawModel && typeof rawModel.provider === "string" && rawModel.provider.trim() && typeof rawModel.id === "string" && rawModel.id.trim()
			? { provider: rawModel.provider.trim(), id: rawModel.id.trim() }
			: undefined;

	const rawInjectWakeUp = {
		...DEFAULTS.injectWakeUp,
		...globalRaw?.piPalace?.injectWakeUp,
		...projectRaw?.piPalace?.injectWakeUp,
	};
	// `source` accepts an explicit `null` (a valid, distinct value meaning
	// "no wing at all") — only fall back to the "user" default when the key
	// is truly absent or set to something unrecognized, never collapse an
	// explicit null into the default via `??`.
	const hasSource = Object.prototype.hasOwnProperty.call(rawInjectWakeUp, "source");
	const rawSource = rawInjectWakeUp.source;
	const source: InjectWakeUpSource =
		!hasSource || (rawSource !== "user" && rawSource !== "project" && rawSource !== "custom" && rawSource !== null) ? DEFAULTS.injectWakeUp.source : rawSource;
	const wing = typeof rawInjectWakeUp.wing === "string" && rawInjectWakeUp.wing.trim() ? rawInjectWakeUp.wing.trim() : undefined;
	const injectWakeUp: InjectWakeUpSettings = {
		enabled: rawInjectWakeUp.enabled !== false, // default true unless explicitly disabled
		mode: rawInjectWakeUp.mode === "async" ? "async" : "sync",
		source,
		wing,
	};

	const rawMcpFull = {
		...DEFAULTS.mcp.full,
		...globalRaw?.piPalace?.mcp?.full,
		...projectRaw?.piPalace?.mcp?.full,
	};
	const mcp: McpSettings = {
		full: { enabled: rawMcpFull.enabled === true },
	};

	const rawForceMemoryRecall = {
		...DEFAULTS.forceMemoryRecall,
		...globalRaw?.piPalace?.forceMemoryRecall,
		...projectRaw?.piPalace?.forceMemoryRecall,
	};
	const forceMemoryRecall: ForceMemoryRecallSettings = {
		enabled: rawForceMemoryRecall.enabled !== false, // default true unless explicitly disabled
		level: rawForceMemoryRecall.level === "always" ? "always" : "sometimes",
	};

	return { interval, mode, userWing, agentName, diaryWing, dailyMine, model, injectWakeUp, mcp, forceMemoryRecall };
}
