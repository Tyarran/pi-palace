import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { submitMcpToolJob } from "./daemon-client.js";

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
				details: result as Record<string, unknown>,
			};
		},
	});
}
