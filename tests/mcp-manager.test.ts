import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { initMcpManager, isReadOnlyCoordinateCall, isReadOnlyTool, type ReadCapableClient, readDiaryVia } from "../src/mcp-manager.js";
import type { AutosaveSettings, McpConnection } from "../src/settings.js";
import { type FakeMcp, installFakeMcp, isAlive, waitForExit } from "./helpers/fake-mcp-server.js";

function fakeClient(response: unknown): ReadCapableClient {
	return {
		listTools: async () => [],
		callTool: async () => response as never,
	};
}

describe("isReadOnlyTool", () => {
	test("classifies the mempalace-light unified query tool as read-only", () => {
		// Regression: palace_query is the only mempalace-light tool name that
		// isn't in the mempalace-full 45-tool list this Set was originally
		// built from — omitting it silently daemon-routed every read.
		expect(isReadOnlyTool("palace_query")).toBe(true);
	});

	test("classifies known mempalace-full read tools as read-only", () => {
		expect(isReadOnlyTool("mempalace_search")).toBe(true);
		expect(isReadOnlyTool("mempalace_status")).toBe(true);
	});

	test("does not classify palace_exec as read-only (always a write)", () => {
		expect(isReadOnlyTool("palace_exec")).toBe(false);
	});

	test("does not classify palace_coordinate as read-only by name alone", () => {
		// palace_coordinate is mixed read/write — isReadOnlyTool (name-only)
		// must never green-light it; isReadOnlyCoordinateCall handles it
		// instead, based on the call's actual action/command.
		expect(isReadOnlyTool("palace_coordinate")).toBe(false);
	});

	test("fail-safe: unknown tool names are treated as writes", () => {
		expect(isReadOnlyTool("mempalace_some_future_tool")).toBe(false);
	});
});

describe("isReadOnlyCoordinateCall", () => {
	test("action field: recognizes read actions", () => {
		expect(isReadOnlyCoordinateCall({ action: "event_list" })).toBe(true);
		expect(isReadOnlyCoordinateCall({ action: "event_wait" })).toBe(true);
		expect(isReadOnlyCoordinateCall({ action: "mesh_peers" })).toBe(true);
		expect(isReadOnlyCoordinateCall({ action: "artifact_get" })).toBe(true);
		expect(isReadOnlyCoordinateCall({ action: "inbox" })).toBe(true);
	});

	test("action field: is case-insensitive", () => {
		expect(isReadOnlyCoordinateCall({ action: "EVENT_LIST" })).toBe(true);
	});

	test("action field: recognizes write actions as non-read-only", () => {
		expect(isReadOnlyCoordinateCall({ action: "task_create" })).toBe(false);
		expect(isReadOnlyCoordinateCall({ action: "event_append" })).toBe(false);
		expect(isReadOnlyCoordinateCall({ action: "event_ack" })).toBe(false);
		expect(isReadOnlyCoordinateCall({ action: "artifact_put" })).toBe(false);
		expect(isReadOnlyCoordinateCall({ action: "patch_submit" })).toBe(false);
	});

	test("command DSL: recognizes read commands", () => {
		expect(isReadOnlyCoordinateCall({ command: "EVENT LIST stream:project/x LIMIT 5" })).toBe(true);
		expect(isReadOnlyCoordinateCall({ command: "event wait correlation:task_1" })).toBe(true);
		expect(isReadOnlyCoordinateCall({ command: "EVENT INBOX to:agent" })).toBe(true);
		expect(isReadOnlyCoordinateCall({ command: "MESH PEERS" })).toBe(true);
		expect(isReadOnlyCoordinateCall({ command: "ARTIFACT GET id:art_1" })).toBe(true);
	});

	test("command DSL: recognizes write commands as non-read-only", () => {
		expect(isReadOnlyCoordinateCall({ command: 'TASK CREATE project:x from:a to:b goal:"g" branch:b base:c done:"d"' })).toBe(
			false,
		);
		expect(isReadOnlyCoordinateCall({ command: "EVENT APPEND type:task.request" })).toBe(false);
		expect(isReadOnlyCoordinateCall({ command: "EVENT ACK id:evt_1 from:a status:applied" })).toBe(false);
		expect(isReadOnlyCoordinateCall({ command: "PATCH SUBMIT ..." })).toBe(false);
	});

	test("fail-safe: missing/malformed action and command are treated as writes", () => {
		expect(isReadOnlyCoordinateCall({})).toBe(false);
		expect(isReadOnlyCoordinateCall({ action: 123 })).toBe(false);
		expect(isReadOnlyCoordinateCall({ command: 456 })).toBe(false);
	});
});

describe("readDiaryVia", () => {
	test("prefers light when available, calling palace_query with target diary_read", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const light: ReadCapableClient = {
			listTools: async () => [],
			callTool: async (name, args) => {
				calls.push({ name, args });
				return { content: [{ type: "text", text: "from light" }] };
			},
		};
		const full = fakeClient({ content: [{ type: "text", text: "from full" }] });

		const result = await readDiaryVia(light, full, "pi", 5);

		expect(calls).toEqual([{ name: "palace_query", args: { target: "diary_read", agent_name: "pi", last_n: 5 } }]);
		expect(result.content?.[0]?.text).toBe("from light");
	});

	test("falls back to full's mempalace_diary_read when light is null", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const full: ReadCapableClient = {
			listTools: async () => [],
			callTool: async (name, args) => {
				calls.push({ name, args });
				return { content: [{ type: "text", text: "from full" }] };
			},
		};

		const result = await readDiaryVia(null, full, "pi", 5);

		expect(calls).toEqual([{ name: "mempalace_diary_read", args: { agent_name: "pi", last_n: 5 } }]);
		expect(result.content?.[0]?.text).toBe("from full");
	});

	test("throws when neither connection is available", async () => {
		await expect(readDiaryVia(null, null, "pi", 5)).rejects.toThrow(/no MemPalace MCP connection available/);
	});
});

describe("initMcpManager — mcp.connection", () => {
	let fake: FakeMcp;

	beforeEach(async () => {
		fake = await installFakeMcp();
	});

	afterEach(async () => {
		await fake.restore();
	});

	function makeSettings(connection: McpConnection, overrides: { full?: boolean; light?: boolean } = {}): AutosaveSettings {
		return {
			mcp: {
				light: { enabled: overrides.light ?? true },
				full: { enabled: overrides.full ?? false },
				transport: "stdio",
				connection,
				http: { host: "127.0.0.1", port: 8765 },
			},
		} as unknown as AutosaveSettings;
	}

	function fakePi() {
		const registered: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }> = [];
		const pi = { registerTool: (t: (typeof registered)[number]) => registered.push(t) } as unknown as ExtensionAPI;
		return { pi, registered };
	}

	test("per-call: discovers tools with one short-lived process, then spawns one per read", async () => {
		const { pi, registered } = fakePi();
		const manager = await initMcpManager(pi, makeSettings("per-call"));
		expect(manager.light).not.toBeNull();
		expect(registered.map((t) => t.name)).toEqual(["palace_query"]);
		expect(fake.spawnCount()).toBe(1);
		await waitForExit(fake.pids()[0]);

		await registered[0].execute("id", { target: "status" });
		expect(fake.spawnCount()).toBe(2);
		await waitForExit(fake.pids()[1]);
		expect(() => manager.close()).not.toThrow();
	});

	test("per-call: readDiary spawns one process", async () => {
		const { pi } = fakePi();
		const manager = await initMcpManager(pi, makeSettings("per-call"));
		await manager.readDiary("pi", 3);
		expect(fake.spawnCount()).toBe(2);
		manager.close();
	});

	test("persistent: one process for the whole session, killed on close()", async () => {
		const { pi, registered } = fakePi();
		const manager = await initMcpManager(pi, makeSettings("persistent"));
		expect(fake.spawnCount()).toBe(1);
		await registered[0].execute("id", {});
		await manager.readDiary("pi", 3);
		expect(fake.spawnCount()).toBe(1);
		expect(isAlive(fake.pids()[0])).toBe(true);
		manager.close();
		await waitForExit(fake.pids()[0]);
	});

	test("per-call with full over stdio: both servers are probed at init", async () => {
		const { pi } = fakePi();
		const manager = await initMcpManager(pi, makeSettings("per-call", { full: true }));
		expect(fake.spawnCount()).toBe(2);
		expect(manager.full).not.toBeNull();
		await Promise.all(fake.pids().map((pid) => waitForExit(pid)));
		manager.close();
	});

	test("per-call: a failing init degrades light to null without throwing or leaving processes", async () => {
		const { pi } = fakePi();
		process.env.FAKE_MCP_FAIL_CALL = "1"; // irrelevant to init; keep fake alive
		const savedPath = process.env.PATH;
		process.env.PATH = "/nonexistent-dir";
		try {
			const manager = await initMcpManager(pi, makeSettings("per-call"));
			expect(manager.light).toBeNull();
			manager.close();
		} finally {
			process.env.PATH = savedPath;
		}
		expect(fake.spawnCount()).toBe(0);
	});
});
