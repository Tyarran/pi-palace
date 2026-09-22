import { getWakeUpContext } from "./wake-up-cli.js";

/**
 * Builds the session-start personalization digest: MemPalace's own
 * wake-up (L0 identity + L1 essential story, scoped to userWing).
 *
 * diary_read was tried twice and dropped both times:
 * 1. First attempt: awaited synchronously in before_agent_start, added
 *    ~30s to the first response (spawning a fresh mempalace-mcp process
 *    per call pays a full chromadb/onnxruntime/embedding-model startup
 *    cost every time).
 * 2. Second attempt, after making the whole fetch fire-and-forget from
 *    session_start: no longer delayed the response, but the spawned child
 *    process kept the Node process itself alive for ~30s before exit,
 *    which is harmless in interactive mode (session stays open anyway)
 *    but breaks `pi -p` / scripting use cases.
 *
 * wake-up alone (CLI, ~2-3s) stays fast and exits cleanly. A note pointing
 * the agent at mempalace_diary_read is appended instead, letting it fetch
 * recent diary entries itself on demand, through its own already-connected
 * MCP session (fast, no extra process spawn).
 */
export async function buildPersonalizationContext(userWing: string): Promise<string | null> {
	const wakeUp = await getWakeUpContext(userWing);
	if (!wakeUp) return null;

	return [
		`## MemPalace wake-up\n${wakeUp}`,
		`## Note\nRecent diary entries for this agent are also available on request via the mempalace_diary_read tool (agent_name="pi") if relevant to the conversation.`,
	].join("\n\n");
}
