/**
 * Minimal MCP stdio JSON-RPC client, scoped to exactly one tool call.
 *
 * We deliberately don't depend on @modelcontextprotocol/sdk (not resolvable
 * from this extension's node_modules tree) nor on pi-mcp-adapter's live
 * connection (private internal state, not part of any documented
 * cross-extension API). The MCP stdio wire format is simple and stable:
 * newline-delimited JSON-RPC 2.0 messages over stdin/stdout.
 *
 * Lifecycle: spawn mempalace-mcp -> initialize handshake -> notifications/initialized
 * -> tools/call -> read matching response -> kill process. One-shot, no reuse.
 */
import { spawn } from "node:child_process";

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id?: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface McpToolCallResult {
	content?: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

export async function callMempalaceTool(
	toolName: string,
	args: Record<string, unknown>,
	options: { command?: string; timeoutMs?: number } = {},
): Promise<McpToolCallResult> {
	const command = options.command ?? "mempalace-mcp";
	const timeoutMs = options.timeoutMs ?? 30_000;

	const child = spawn(command, [], { stdio: ["pipe", "pipe", "pipe"] });

	let buffer = "";
	const pending = new Map<number, { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }>();
	let stderrTail = "";

	child.stderr.on("data", (chunk: Buffer) => {
		stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
	});

	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let idx: number;
		// biome-ignore lint: simple newline-delimited framing loop
		while ((idx = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, idx).trim();
			buffer = buffer.slice(idx + 1);
			if (!line) continue;
			let msg: JsonRpcResponse;
			try {
				msg = JSON.parse(line);
			} catch {
				continue; // tolerate stray non-JSON lines
			}
			if (typeof msg.id === "number" && pending.has(msg.id)) {
				pending.get(msg.id)?.resolve(msg);
				pending.delete(msg.id);
			}
		}
	});

	let nextId = 1;
	function send(method: string, params: unknown, expectResponse: true): Promise<JsonRpcResponse>;
	function send(method: string, params: unknown, expectResponse: false): void;
	function send(method: string, params: unknown, expectResponse: boolean) {
		const payload: Record<string, unknown> = { jsonrpc: "2.0", method, params };
		if (expectResponse) {
			const id = nextId++;
			payload.id = id;
			const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
				pending.set(id, { resolve, reject });
			});
			child.stdin.write(`${JSON.stringify(payload)}\n`);
			return promise;
		}
		child.stdin.write(`${JSON.stringify(payload)}\n`);
		return undefined;
	}

	const timeout = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error(`MCP call to ${toolName} timed out after ${timeoutMs}ms`)), timeoutMs);
	});

	try {
		const initResponse = await Promise.race([
			send(
				"initialize",
				{
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "pi-mempalace-autosave", version: "0.1.0" },
				},
				true,
			),
			timeout,
		]);
		if (initResponse.error) {
			throw new Error(`MCP initialize failed: ${initResponse.error.message}`);
		}

		send("notifications/initialized", {}, false);

		const callResponse = await Promise.race([send("tools/call", { name: toolName, arguments: args }, true), timeout]);

		if (callResponse.error) {
			throw new Error(`MCP tools/call failed: ${callResponse.error.message}`);
		}

		return (callResponse.result ?? {}) as McpToolCallResult;
	} catch (err) {
		const stderrHint = stderrTail.trim() ? ` (stderr: ${stderrTail.trim().slice(-500)})` : "";
		throw new Error(`${err instanceof Error ? err.message : String(err)}${stderrHint}`);
	} finally {
		child.kill();
	}
}
