import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// hub-manager.ts calls the global `fetch` directly (no injectable HTTP
// client) — same lightweight mocking approach as fetching libraries: stub
// globalThis.fetch per test and restore it afterwards.
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	mock.restore();
});

describe("ensureHubRunning", () => {
	test("reuses an already-live hub answering our own token", async () => {
		globalThis.fetch = mock(async (url: string) => {
			if (url.endsWith("/healthz")) return new Response(null, { status: 200 });
			if (url.endsWith("/mcp")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), { status: 200 });
			throw new Error(`unexpected fetch: ${url}`);
		}) as unknown as typeof fetch;

		mock.module("../src/hub-token.js", () => ({ readOrCreateHubToken: async () => "our-token" }));
		const { ensureHubRunning } = await import("../src/hub-manager.js");

		const hub = await ensureHubRunning({ host: "127.0.0.1", port: 8765 });
		expect(hub).toEqual({ baseUrl: "http://127.0.0.1:8765", token: "our-token" });
	});

	test("throws HubTokenConflictError when a live hub rejects our token", async () => {
		globalThis.fetch = mock(async (url: string) => {
			if (url.endsWith("/healthz")) return new Response(null, { status: 200 });
			if (url.endsWith("/mcp")) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
			throw new Error(`unexpected fetch: ${url}`);
		}) as unknown as typeof fetch;

		mock.module("../src/hub-token.js", () => ({ readOrCreateHubToken: async () => "our-token" }));
		const { ensureHubRunning, HubTokenConflictError } = await import("../src/hub-manager.js");

		await expect(ensureHubRunning({ host: "127.0.0.1", port: 8765 })).rejects.toBeInstanceOf(HubTokenConflictError);
	});
});
