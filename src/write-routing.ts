/**
 * Ensures MemPalace's own write_routing.cli / write_routing.hooks policy
 * (docs/write-routing-policy.md) is set to a safe value, so an external
 * `mempalace mine` (a manual run, another tool's hook) — anything NOT
 * routed through pi-palace's own daemon/hub plumbing — never races the
 * palace write lock instead of queuing behind it. See mcp-manager.ts /
 * hub-manager.ts for the (unrelated) MCP transport this pairs with.
 *
 * Best-effort, non-destructive: only fills in keys that are missing —
 * never overwrites a value the user (or another tool) already set
 * explicitly in ~/.mempalace/config.json.
 *
 * Mirrors mempalace/config.py's own XDG resolution order for the config
 * directory (see `_default_config_dir` there) so this reads/writes the
 * exact same file `mempalace` itself would.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WriteRoutingSettings } from "./settings.js";

async function isFile(path: string): Promise<boolean> {
	try {
		const { stat } = await import("node:fs/promises");
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

const LEGACY_MARKERS = ["config.json", "people_map.json"];

async function hasLegacyInstall(legacyDir: string): Promise<boolean> {
	for (const marker of LEGACY_MARKERS) {
		if (await isFile(join(legacyDir, marker))) return true;
	}
	return isFile(join(legacyDir, "palace", "chroma.sqlite3"));
}

/** Mirrors config.py's `_default_config_dir()` resolution order exactly. */
export async function resolveMempalaceConfigDir(): Promise<string> {
	const envDir = process.env.MEMPALACE_CONFIG_DIR?.trim();
	if (envDir) return envDir;

	const legacy = join(homedir(), ".mempalace");
	if (await hasLegacyInstall(legacy)) return legacy;

	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	if (xdg && xdg.startsWith("/")) return join(xdg, "mempalace");

	return join(homedir(), ".config", "mempalace");
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * Merges `writeRouting.cli`/`writeRouting.hooks` into MemPalace's
 * `write_routing.cli`/`write_routing.hooks` config keys, without
 * overwriting either key if it's already present (any value, not just a
 * recognized policy — an explicit choice, even a stale/invalid one, is
 * left alone rather than silently corrected). Best-effort: never throws,
 * a failure here must not block session_start.
 */
export async function ensureWriteRoutingPolicy(writeRouting: WriteRoutingSettings): Promise<void> {
	try {
		const configDir = await resolveMempalaceConfigDir();
		const configPath = join(configDir, "config.json");
		const config = await readJsonObject(configPath);

		const existing = (config.write_routing && typeof config.write_routing === "object" ? config.write_routing : {}) as Record<string, unknown>;
		const hasCli = Object.prototype.hasOwnProperty.call(existing, "cli");
		const hasHooks = Object.prototype.hasOwnProperty.call(existing, "hooks");
		if (hasCli && hasHooks) return; // nothing to do — both already set explicitly

		const merged = {
			...existing,
			...(hasCli ? {} : { cli: writeRouting.cli }),
			...(hasHooks ? {} : { hooks: writeRouting.hooks }),
		};

		await mkdir(configDir, { recursive: true });
		await writeFile(configPath, JSON.stringify({ ...config, write_routing: merged }, null, 2), "utf8");
	} catch {
		// Best-effort — never let a config write failure affect session_start.
	}
}
