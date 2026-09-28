import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAutosaveSettings } from "../src/settings.js";

// loadAutosaveSettings reads both a "global" settings.json (under
// homedir()/.pi/agent/) and a "project" one (under cwd/.pi/). Pointing
// $HOME at a throwaway temp dir isolates these tests from whatever the
// machine running them actually has in ~/.pi/agent/settings.json — os.homedir()
// re-reads $HOME on every call on POSIX, so this takes effect immediately,
// no module reload needed.
let previousHome: string | undefined;
let homeDir: string;
let projectDir: string;

beforeEach(async () => {
	previousHome = process.env.HOME;
	homeDir = await mkdtemp(join(tmpdir(), "pi-palace-settings-home-"));
	projectDir = await mkdtemp(join(tmpdir(), "pi-palace-settings-project-"));
	process.env.HOME = homeDir;
});

afterEach(async () => {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	await rm(homeDir, { recursive: true, force: true });
	await rm(projectDir, { recursive: true, force: true });
});

async function writeProjectSettings(piPalace: Record<string, unknown>): Promise<void> {
	const dir = join(projectDir, ".pi");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "settings.json"), JSON.stringify({ piPalace }), "utf8");
}

describe("loadAutosaveSettings — mcp.transport / mcp.http", () => {
	test("defaults to stdio transport and the documented default host/port", async () => {
		const settings = await loadAutosaveSettings(projectDir);
		expect(settings.mcp.transport).toBe("stdio");
		expect(settings.mcp.http).toEqual({ host: "127.0.0.1", port: 8765 });
	});

	test("accepts an explicit http transport", async () => {
		await writeProjectSettings({ mcp: { transport: "http" } });
		const settings = await loadAutosaveSettings(projectDir);
		expect(settings.mcp.transport).toBe("http");
	});

	test("falls back to stdio for an unrecognized transport value", async () => {
		await writeProjectSettings({ mcp: { transport: "carrier-pigeon" } });
		const settings = await loadAutosaveSettings(projectDir);
		expect(settings.mcp.transport).toBe("stdio");
	});

	test("accepts a partial http override (host only, port keeps its default)", async () => {
		await writeProjectSettings({ mcp: { http: { host: "0.0.0.0" } } });
		const settings = await loadAutosaveSettings(projectDir);
		expect(settings.mcp.http).toEqual({ host: "0.0.0.0", port: 8765 });
	});

	test("rejects a non-positive port and falls back to the default", async () => {
		await writeProjectSettings({ mcp: { http: { port: -1 } } });
		const settings = await loadAutosaveSettings(projectDir);
		expect(settings.mcp.http.port).toBe(8765);
	});
});

describe("loadAutosaveSettings — writeRouting", () => {
	test("defaults both cli and hooks policy to require", async () => {
		const settings = await loadAutosaveSettings(projectDir);
		expect(settings.writeRouting).toEqual({ cli: "require", hooks: "require" });
	});

	test("accepts explicit direct/prefer overrides per key", async () => {
		await writeProjectSettings({ writeRouting: { cli: "prefer", hooks: "direct" } });
		const settings = await loadAutosaveSettings(projectDir);
		expect(settings.writeRouting).toEqual({ cli: "prefer", hooks: "direct" });
	});

	test("falls back to require for an invalid policy value", async () => {
		await writeProjectSettings({ writeRouting: { cli: "sometimes" } });
		const settings = await loadAutosaveSettings(projectDir);
		expect(settings.writeRouting.cli).toBe("require");
	});
});
