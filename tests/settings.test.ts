import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAutosaveSettings } from "../src/settings.js";

// loadAutosaveSettings reads both a "global" settings.json and a "project"
// one (under cwd/.pi/). The global path is passed explicitly here (its
// optional second parameter) rather than pointing $HOME at a temp dir:
// os.homedir() does not re-read $HOME dynamically mid-process under Bun
// (unlike Node), so mutating process.env.HOME per-test does not actually
// isolate loadAutosaveSettings from this machine's real
// ~/.pi/agent/settings.json — verified the hard way (this file's
// "defaults to stdio" test silently read the real global config until this
// was fixed).
let homeDir: string;
let projectDir: string;
let globalSettingsPath: string;

beforeEach(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "pi-palace-settings-home-"));
	projectDir = await mkdtemp(join(tmpdir(), "pi-palace-settings-project-"));
	globalSettingsPath = join(homeDir, "settings.json"); // deliberately never created unless a test needs it
});

afterEach(async () => {
	await rm(homeDir, { recursive: true, force: true });
	await rm(projectDir, { recursive: true, force: true });
});

async function loadSettings(): Promise<Awaited<ReturnType<typeof loadAutosaveSettings>>> {
	return loadAutosaveSettings(projectDir, globalSettingsPath);
}

async function writeProjectSettings(piPalace: Record<string, unknown>): Promise<void> {
	const dir = join(projectDir, ".pi");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "settings.json"), JSON.stringify({ piPalace }), "utf8");
}

describe("loadAutosaveSettings — mcp.transport / mcp.http", () => {
	test("defaults to stdio transport and the documented default host/port", async () => {
		const settings = await loadSettings();
		expect(settings.mcp.transport).toBe("stdio");
		expect(settings.mcp.http).toEqual({ host: "127.0.0.1", port: 8765 });
	});

	test("accepts an explicit http transport", async () => {
		await writeProjectSettings({ mcp: { transport: "http" } });
		const settings = await loadSettings();
		expect(settings.mcp.transport).toBe("http");
	});

	test("falls back to stdio for an unrecognized transport value", async () => {
		await writeProjectSettings({ mcp: { transport: "carrier-pigeon" } });
		const settings = await loadSettings();
		expect(settings.mcp.transport).toBe("stdio");
	});

	test("accepts a partial http override (host only, port keeps its default)", async () => {
		await writeProjectSettings({ mcp: { http: { host: "0.0.0.0" } } });
		const settings = await loadSettings();
		expect(settings.mcp.http).toEqual({ host: "0.0.0.0", port: 8765 });
	});

	test("rejects a non-positive port and falls back to the default", async () => {
		await writeProjectSettings({ mcp: { http: { port: -1 } } });
		const settings = await loadSettings();
		expect(settings.mcp.http.port).toBe(8765);
	});
});

describe("loadAutosaveSettings — mcp.light.enabled", () => {
	test("defaults to enabled", async () => {
		const settings = await loadSettings();
		expect(settings.mcp.light.enabled).toBe(true);
	});

	test("accepts explicit disabling", async () => {
		await writeProjectSettings({ mcp: { light: { enabled: false } } });
		const settings = await loadSettings();
		expect(settings.mcp.light.enabled).toBe(false);
	});

	test("full stays independently configurable when light is disabled", async () => {
		await writeProjectSettings({ mcp: { light: { enabled: false }, full: { enabled: true } } });
		const settings = await loadSettings();
		expect(settings.mcp.light.enabled).toBe(false);
		expect(settings.mcp.full.enabled).toBe(true);
	});
});

describe("loadAutosaveSettings — writeRouting", () => {
	test("defaults both cli and hooks policy to require", async () => {
		const settings = await loadSettings();
		expect(settings.writeRouting).toEqual({ cli: "require", hooks: "require" });
	});

	test("accepts explicit direct/prefer overrides per key", async () => {
		await writeProjectSettings({ writeRouting: { cli: "prefer", hooks: "direct" } });
		const settings = await loadSettings();
		expect(settings.writeRouting).toEqual({ cli: "prefer", hooks: "direct" });
	});

	test("falls back to require for an invalid policy value", async () => {
		await writeProjectSettings({ writeRouting: { cli: "sometimes" } });
		const settings = await loadSettings();
		expect(settings.writeRouting.cli).toBe("require");
	});
});

describe("loadAutosaveSettings — mcp.connection", () => {
	test("defaults to per-call", async () => {
		const settings = await loadSettings();
		expect(settings.mcp.connection).toBe("per-call");
	});

	test("accepts an explicit persistent connection", async () => {
		await writeProjectSettings({ mcp: { connection: "persistent" } });
		const settings = await loadSettings();
		expect(settings.mcp.connection).toBe("persistent");
	});

	test("falls back to per-call for unrecognized values", async () => {
		for (const bad of ["carrier-pigeon", 42, null]) {
			await writeProjectSettings({ mcp: { connection: bad } });
			const settings = await loadSettings();
			expect(settings.mcp.connection).toBe("per-call");
		}
	});

	test("project setting wins over the global one", async () => {
		await writeFile(globalSettingsPath, JSON.stringify({ piPalace: { mcp: { connection: "persistent" } } }), "utf8");
		expect((await loadSettings()).mcp.connection).toBe("persistent");
		await writeProjectSettings({ mcp: { connection: "per-call" } });
		expect((await loadSettings()).mcp.connection).toBe("per-call");
	});
});
