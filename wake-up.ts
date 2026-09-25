import { basename } from "node:path";
import type { McpManager } from "./mcp-manager.js";
import type { AutosaveSettings } from "./settings.js";
import { getWakeUpContext } from "./wake-up-cli.js";

const DIARY_LAST_N = 5;

/**
 * Resolves which wing (if any) the wake-up CLI fetch should be scoped to,
 * based on `injectWakeUp.source`:
 * - "user": settings.userWing, degrading to null (no --wing) if unset.
 * - "project": the cwd-derived project wing (same basename(cwd) convention
 *   as the checkpoint's project items, see constants.ts).
 * - "custom": settings.injectWakeUp.wing, degrading to the "user" behavior
 *   above if unset.
 * - null: no wing at all — the CLI is called without --wing.
 */
export function resolveWakeUpWing(settings: Pick<AutosaveSettings, "userWing" | "injectWakeUp">, cwd: string): string | null {
	switch (settings.injectWakeUp.source) {
		case "user":
			return settings.userWing ?? null;
		case "project":
			return basename(cwd);
		case "custom":
			return settings.injectWakeUp.wing ?? settings.userWing ?? null;
		case null:
			return null;
	}
}

/**
 * The guaranteed, fast part of the startup digest — CLI-based `mempalace
 * wake-up`, ~2-3s. Split out from diary fetching specifically so callers
 * can await this alone in "sync" mode without also waiting on the MCP
 * connection (see fetchDiaryDigest). `wing` may be null (see
 * resolveWakeUpWing) — the CLI is then called without --wing.
 */
export async function fetchWakeUpDigest(wing: string | null): Promise<string | null> {
	const wakeUp = await getWakeUpContext(wing);
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
export async function fetchDiaryDigest(mcpManager: McpManager, agentName: string): Promise<string | null> {
	const diaryResult = await mcpManager
		.callLightTool("palace_query", { target: "diary_read", agent_name: agentName, last_n: DIARY_LAST_N })
		.catch(() => null);

	const diaryText = diaryResult?.content
		?.map((c) => c.text ?? "")
		.join("\n")
		.trim();
	return diaryText ? `## Recent agent diary (last ${DIARY_LAST_N}, agent: ${agentName})\n${diaryText}` : null;
}
