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

export type McpTransport = "stdio" | "http";

export interface McpHttpSettings {
	// Loopback-only by convention (the hub is a local, pi-palace-managed
	// process, never meant to be exposed off-machine — see hub-manager.ts).
	host: string;
	port: number;
}

export interface McpSettings {
	// Both light and full are individually toggleable, but never both
	// disabled at once — index.ts enforces at least one stays enabled
	// (fail-safe: a session must never end up with zero MemPalace tools
	// registered). light defaults to enabled (backward-compatible with the
	// pre-toggle behavior, where it had no off switch at all).
	light: { enabled: boolean };
	full: { enabled: boolean };
	// "stdio" (default): spawn mempalace-mcp/mempalace-light-mcp per session,
	// exactly as before this setting existed. "http": reads (and tools/list
	// discovery) go through a shared read-only HTTP hub instead — see
	// hub-manager.ts. Writes are ALWAYS routed through the daemon
	// (submitMcpToolJobWaiting) regardless of this setting — this only
	// changes the read path.
	transport: McpTransport;
	http: McpHttpSettings;
}

export type WriteRoutingPolicy = "direct" | "prefer" | "require";

export interface WriteRoutingSettings {
	// Mirrors MemPalace's own write_routing.cli / write_routing.hooks policy
	// (docs/write-routing-policy.md) — pi-palace writes these into
	// ~/.mempalace/config.json (merged, never overwriting an existing value)
	// so an external `mempalace mine` (manual run, another tool's hook) never
	// races the hub/daemon for the palace write lock: with "require", it
	// either queues behind the daemon or is refused outright — never a
	// direct write that could collide (see write-routing.ts).
	cli: WriteRoutingPolicy;
	hooks: WriteRoutingPolicy;
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
	writeRouting: WriteRoutingSettings;
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
		light: { enabled: true },
		full: { enabled: false },
		transport: "stdio",
		http: { host: "127.0.0.1", port: 8765 },
	},
	// "require" for both: never let an external `mempalace mine` (manual run,
	// another tool's hook) race the hub/daemon for the palace write lock —
	// see write-routing.ts and the McpSettings/WriteRoutingSettings doc
	// comments above.
	writeRouting: {
		cli: "require",
		hooks: "require",
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
		mcp: Partial<{ light: Partial<{ enabled: boolean }>; full: Partial<{ enabled: boolean }>; transport: McpTransport; http: Partial<McpHttpSettings> }>;
		writeRouting: Partial<WriteRoutingSettings>;
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
export async function loadAutosaveSettings(
	cwd: string,
	// Overridable for tests: os.homedir() does not re-read $HOME dynamically
	// mid-process under Bun (unlike Node), so pointing tests at a throwaway
	// $HOME does not isolate them from this machine's real global
	// settings.json. Passing an explicit path sidesteps that entirely rather
	// than fighting module-cache/mocking ordering across test files. Real
	// callers (index.ts) never pass this, so behavior is unchanged for them.
	globalPath: string = join(homedir(), ".pi", "agent", "settings.json"),
): Promise<AutosaveSettings> {
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

	const rawMcpLight = {
		...DEFAULTS.mcp.light,
		...globalRaw?.piPalace?.mcp?.light,
		...projectRaw?.piPalace?.mcp?.light,
	};
	const rawMcpFull = {
		...DEFAULTS.mcp.full,
		...globalRaw?.piPalace?.mcp?.full,
		...projectRaw?.piPalace?.mcp?.full,
	};
	const rawMcpTransport = projectRaw?.piPalace?.mcp?.transport ?? globalRaw?.piPalace?.mcp?.transport;
	const transport: McpTransport = rawMcpTransport === "http" ? "http" : "stdio";
	const rawMcpHttp = {
		...DEFAULTS.mcp.http,
		...globalRaw?.piPalace?.mcp?.http,
		...projectRaw?.piPalace?.mcp?.http,
	};
	const http: McpHttpSettings = {
		host: typeof rawMcpHttp.host === "string" && rawMcpHttp.host.trim() ? rawMcpHttp.host.trim() : DEFAULTS.mcp.http.host,
		port: Number.isFinite(rawMcpHttp.port) && (rawMcpHttp.port as number) > 0 ? Math.floor(rawMcpHttp.port as number) : DEFAULTS.mcp.http.port,
	};
	const mcp: McpSettings = {
		// Not enforced here ("at least one enabled") \u2014 that fail-safe lives in
		// index.ts's session_start, alongside its user-facing warning toast,
		// matching how other cross-field guards (model/userWing) are handled in
		// this codebase rather than inside loadAutosaveSettings itself.
		light: { enabled: rawMcpLight.enabled !== false }, // default true unless explicitly disabled
		full: { enabled: rawMcpFull.enabled === true },
		transport,
		http,
	};

	const rawWriteRouting = {
		...DEFAULTS.writeRouting,
		...globalRaw?.piPalace?.writeRouting,
		...projectRaw?.piPalace?.writeRouting,
	};
	const validPolicy = (value: unknown, fallback: WriteRoutingPolicy): WriteRoutingPolicy =>
		value === "direct" || value === "prefer" || value === "require" ? value : fallback;
	const writeRouting: WriteRoutingSettings = {
		cli: validPolicy(rawWriteRouting.cli, DEFAULTS.writeRouting.cli),
		hooks: validPolicy(rawWriteRouting.hooks, DEFAULTS.writeRouting.hooks),
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

	return { interval, mode, userWing, agentName, diaryWing, dailyMine, model, injectWakeUp, mcp, writeRouting, forceMemoryRecall };
}
