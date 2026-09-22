import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type McpToolCallResult, PersistentMcpClient } from "./persistent-mcp-client.js";
import type { AutosaveSettings } from "./settings.js";

export interface McpManager {
	light: PersistentMcpClient;
	full: PersistentMcpClient | null;
	callLightTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
	close(): void;
}

/**
 * Registers each discovered tool (name/description/inputSchema straight
 * from `tools/list`) directly on the main session via pi.registerTool().
 * No hardcoded schemas — stays in sync automatically with whatever
 * mempalace/mempalace-light version is installed.
 */
async function registerServerTools(pi: ExtensionAPI, client: PersistentMcpClient): Promise<void> {
	const tools = await client.listTools();
	for (const tool of tools) {
		pi.registerTool({
			name: tool.name,
			label: tool.name,
			description: tool.description ?? tool.name,
			// biome-ignore lint: raw MCP JSON Schema, verified compatible with pi.registerTool() empirically
			parameters: tool.inputSchema as any,
			async execute(_toolCallId, params) {
				const result = await client.callTool(tool.name, params as Record<string, unknown>);
				return {
					content: result.content?.length ? result.content : [{ type: "text" as const, text: "(empty result)" }],
					details: result as Record<string, unknown>,
				};
			},
		});
	}
}

/**
 * light is mandatory, full is opt-in (settings.mcp.full.enabled). Both
 * connections are established here, at session_start, and kept open for
 * the session's lifetime — this is what lets the checkpoint sub-agent and
 * the profile-injection digest reuse an already-warm connection instead of
 * paying a fresh process-startup cost per call (the ~30s latency issues
 * fought earlier this project).
 */
export async function initMcpManager(pi: ExtensionAPI, settings: AutosaveSettings): Promise<McpManager> {
	const light = new PersistentMcpClient("mempalace-light-mcp");

	try {
		await light.waitUntilReady();
		await registerServerTools(pi, light);

		let full: PersistentMcpClient | null = null;
		if (settings.mcp.full.enabled) {
			full = new PersistentMcpClient("mempalace-mcp");
			try {
				await full.waitUntilReady();
				await registerServerTools(pi, full);
			} catch (err) {
				// Only the full server failed to come up — light stays usable,
				// close just the failed one instead of tearing everything down.
				full.close();
				full = null;
				if (process.env.MEMPALACE_AUTOSAVE_DEBUG) console.error("[pi-mempalace-autosave] full MCP server init failed:", err);
			}
		}

		return {
			light,
			full,
			callLightTool: (name, args) => light.callTool(name, args),
			close: () => {
				light.close();
				full?.close();
			},
		};
	} catch (err) {
		// light itself failed (spawn error, handshake failure, or a
		// pi.registerTool() throw e.g. from a stale session mid-print-mode
		// teardown) — without this, the already-spawned child process is
		// never closed and its open stdio pipes keep the whole pi process
		// alive indefinitely (reproduced during testing: `pi -p` hung well
		// past response completion with an orphaned mempalace-light-mcp).
		light.close();
		throw err;
	}
}
