import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * pi-palace's own bearer token for the MemPalace HTTP hub it manages (see
 * hub-manager.ts). Deliberately NOT the token MemPalace itself would
 * generate/read from ~/.mempalace/server/<hash-of-palace-path>/token —
 * that scheme requires resolving the palace's canonical path (the same
 * config-file/env-var resolution `mempalace` itself does) just to compute
 * the hash, which pi-palace has no reason to duplicate.
 *
 * Instead, pi-palace mints its own token once, persists it here, and always
 * passes it explicitly (`--token` / `MEMPALACE_MCP_HTTP_TOKEN`) when it spawns
 * `mempalace serve` — see hub-manager.ts. That makes pi-palace's hub
 * connection self-contained: no palace-path resolution, no reading
 * MemPalace's own token file.
 */
const TOKEN_PATH = join(homedir(), ".mempalace", "hook_state", "pi-palace-hub-token.txt");

export async function readOrCreateHubToken(): Promise<string> {
	try {
		const existing = (await readFile(TOKEN_PATH, "utf8")).trim();
		if (existing) return existing;
	} catch {
		// missing/unreadable — fall through and mint a new one.
	}
	const token = randomBytes(32).toString("base64url");
	await mkdir(dirname(TOKEN_PATH), { recursive: true });
	await writeFile(TOKEN_PATH, `${token}\n`, { encoding: "utf8", mode: 0o600 });
	return token;
}
