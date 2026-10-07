import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPerCallMcpClient } from "../src/per-call-mcp-client.js";
import { type FakeMcp, installFakeMcp, waitForExit } from "./helpers/fake-mcp-server.js";

let fake: FakeMcp;

beforeEach(async () => {
	fake = await installFakeMcp();
});

afterEach(async () => {
	await fake.restore();
});

const CMD = "mempalace-light-mcp";

describe("createPerCallMcpClient", () => {
	test("listTools spawns one process and closes it afterwards", async () => {
		const client = createPerCallMcpClient(CMD);
		const tools = await client.listTools();
		expect(tools.map((t) => t.name)).toEqual(["palace_query"]);
		expect(fake.spawnCount()).toBe(1);
		await waitForExit(fake.pids()[0]);
	});

	test("each sequential callTool spawns its own process", async () => {
		const client = createPerCallMcpClient(CMD);
		for (let i = 0; i < 3; i++) {
			const res = await client.callTool("palace_query", { n: i });
			expect(res.content?.[0]?.text).toBe(JSON.stringify({ n: i }));
		}
		expect(fake.spawnCount()).toBe(3);
		await Promise.all(fake.pids().map((pid) => waitForExit(pid)));
	});

	test("parallel callTools each spawn a process (not serialized)", async () => {
		const client = createPerCallMcpClient(CMD);
		const results = await Promise.all([1, 2, 3].map((n) => client.callTool("palace_query", { n })));
		expect(results.map((r) => r.content?.[0]?.text)).toEqual([1, 2, 3].map((n) => JSON.stringify({ n })));
		expect(fake.spawnCount()).toBe(3);
		await Promise.all(fake.pids().map((pid) => waitForExit(pid)));
	});

	test("a JSON-RPC error rejects with the tool name and still closes the process", async () => {
		process.env.FAKE_MCP_FAIL_CALL = "1";
		const client = createPerCallMcpClient(CMD);
		await expect(client.callTool("palace_query", {})).rejects.toThrow("MCP tools/call(palace_query) failed: boom");
		await waitForExit(fake.pids()[0]);
	});

	test("a missing binary rejects with a start failure instead of hanging", async () => {
		const client = createPerCallMcpClient("pi-palace-no-such-binary");
		await expect(client.listTools()).rejects.toThrow("MCP server process failed to start");
		await expect(client.callTool("palace_query", {})).rejects.toThrow("MCP server process failed to start");
	});

	test("a hung server is abandoned on timeout and its process is killed", async () => {
		process.env.FAKE_MCP_HANG = "1";
		const client = createPerCallMcpClient(CMD, 200);
		await expect(client.callTool("palace_query", {})).rejects.toThrow("timed out after 200ms");
		await waitForExit(fake.pids()[0]);
	});

	test("close() rejects in-flight calls and kills their processes", async () => {
		process.env.FAKE_MCP_HANG = "1";
		const client = createPerCallMcpClient(CMD);
		const calls = [1, 2].map((n) => client.callTool("palace_query", { n }));
		const settled = Promise.allSettled(calls);
		while (fake.spawnCount() < 2) await new Promise((r) => setTimeout(r, 5));
		client.close();
		const results = await settled;
		expect(results.every((r) => r.status === "rejected")).toBe(true);
		await Promise.all(fake.pids().map((pid) => waitForExit(pid)));
	});
});
