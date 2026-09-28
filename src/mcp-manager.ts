import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "typebox";
import { submitMcpToolJobWaiting } from "./daemon-client.js";
import { HubClient } from "./hub-client.js";
import { ensureHubRunning } from "./hub-manager.js";
import { type McpToolCallResult, type McpToolSchema, PersistentMcpClient } from "./persistent-mcp-client.js";
import type { AutosaveSettings } from "./settings.js";

/**
 * What `registerServerTools` needs from a connection — satisfied structurally
 * by both `PersistentMcpClient` (stdio, the only transport `light` ever uses —
 * `mempalace-light-mcp` has no HTTP transport of its own, see hub-manager.ts's
 * doc comment) and `HubClient` (HTTP, used for `full`'s read path when
 * `piPalace.mcp.transport === "http"`). Write execution never touches this —
 * every mutating tool call goes through `submitMcpToolJobWaiting` regardless
 * of which client discovered/read it (see `registerServerTools` below).
 */
export interface ReadCapableClient {
	listTools(): Promise<McpToolSchema[]>;
	callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
}

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
	// Unified mempalace-light query tool — always read-only regardless of
	// what it's asked to fetch (memories/taxonomy/KG/tunnels/diary/status),
	// unlike palace_coordinate below which mixes read and write actions in
	// one tool name and needs per-call inspection instead (see
	// `isReadOnlyCoordinateCall`). palace_exec (mempalace-light's write
	// counterpart) is deliberately NOT listed here — every action it exposes
	// mutates the palace, so it correctly falls through to the daemon-routed
	// fail-safe default.
	"palace_query",
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

/**
 * `palace_coordinate` (mempalace-light) is a single tool name covering both
 * read actions (event_list, event_wait, inbox, mesh_peers, artifact_get)
 * and write actions (task_create, event_append, event_ack, artifact_put,
 * patch_submit) — unlike every other tool here, a flat name-based Set can't
 * classify it. Callers pass either a structured `action` field or a DSL
 * `command` string (e.g. "EVENT LIST stream:...", "TASK CREATE ...") — see
 * `palace_coordinate`'s own tool description for the full DSL grammar.
 *
 * Fail-safe mirrors `isReadOnlyTool`: if the action/command can't be
 * recognized (missing, malformed, or a future action this list doesn't
 * know about yet), this returns false so the call goes through the
 * daemon-routed write path rather than risking a direct write racing the
 * palace's single-writer lock.
 */
const COORDINATE_READ_ACTIONS = new Set(["event_list", "event_wait", "mesh_peers", "artifact_get", "inbox"]);

/**
 * DSL command prefixes considered read-only, matched against the first two
 * whitespace-separated tokens of `command` (case-insensitive). Kept
 * separate from `COORDINATE_READ_ACTIONS` because the DSL's verb pairs
 * don't map 1:1 onto `action` names (e.g. "EVENT INBOX" vs action `inbox`).
 */
const COORDINATE_READ_DSL_PREFIXES: RegExp[] = [
	/^event\s+list\b/i,
	/^event\s+wait\b/i,
	/^event\s+inbox\b/i,
	/^mesh\s+peers\b/i,
	/^artifact\s+get\b/i,
];

/** See the doc comment on `COORDINATE_READ_ACTIONS` above. */
export function isReadOnlyCoordinateCall(params: Record<string, unknown>): boolean {
	const action = params.action;
	if (typeof action === "string") {
		return COORDINATE_READ_ACTIONS.has(action.toLowerCase());
	}
	const command = params.command;
	if (typeof command === "string") {
		const trimmed = command.trim();
		return COORDINATE_READ_DSL_PREFIXES.some((re) => re.test(trimmed));
	}
	return false;
}

export interface McpManager {
	// null when disabled (piPalace.mcp.light.enabled: false) or when it failed
	// to come up (stdio-only — light has no HTTP transport, see
	// hub-manager.ts's doc comment). index.ts's session_start enforces that
	// light and full are never BOTH disabled by configuration, but a runtime
	// failure of whichever one is enabled can still leave this null.
	light: PersistentMcpClient | null;
	// null when disabled, OR when it failed to come up (stdio mode) — both
	// existing behavior. In http mode this is a HubClient instead of a
	// PersistentMcpClient: the hub is a shared, externally-lived process (see
	// hub-manager.ts), so McpManager.close() never tears it down either way.
	full: ReadCapableClient | null;
	// Fetches the current agent's diary (used by wake-up.ts): prefers `light`
	// (`palace_query`, target `diary_read`) when available, falls back to
	// `full`'s direct `mempalace_diary_read` tool otherwise — the two
	// connections expose the same underlying data under different tool
	// shapes, so this is the one place that difference needs to be known.
	// Throws if neither connection is available.
	readDiary(agentName: string, lastN: number): Promise<McpToolCallResult>;
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
async function registerServerTools(pi: ExtensionAPI, client: ReadCapableClient): Promise<void> {
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
				// palace_coordinate can't be classified by name alone (see
				// `isReadOnlyCoordinateCall`'s doc comment) — every other tool name
				// is fully read-only or fully write, so `isReadOnlyTool` alone is
				// enough for them.
				const readOnly =
					tool.name === "palace_coordinate"
						? isReadOnlyCoordinateCall(params as Record<string, unknown>)
						: isReadOnlyTool(tool.name);
				if (readOnly) {
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
 * Fetches an agent's diary, preferring `light` (`palace_query`, target
 * `diary_read`) and falling back to `full`'s direct `mempalace_diary_read`
 * tool when light is unavailable \u2014 the two connections expose the same
 * underlying data under different tool shapes (see `McpManager.readDiary`'s
 * doc comment). Extracted as a standalone pure function (taking the two
 * connections as plain arguments rather than reading them off `McpManager`)
 * specifically so it's unit-testable with lightweight mock clients, without
 * needing to spin up `initMcpManager`'s real stdio/HTTP connections.
 */
export async function readDiaryVia(
	light: ReadCapableClient | null,
	full: ReadCapableClient | null,
	agentName: string,
	lastN: number,
): Promise<McpToolCallResult> {
	if (light) return light.callTool("palace_query", { target: "diary_read", agent_name: agentName, last_n: lastN });
	if (full) return full.callTool("mempalace_diary_read", { agent_name: agentName, last_n: lastN });
	throw new Error("no MemPalace MCP connection available (both light and full are disabled or unavailable)");
}

/**
 * Both light and full are individually toggleable (settings.mcp.light.enabled
 * / settings.mcp.full.enabled) — index.ts's session_start enforces that
 * they're never both disabled by configuration. Both connections, when
 * enabled, are established here, at session_start, and kept open for the
 * session's lifetime — this is what lets the checkpoint sub-agent and the
 * profile-injection digest reuse an already-warm connection instead of paying
 * a fresh process-startup cost per call (the ~30s latency issues fought
 * earlier this project).
 */
export async function initMcpManager(pi: ExtensionAPI, settings: AutosaveSettings): Promise<McpManager> {
	let light: PersistentMcpClient | null = null;
	// Only a stdio connection owns a process pi-palace must close itself — see
	// the matching comment on closeFull below for why the hub (http mode)
	// never needs this.
	let closeLight: () => void = () => {};
	if (settings.mcp.light.enabled) {
		// Always stdio, regardless of piPalace.mcp.transport —
		// mempalace-light-mcp has no --transport http of its own (validated
		// during this issue's implementation), so the transport setting can
		// only ever affect `full`.
		const lightClient = new PersistentMcpClient("mempalace-light-mcp");
		try {
			await lightClient.waitUntilReady();
			await registerServerTools(pi, lightClient);
			light = lightClient;
			closeLight = () => lightClient.close();
		} catch (err) {
			// light failed (spawn error, handshake failure, or a pi.registerTool()
			// throw e.g. from a stale session mid-print-mode teardown) — without
			// closing it here, the already-spawned child process is never closed
			// and its open stdio pipes keep the whole pi process alive
			// indefinitely (reproduced during testing: `pi -p` hung well past
			// response completion with an orphaned mempalace-light-mcp). full may
			// still be usable, so this degrades rather than throws.
			lightClient.close();
			if (process.env.MEMPALACE_AUTOSAVE_DEBUG) console.error("[pi-palace] light MCP server init failed:", err);
		}
	}

	let full: ReadCapableClient | null = null;
	// Only the stdio branch owns a process pi-palace must close itself — the
	// hub is shared/externally-lived (see hub-manager.ts), so closeFull stays
	// a no-op in http mode.
	let closeFull: () => void = () => {};
	if (settings.mcp.full.enabled) {
		if (settings.mcp.transport === "http") {
			try {
				const hub = await ensureHubRunning(settings.mcp.http);
				const hubClient = new HubClient(hub);
				await registerServerTools(pi, hubClient);
				full = hubClient;
			} catch (err) {
				// Hub unreachable/failed to start — light stays usable, full is
				// just disabled for this session (mirrors the stdio failure path below).
				if (process.env.MEMPALACE_AUTOSAVE_DEBUG) console.error("[pi-palace] HTTP hub init failed:", err);
			}
		} else {
			const fullClient = new PersistentMcpClient("mempalace-mcp");
			try {
				await fullClient.waitUntilReady();
				await registerServerTools(pi, fullClient);
				full = fullClient;
				closeFull = () => fullClient.close();
			} catch (err) {
				// Only the full server failed to come up — light stays usable,
				// close just the failed one instead of tearing everything down.
				fullClient.close();
				if (process.env.MEMPALACE_AUTOSAVE_DEBUG) console.error("[pi-palace] full MCP server init failed:", err);
			}
		}
	}

	return {
		light,
		full,
		readDiary: (agentName, lastN) => readDiaryVia(light, full, agentName, lastN),
		close: () => {
			closeLight();
			closeFull();
		},
	};
}
