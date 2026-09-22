import type { McpManager } from "./mcp-manager.js";
import { getWakeUpContext } from "./wake-up-cli.js";

const DIARY_AGENT_NAME = "pi";
const DIARY_LAST_N = 5;

/**
 * Builds the session-start personalization digest: MemPalace's own
 * wake-up (L0 identity + L1 essential story, scoped to userWing) combined
 * with the current agent's last N diary entries.
 *
 * diary_read now reuses the shared persistent MCP connection (mcpManager)
 * instead of spawning a one-shot mempalace-mcp process per call — the
 * approach that previously cost ~30s per attempt (twice tried and dropped:
 * once as a synchronous await that blocked the first response, once
 * fire-and-forget where the spawned child kept the Node process alive).
 * With a connection already warm from session_start, this call is now just
 * a fast JSON-RPC round-trip.
 */
export async function buildPersonalizationContext(userWing: string, mcpManager: McpManager): Promise<string | null> {
	const [wakeUp, diaryResult] = await Promise.all([
		getWakeUpContext(userWing),
		mcpManager.callLightTool("palace_query", { target: "diary_read", agent_name: DIARY_AGENT_NAME, last_n: DIARY_LAST_N }).catch(() => null),
	]);

	const parts: string[] = [];
	if (wakeUp) parts.push(`## MemPalace wake-up\n${wakeUp}`);

	const diaryText = diaryResult?.content
		?.map((c) => c.text ?? "")
		.join("\n")
		.trim();
	if (diaryText) parts.push(`## Recent agent diary (last ${DIARY_LAST_N}, agent: ${DIARY_AGENT_NAME})\n${diaryText}`);

	if (parts.length === 0) return null;
	return parts.join("\n\n");
}
