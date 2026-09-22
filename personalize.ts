import type { McpManager } from "./mcp-manager.js";
import { getWakeUpContext } from "./wake-up-cli.js";

const DIARY_AGENT_NAME = "pi";
const DIARY_LAST_N = 5;

/**
 * The guaranteed, fast part of the startup digest — CLI-based `mempalace
 * wake-up`, ~2-3s. Split out from diary fetching specifically so callers
 * can await this alone in "sync" mode without also waiting on the MCP
 * connection (see fetchDiaryDigest).
 */
export async function fetchWakeUpDigest(userWing: string): Promise<string | null> {
	const wakeUp = await getWakeUpContext(userWing);
	return wakeUp ? `## MemPalace wake-up\n${wakeUp}` : null;
}

/**
 * The best-effort part of the startup digest — the current agent's last N
 * diary entries, via the shared persistent MCP connection. ALWAYS
 * fire-and-forget, regardless of injectWakeUp.mode: the caller (index.ts)
 * never awaits this before injecting the system prompt. In "sync" mode
 * this means diary content will very often be missing (the MCP connection
 * has barely started by the time the fast wake-up fetch resolves) — an
 * accepted trade-off, not a bug.
 */
export async function fetchDiaryDigest(mcpManager: McpManager): Promise<string | null> {
	const diaryResult = await mcpManager
		.callLightTool("palace_query", { target: "diary_read", agent_name: DIARY_AGENT_NAME, last_n: DIARY_LAST_N })
		.catch(() => null);

	const diaryText = diaryResult?.content
		?.map((c) => c.text ?? "")
		.join("\n")
		.trim();
	return diaryText ? `## Recent agent diary (last ${DIARY_LAST_N}, agent: ${DIARY_AGENT_NAME})\n${diaryText}` : null;
}
