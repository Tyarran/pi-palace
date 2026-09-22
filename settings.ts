import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type CheckpointMode = "silent" | "blocking";

export interface DailyMineSettings {
	enabled: boolean;
	wing: string;
}

export interface ModelSettings {
	provider: string;
	id: string;
}

export interface InjectUserProfileSettings {
	enabled: boolean;
}

export interface AutosaveSettings {
	interval: number;
	mode: CheckpointMode;
	userWing: string | undefined;
	dailyMine: DailyMineSettings;
	// No default on purpose: absence means checkpoint features are disabled
	// (see index.ts) rather than silently falling back to a hardcoded model.
	model: ModelSettings | undefined;
	injectUserProfile: InjectUserProfileSettings;
}

const DEFAULTS: Omit<AutosaveSettings, "model"> = {
	interval: 15,
	mode: "silent",
	userWing: undefined,
	dailyMine: {
		enabled: false,
		wing: "pi",
	},
	// Unlike dailyMine, enabled by default: startup profile injection is
	// considered low-risk (read-only, best-effort, silent on failure).
	injectUserProfile: {
		enabled: true,
	},
};

interface RawSettingsShape {
	mempalaceAutosave?: Partial<{
		interval: number;
		mode: CheckpointMode;
		userWing: string;
		dailyMine: Partial<DailyMineSettings>;
		model: Partial<ModelSettings>;
		injectUserProfile: Partial<InjectUserProfileSettings>;
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
 * Reads the `mempalaceAutosave` namespace from global + project settings.json,
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
		...globalRaw?.mempalaceAutosave,
		...projectRaw?.mempalaceAutosave,
	};

	const interval = Number.isFinite(merged.interval) && merged.interval > 0 ? Math.floor(merged.interval) : DEFAULTS.interval;
	const mode: CheckpointMode = merged.mode === "blocking" ? "blocking" : "silent";
	const userWing = typeof merged.userWing === "string" && merged.userWing.trim() ? merged.userWing.trim() : undefined;

	const rawDailyMine = {
		...DEFAULTS.dailyMine,
		...globalRaw?.mempalaceAutosave?.dailyMine,
		...projectRaw?.mempalaceAutosave?.dailyMine,
	};
	const dailyMine: DailyMineSettings = {
		enabled: rawDailyMine.enabled === true,
		wing: typeof rawDailyMine.wing === "string" && rawDailyMine.wing.trim() ? rawDailyMine.wing.trim() : DEFAULTS.dailyMine.wing,
	};

	const rawModel = projectRaw?.mempalaceAutosave?.model ?? globalRaw?.mempalaceAutosave?.model;
	const model: ModelSettings | undefined =
		rawModel && typeof rawModel.provider === "string" && rawModel.provider.trim() && typeof rawModel.id === "string" && rawModel.id.trim()
			? { provider: rawModel.provider.trim(), id: rawModel.id.trim() }
			: undefined;

	const rawInjectUserProfile = {
		...DEFAULTS.injectUserProfile,
		...globalRaw?.mempalaceAutosave?.injectUserProfile,
		...projectRaw?.mempalaceAutosave?.injectUserProfile,
	};
	const injectUserProfile: InjectUserProfileSettings = {
		enabled: rawInjectUserProfile.enabled !== false, // default true unless explicitly disabled
	};

	return { interval, mode, userWing, dailyMine, model, injectUserProfile };
}
