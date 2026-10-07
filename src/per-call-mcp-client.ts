/**
 * "per-call" MCP connection (piPalace.mcp.connection): instead of keeping one
 * stdio process open for the whole session, every `listTools`/`callTool`
 * spawns a short-lived `PersistentMcpClient` (initialize + the request), then
 * closes it whether the request succeeded or failed. Trades per-call latency
 * for zero resident memory between calls. Calls are neither serialized nor
 * retried: parallel calls each get their own process, errors surface as-is.
 */
import {
	type McpToolCallResult,
	type McpToolSchema,
	PersistentMcpClient,
	type ReadCapableClient,
} from "./persistent-mcp-client.js";

export interface PerCallMcpClient extends ReadCapableClient {
	/** Kills every process currently in flight (their pending calls reject). */
	close(): void;
}

export function createPerCallMcpClient(command: string, callTimeoutMs?: number): PerCallMcpClient {
	const live = new Set<PersistentMcpClient>();

	async function withEphemeralClient<T>(fn: (client: PersistentMcpClient) => Promise<T>): Promise<T> {
		const client = new PersistentMcpClient(command, callTimeoutMs);
		live.add(client);
		try {
			await client.waitUntilReady();
			return await fn(client);
		} finally {
			client.close();
			live.delete(client);
		}
	}

	return {
		listTools: (): Promise<McpToolSchema[]> => withEphemeralClient((c) => c.listTools()),
		callTool: (name: string, args: Record<string, unknown>): Promise<McpToolCallResult> =>
			withEphemeralClient((c) => c.callTool(name, args)),
		close: () => {
			for (const client of live) client.close();
			live.clear();
		},
	};
}
