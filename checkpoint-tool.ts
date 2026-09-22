import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { callMempalaceTool } from "./mcp-client.js";

const drawerItemSchema = Type.Object({
	wing: Type.String({ description: "Wing (project name, or the configured user wing for preferences)" }),
	room: Type.String({ description: "Room (category within the wing)" }),
	content: Type.String({ description: "Verbatim content to store" }),
});

const diarySchema = Type.Object({
	agent_name: Type.String({ description: "Name of the filing agent" }),
	entry: Type.String({ description: "Diary entry, AAAK format" }),
	topic: Type.Optional(Type.String()),
});

/**
 * Calls mempalace's mempalace_checkpoint MCP tool over a dedicated,
 * one-shot stdio MCP connection (spawns `mempalace-mcp`, does the
 * initialize handshake, makes the one tools/call, exits). This goes
 * through the real, supported MCP protocol path rather than importing
 * mempalace's internal Python modules directly, which proved fragile in
 * practice (readonly-database behavior and stdout/stderr redirection
 * specific to how the package expects to be run as a long-lived server).
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
			const result = await callMempalaceTool("mempalace_checkpoint", params as Record<string, unknown>);

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
