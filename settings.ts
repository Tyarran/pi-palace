import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type CheckpointMode = "silent" | "blocking";
export type InjectWakeUpMode = "sync" | "async";

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
}

export interface McpSettings {
	// light has no toggle — always connected, it's the mandatory baseline.
	full: { enabled: boolean };
}

export interface AutosaveSettings {
	interval: number;
	mode: CheckpointMode;
	userWing: string | undefined;
	dailyMine: DailyMineSettings;
	// No default on purpose: absence means checkpoint features are disabled
	// (see index.ts) rather than silently falling back to a hardcoded model.
	model: ModelSettings | undefined;
	injectWakeUp: InjectWakeUpSettings;
	mcp: McpSettings;
}

const DEFAULTS: Omit<AutosaveSettings, "model"> = {
	interval: 15,
	mode: "silent",
	userWing: undefined,
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
	},
	mcp: {
		full: { enabled: false },
	},
};

interface RawSettingsShape {
	piPalace?: Partial<{
		interval: number;
		mode: CheckpointMode;
		userWing: string;
		dailyMine: Partial<DailyMineSettings>;
		model: Partial<ModelSettings>;
		injectWakeUp: Partial<InjectWakeUpSettings>;
		mcp: Partial<{ full: Partial<{ enabled: boolean }> }>;
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
	const injectWakeUp: InjectWakeUpSettings = {
		enabled: rawInjectWakeUp.enabled !== false, // default true unless explicitly disabled
		mode: rawInjectWakeUp.mode === "async" ? "async" : "sync",
	};

	const rawMcpFull = {
		...DEFAULTS.mcp.full,
		...globalRaw?.piPalace?.mcp?.full,
		...projectRaw?.piPalace?.mcp?.full,
	};
	const mcp: McpSettings = {
		full: { enabled: rawMcpFull.enabled === true },
	};

	return { interval, mode, userWing, dailyMine, model, injectWakeUp, mcp };
}
