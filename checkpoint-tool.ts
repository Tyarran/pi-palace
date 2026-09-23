import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { McpManager } from "./mcp-manager.js";

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
 * Calls MemPalace's checkpoint operation through the shared persistent
 * light MCP connection (`palace_exec`, `action: "checkpoint"`) instead of
 * spawning a dedicated one-shot `mempalace-mcp` process per call. Uses the
 * light server specifically (mandatory baseline) rather than the full
 * server's dedicated `mempalace_checkpoint` tool name, since light is
 * always connected and exposes the same operation through its unified
 * palace_exec entrypoint.
 */
export function createMempalaceCheckpointTool(mcpManager: McpManager) {
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
			const result = await mcpManager.callLightTool("palace_exec", { action: "checkpoint", ...params });

			const text = result.content?.map((c) => c.text ?? "").join("\n") ?? "";

			if (result.isError) {
				throw new Error(`mempalace_checkpoint failed: ${text || "unknown error"}`);
			}

			// The MCP tool result text is the JSON-serialized {added, duplicates,
			// errors, diary} payload. Parse it to also catch the "200 OK shape,
			// but errors[] non-empty" failure mode (e.g. palace write lock held
			// by another process) that isError alone would miss.
			let parsed: { errors?: unknown[]; diary?: { success?: boolean; error?: string } } = {};
			try {
				parsed = JSON.parse(text);
			} catch {
				// Non-JSON text content is still a valid success shape for some
				// tools; only treat it as fatal if we can't proceed at all.
			}
			const itemErrors = Array.isArray(parsed.errors) ? parsed.errors : [];
			const diaryFailed = parsed.diary?.success === false;
			if (itemErrors.length > 0 || diaryFailed) {
				throw new Error(`mempalace_checkpoint reported failures: ${JSON.stringify({ itemErrors, diaryError: parsed.diary?.error })}`);
			}

			return {
				content: [{ type: "text" as const, text: text || "Checkpoint saved." }],
				details: parsed as Record<string, unknown>,
			};
		},
	});
}
