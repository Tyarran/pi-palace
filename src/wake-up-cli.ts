/**
 * Thin wrapper around `mempalace wake-up --wing X` — CLI-only, no MCP tool
 * equivalent exists (verified against the official 45 MCP tools reference).
 * Unlike daemon-client.ts, no python interpreter discovery is needed here:
 * `mempalace` is the CLI entrypoint directly on PATH.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function getWakeUpContext(wing?: string | null): Promise<string | null> {
	try {
		const args = wing ? ["wake-up", "--wing", wing] : ["wake-up"];
		const { stdout } = await execFileAsync("mempalace", args, { timeout: 15_000 });
		const text = stdout.trim();
		return text || null;
	} catch {
		// Failure handled by the caller (warning toast) — no error detail
		// needed here, this is a best-effort context enrichment, not a
		// critical path.
		return null;
	}
}
