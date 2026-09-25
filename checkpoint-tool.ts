import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { submitMcpToolJob, submitMcpToolJobWaiting } from "./daemon-client.js";

const drawerItemSchema = Type.Object({
	wing: Type.String({ description: "Wing (project name, or the configured user wing for preferences)" }),
	room: Type.String({ description: "Room (category within the wing)" }),
	content: Type.String({ description: "Verbatim content to store" }),
});

const diarySchema = Type.Object({
	agent_name: Type.String({ description: "Name of the filing agent" }),
	entry: Type.String({ description: "Diary entry, AAAK format" }),
	topic: Type.Optional(Type.String()),
	wing: Type.Optional(Type.String({ description: "Wing to file the diary entry in (the configured diary wing, separate from item wings)" })),
});

/**
 * Submits MemPalace's checkpoint operation as a daemon job (`kind:
 * "mcp_tool"`, `name: "mempalace_checkpoint"`) instead of calling it
 * directly through the shared persistent light MCP connection.
 *
 * The light MCP server (one per pi session) tries to acquire the palace's
 * single-writer flock itself when asked to run a mutating tool. If another
 * process already holds it — typically the daemon mid-mine, which can run
 * for a long time — the call used to fail immediately with "Peer MCP
 * writer active", silently dropping the checkpoint (autosave defaults to
 * "silent" mode, so nothing surfaced the failure). Going through
 * `submitMcpToolJob` instead durably queues the checkpoint on the daemon's
 * own job queue — the same serialization point already used for daily
 * mining — so it runs once the daemon is free, no matter how many
 * pi/opencode sessions are open concurrently.
 *
 * Trade-off: submission is fire-and-forget (`wait: false`), so this tool
 * can only report "queued", not "filed successfully" — the real dedup/file/
 * diary result is no longer available synchronously to the calling
 * sub-agent. See daemon-client.ts's submitMcpToolJob doc comment for why
 * that trade-off was chosen over blocking.
 */
export function createMempalaceCheckpointTool() {
	return defineTool({
		name: "mempalace_checkpoint",
		label: "MemPalace Checkpoint",
		description:
			"Save a whole session in one call: semantic-dedups each item, files the non-duplicates as drawers, then writes one diary entry.",
		parameters: Type.Object({
			items: Type.Array(drawerItemSchema, { description: "Verbatim items to file" }),
			diary: Type.Optional(diarySchema),
		}),
		async execute(_toolCallId, params) {
			const result = await submitMcpToolJob("mempalace_checkpoint", params);

			if (!result.success) {
				throw new Error(`mempalace_checkpoint submission failed: ${result.error || "unknown error"}`);
			}

			return {
				content: [{ type: "text" as const, text: `Checkpoint queued (job ${result.jobId ?? "?"}, state: ${result.state ?? "queued"}).` }],
				details: { ...result },
			};
		},
	});
}

/**
 * Point 2 — knowledge-graph tools for the checkpoint sub-agent, alongside
 * `mempalace_checkpoint` above. Unlike the checkpoint tool (fire-and-forget,
 * `submitMcpToolJob`/`wait:false`, by design — autosave must never stall a
 * session turn), these use `submitMcpToolJobWaiting` (`wait:true`,
 * `stop_on_lock_deferral:true`): the sub-agent's own system prompt
 * (CHECKPOINT_SYSTEM_PROMPT) decides case by case whether something is a
 * drawer or a KG fact, so it needs to know whether the KG write actually
 * landed, not just that it was queued. The blocking wait is bounded by
 * `stop_on_lock_deferral` — it does not stall behind an in-progress mine's
 * full duration, only until the lock-refusal is observed.
 */
function daemonWaitingResult(toolName: string, result: Awaited<ReturnType<typeof submitMcpToolJobWaiting>>) {
	if (result.kind === "lockedByMine") {
		throw new Error(`${toolName}: the MemPalace daemon is currently busy mining and holds the palace write lock — try again shortly.`);
	}
	if (result.kind === "failed") {
		throw new Error(`${toolName} failed: ${result.error}`);
	}
	return {
		content: [{ type: "text" as const, text: JSON.stringify(result.result) }],
		details: result.result,
	};
}

export function createMempalaceKgAddTool() {
	return defineTool({
		name: "mempalace_kg_add",
		label: "MemPalace KG Add",
		description: "Add a fact to the knowledge graph (subject/predicate/object, optionally time-scoped).",
		parameters: Type.Object({
			subject: Type.String({ description: "The entity doing/being something" }),
			predicate: Type.String({ description: 'Relationship type (e.g. "uses_model", "works_on")' }),
			object: Type.String({ description: "The entity being connected to" }),
			valid_from: Type.Optional(Type.String({ description: "When this became true (YYYY-MM-DD)" })),
			source_closet: Type.Optional(Type.String({ description: "Closet ID where this fact appears" })),
		}),
		async execute(_toolCallId, params) {
			return daemonWaitingResult("mempalace_kg_add", await submitMcpToolJobWaiting("mempalace_kg_add", params));
		},
	});
}

export function createMempalaceKgSupersedeTool() {
	return defineTool({
		name: "mempalace_kg_supersede",
		label: "MemPalace KG Supersede",
		description:
			"Atomically replace a single-valued fact with its successor (e.g. model, employer, address) instead of a separate invalidate + add.",
		parameters: Type.Object({
			subject: Type.String({ description: "Entity whose fact is changing" }),
			predicate: Type.String({ description: 'Relationship (e.g. "uses_model", "works_at")' }),
			old_object: Type.String({ description: "Value being replaced" }),
			new_object: Type.String({ description: "New value" }),
			at: Type.Optional(Type.String({ description: "Boundary instant (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ; default: now UTC)" })),
		}),
		async execute(_toolCallId, params) {
			return daemonWaitingResult("mempalace_kg_supersede", await submitMcpToolJobWaiting("mempalace_kg_supersede", params));
		},
	});
}

export function createMempalaceKgInvalidateTool() {
	return defineTool({
		name: "mempalace_kg_invalidate",
		label: "MemPalace KG Invalidate",
		description: "Mark a fact as no longer true (use mempalace_kg_supersede instead when there is a direct replacement value).",
		parameters: Type.Object({
			subject: Type.String({ description: "Entity" }),
			predicate: Type.String({ description: "Relationship" }),
			object: Type.String({ description: "Connected entity" }),
			ended: Type.Optional(Type.String({ description: "When it stopped being true (default: today)" })),
		}),
		async execute(_toolCallId, params) {
			return daemonWaitingResult("mempalace_kg_invalidate", await submitMcpToolJobWaiting("mempalace_kg_invalidate", params));
		},
	});
}
