import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "typebox";
import { submitMcpToolJobWaiting } from "./daemon-client.js";
import { type McpToolCallResult, PersistentMcpClient } from "./persistent-mcp-client.js";
import type { AutosaveSettings } from "./settings.js";

/**
 * Read-only `mempalace_*` tool names — called directly against the
 * persistent MCP connection, exactly like before this module started
 * routing writes through the daemon. Everything NOT in this set is treated
 * as a write and routed through `submitMcpToolJobWaiting` instead (see
 * `isReadOnlyTool`), fail-safe: an unrecognized tool name (e.g. a new one
 * shipped by a future mempalace version) defaults to the safer, slower
 * daemon-routed path rather than risking a direct write racing the palace's
 * single-writer lock.
 *
 * Source: https://mempalaceofficial.com/reference/mcp-tools.html (45 tools,
 * checked against this list manually — there is no machine-readable
 * annotation from `tools/list` to derive this automatically).
 * `mempalace_reconnect` and `mempalace_hook_settings` are included here even
 * though they technically "set" something: neither touches palace content
 * (drawers/wings/KG/tunnels/diary) — `reconnect` only refreshes the
 * in-memory index, `hook_settings` only touches local extension state — so
 * neither needs the write lock.
 */
const READ_ONLY_TOOLS = new Set([
	// Palace reads
	"mempalace_status",
	"mempalace_list_wings",
	"mempalace_list_rooms",
	"mempalace_get_taxonomy",
	"mempalace_search",
	"mempalace_check_duplicate",
	"mempalace_get_aaak_spec",
	"mempalace_get_drawer",
	"mempalace_get_drawers",
	"mempalace_list_drawers",
	// Knowledge graph reads
	"mempalace_kg_query",
	"mempalace_kg_timeline",
	"mempalace_kg_stats",
	// Navigation reads
	"mempalace_traverse",
	"mempalace_find_tunnels",
	"mempalace_graph_stats",
	"mempalace_list_tunnels",
	"mempalace_list_hallways",
	"mempalace_follow_tunnels",
	// Diary reads
	"mempalace_diary_read",
	// System (local state / index refresh, not palace content)
	"mempalace_memories_filed_away",
	"mempalace_reconnect",
	"mempalace_hook_settings",
	// Coordination (logstream) reads
	"mempalace_event_list",
	"mempalace_event_wait",
	"mempalace_artifact_get",
	"mempalace_mesh_peers",
]);

/** See `READ_ONLY_TOOLS` — fail-safe: unknown tool names are treated as writes. */
export function isReadOnlyTool(name: string): boolean {
	return READ_ONLY_TOOLS.has(name);
}

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
 *
 * Read tools (see `READ_ONLY_TOOLS`/`isReadOnlyTool`) call straight through
 * the persistent MCP connection, as before. Write tools are routed through
 * `submitMcpToolJobWaiting` instead — the same daemon job queue the
 * checkpoint autosave already relies on (`checkpoint-tool.ts`), but blocking
 * for the real result rather than fire-and-forgetting a "queued" ack. This
 * closes a gap where ANY mutating `mempalace_*` tool call made directly by
 * the main agent (not just checkpoints) could fail outright with "Peer MCP
 * writer active" whenever the daemon was mid-mine, instead of durably
 * waiting its turn. A `lockedByMine` outcome is surfaced as a tool error the
 * calling LLM can read and act on (e.g. tell the user to retry later)
 * instead of a generic failure.
 */
async function registerServerTools(pi: ExtensionAPI, client: PersistentMcpClient): Promise<void> {
	const tools = await client.listTools();
	for (const tool of tools) {
		pi.registerTool({
			name: tool.name,
			label: tool.name,
			description: tool.description ?? tool.name,
			// Raw MCP JSON Schema, verified compatible with pi.registerTool()'s
			// TSchema-typed `parameters` empirically — cast to the real expected
			// type (not `any`) since it's structurally close enough to satisfy it.
			parameters: tool.inputSchema as TSchema,
			async execute(_toolCallId, params) {
				if (isReadOnlyTool(tool.name)) {
					const result = await client.callTool(tool.name, params as Record<string, unknown>);
					const content = result.content?.length
						? result.content.map((c) => ({ type: "text" as const, text: c.text ?? "" }))
						: [{ type: "text" as const, text: "(empty result)" }];
					return { content, details: { ...result } };
				}

				const outcome = await submitMcpToolJobWaiting(tool.name, params as Record<string, unknown>);
				if (outcome.kind === "lockedByMine") {
					throw new Error(
						`${tool.name}: the MemPalace daemon is currently busy mining and holds the palace write lock — try again shortly.`,
					);
				}
				if (outcome.kind === "failed") {
					throw new Error(`${tool.name} failed: ${outcome.error}`);
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(outcome.result) }],
					details: outcome.result,
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
				if (process.env.MEMPALACE_AUTOSAVE_DEBUG) console.error("[pi-palace] full MCP server init failed:", err);
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
