/**
 * Thin HTTP JSON-RPC client for the MemPalace HTTP hub (`/mcp` endpoint),
 * used for the read path when `piPalace.mcp.transport === "http"` — the
 * HTTP-mode counterpart of `PersistentMcpClient` (stdio). Only implements
 * what mcp-manager.ts's read path needs: `tools/list` and `tools/call`.
 *
 * Deliberately stateless/per-call (no persistent connection to keep open,
 * unlike the stdio client) — HTTP has no handshake/process to amortize.
 */
import type { HubHandle } from "./hub-manager.js";
import type { McpToolCallResult, McpToolSchema } from "./persistent-mcp-client.js";

const DEFAULT_TIMEOUT_MS = 60_000;

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id?: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

async function callJsonRpc(hub: HubHandle, method: string, params: unknown, timeoutMs: number): Promise<JsonRpcResponse> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${hub.baseUrl}/mcp`, {
			method: "POST",
			signal: controller.signal,
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${hub.token}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
		if (!res.ok) {
			throw new Error(`hub HTTP ${method} failed: ${res.status} ${res.statusText}`);
		}
		return (await res.json()) as JsonRpcResponse;
	} finally {
		clearTimeout(timer);
	}
}

export class HubClient {
	constructor(private readonly hub: HubHandle) {}

	async listTools(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<McpToolSchema[]> {
		const res = await callJsonRpc(this.hub, "tools/list", {}, timeoutMs);
		if (res.error) throw new Error(`hub tools/list failed: ${res.error.message}`);
		const result = res.result as { tools?: McpToolSchema[] } | undefined;
		return result?.tools ?? [];
	}

	async callTool(name: string, args: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<McpToolCallResult> {
		const res = await callJsonRpc(this.hub, "tools/call", { name, arguments: args }, timeoutMs);
		if (res.error) throw new Error(`hub tools/call(${name}) failed: ${res.error.message}`);
		return (res.result ?? {}) as McpToolCallResult;
	}
}
