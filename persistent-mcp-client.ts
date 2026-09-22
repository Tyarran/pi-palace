/**
 * Long-lived MCP stdio JSON-RPC client — generalizes the one-shot pattern
 * from the old mcp-client.ts into a reusable connection kept open for the
 * session's lifetime. Supports multiple concurrent in-flight calls (each
 * tracked by its own request id).
 *
 * Verified empirically (this session): raw JSON Schema from `tools/list`
 * (no TypeBox markers) works directly as `pi.registerTool()`'s `parameters`
 * field — no conversion layer needed.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id?: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface McpToolSchema {
	name: string;
	description?: string;
	// biome-ignore lint: raw MCP JSON Schema, intentionally untyped — passed straight through to pi.registerTool()
	inputSchema: any;
}

export interface McpToolCallResult {
	content?: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

export class PersistentMcpClient {
	private child: ChildProcessWithoutNullStreams;
	private buffer = "";
	private pending = new Map<number, { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }>();
	private nextId = 1;
	private stderrTail = "";
	private readyPromise: Promise<void>;
	private closed = false;

	constructor(command: string) {
		this.child = spawn(command, [], { stdio: ["pipe", "pipe", "pipe"] });

		// Without this, a spawn failure (e.g. ENOENT if `command` isn't on
		// PATH in whatever environment pi itself was launched from — which can
		// differ from an interactive shell's PATH) leaves every pending call
		// hanging forever instead of rejecting: 'error' fires independently of
		// 'exit', and nothing else in this class was listening for it.
		this.child.on("error", (err) => {
			this.closed = true;
			for (const { reject } of this.pending.values()) {
				reject(new Error(`MCP server process failed to start: ${err.message}`));
			}
			this.pending.clear();
		});

		this.child.stderr.on("data", (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4000);
		});

		this.child.stdout.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString("utf8");
			let idx: number;
			// biome-ignore lint: simple newline-delimited framing loop
			while ((idx = this.buffer.indexOf("\n")) !== -1) {
				const line = this.buffer.slice(0, idx).trim();
				this.buffer = this.buffer.slice(idx + 1);
				if (!line) continue;
				let msg: JsonRpcResponse;
				try {
					msg = JSON.parse(line);
				} catch {
					continue; // tolerate stray non-JSON lines
				}
				if (typeof msg.id === "number" && this.pending.has(msg.id)) {
					this.pending.get(msg.id)?.resolve(msg);
					this.pending.delete(msg.id);
				}
			}
		});

		this.child.on("exit", () => {
			this.closed = true;
			for (const { reject } of this.pending.values()) {
				reject(new Error("MCP server process exited"));
			}
			this.pending.clear();
		});

		this.readyPromise = this.initialize();
	}

	private send(method: string, params: unknown, expectResponse: true, timeoutMs?: number): Promise<JsonRpcResponse>;
	private send(method: string, params: unknown, expectResponse: false): void;
	private send(method: string, params: unknown, expectResponse: boolean, timeoutMs = 30_000) {
		if (this.closed) {
			const err = new Error("MCP client is closed");
			if (expectResponse) return Promise.reject(err);
			throw err;
		}
		const payload: Record<string, unknown> = { jsonrpc: "2.0", method, params };
		if (expectResponse) {
			const id = this.nextId++;
			payload.id = id;
			const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
				this.pending.set(id, { resolve, reject });
				setTimeout(() => {
					if (this.pending.has(id)) {
						this.pending.delete(id);
						reject(new Error(`MCP call ${method} timed out after ${timeoutMs}ms`));
					}
				}, timeoutMs);
			});
			this.child.stdin.write(`${JSON.stringify(payload)}\n`);
			return promise;
		}
		this.child.stdin.write(`${JSON.stringify(payload)}\n`);
		return undefined;
	}

	private async initialize(): Promise<void> {
		const res = await this.send(
			"initialize",
			{
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "pi-mempalace-autosave", version: "0.1.0" },
			},
			true,
		);
		if (res.error) {
			throw new Error(`MCP initialize failed: ${res.error.message}`);
		}
		this.send("notifications/initialized", {}, false);
	}

	/** Resolves once the initialize handshake has completed (or rejects on failure). */
	async waitUntilReady(): Promise<void> {
		return this.readyPromise;
	}

	async listTools(): Promise<McpToolSchema[]> {
		await this.readyPromise;
		const res = await this.send("tools/list", {}, true);
		if (res.error) throw new Error(`MCP tools/list failed: ${res.error.message}`);
		const result = res.result as { tools?: McpToolSchema[] } | undefined;
		return result?.tools ?? [];
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
		await this.readyPromise;
		try {
			const res = await this.send("tools/call", { name, arguments: args }, true);
			if (res.error) throw new Error(`MCP tools/call(${name}) failed: ${res.error.message}`);
			return (res.result ?? {}) as McpToolCallResult;
		} catch (err) {
			const stderrHint = this.stderrTail.trim() ? ` (stderr: ${this.stderrTail.trim().slice(-500)})` : "";
			throw new Error(`${err instanceof Error ? err.message : String(err)}${stderrHint}`);
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.child.kill();
	}
}
