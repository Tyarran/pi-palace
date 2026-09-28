import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWriteRoutingPolicy, resolveMempalaceConfigDir } from "../src/write-routing.js";

let configDir: string;
let previousEnvVar: string | undefined;

beforeEach(async () => {
	configDir = await mkdtemp(join(tmpdir(), "pi-palace-mempalace-config-"));
	previousEnvVar = process.env.MEMPALACE_CONFIG_DIR;
	// resolveMempalaceConfigDir's first precedence rule — the simplest way to
	// pin the resolved directory without touching $HOME/XDG_CONFIG_HOME, which
	// the legacy/XDG fallback branches already cover in their own right.
	process.env.MEMPALACE_CONFIG_DIR = configDir;
});

afterEach(async () => {
	if (previousEnvVar === undefined) delete process.env.MEMPALACE_CONFIG_DIR;
	else process.env.MEMPALACE_CONFIG_DIR = previousEnvVar;
	await rm(configDir, { recursive: true, force: true });
});

describe("resolveMempalaceConfigDir", () => {
	test("honors MEMPALACE_CONFIG_DIR when set", async () => {
		expect(await resolveMempalaceConfigDir()).toBe(configDir);
	});
});

describe("ensureWriteRoutingPolicy", () => {
	test("creates config.json with both policies when none exists yet", async () => {
		await ensureWriteRoutingPolicy({ cli: "require", hooks: "require" });
		const written = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
		expect(written.write_routing).toEqual({ cli: "require", hooks: "require" });
	});

	test("fills in only the missing key, leaving an existing explicit value untouched", async () => {
		await writeFile(join(configDir, "config.json"), JSON.stringify({ write_routing: { cli: "direct" } }), "utf8");
		await ensureWriteRoutingPolicy({ cli: "require", hooks: "require" });
		const written = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
		expect(written.write_routing).toEqual({ cli: "direct", hooks: "require" });
	});

	test("does nothing when both keys are already explicitly set", async () => {
		await writeFile(join(configDir, "config.json"), JSON.stringify({ write_routing: { cli: "direct", hooks: "prefer" }, backend: "chroma" }), "utf8");
		await ensureWriteRoutingPolicy({ cli: "require", hooks: "require" });
		const written = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
		expect(written).toEqual({ write_routing: { cli: "direct", hooks: "prefer" }, backend: "chroma" });
	});

	test("preserves unrelated existing config keys", async () => {
		await writeFile(join(configDir, "config.json"), JSON.stringify({ backend: "chroma", embedding_model: "embeddinggemma" }), "utf8");
		await ensureWriteRoutingPolicy({ cli: "require", hooks: "require" });
		const written = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
		expect(written.backend).toBe("chroma");
		expect(written.embedding_model).toBe("embeddinggemma");
		expect(written.write_routing).toEqual({ cli: "require", hooks: "require" });
	});

	test("is a silent no-op when the config dir cannot be created (best-effort)", async () => {
		// Point at a path whose parent is a file, not a directory — mkdir(recursive) fails.
		const blockerFile = join(configDir, "not-a-dir");
		await writeFile(blockerFile, "x", "utf8");
		process.env.MEMPALACE_CONFIG_DIR = join(blockerFile, "nested");
		await expect(ensureWriteRoutingPolicy({ cli: "require", hooks: "require" })).resolves.toBeUndefined();
	});
});
