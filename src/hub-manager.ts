/**
 * Lifecycle management for the shared MemPalace HTTP MCP hub
 * (`mempalace serve --read-only`), used for the read path when
 * `piPalace.mcp.transport === "http"` (see settings.ts / mcp-manager.ts).
 *
 * Mirrors `ensureDaemonRunning()` in daemon-client.ts: check liveness first,
 * spawn detached if needed, wait (bounded) for readiness. The hub is never
 * stopped by pi-palace once started — it's a shared, long-lived process
 * other sessions/tools may also be using (see hub-token.ts's doc comment
 * for why pi-palace mints and passes its own bearer token instead of
 * reading MemPalace's own per-palace token file).
 *
 * Writes are UNCHANGED by this module — they keep going through the daemon
 * (daemon-client.ts) exactly as in stdio mode. This hub is read-only by
 * construction (`--read-only`), so it never contends for the palace write
 * lock (see the brainstorm's verified finding: a `--read-only` HTTP server
 * skips `_acquire_writer_lease_for_http_startup` entirely).
 */
import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpHttpSettings } from "./settings.js";
import { readOrCreateHubToken } from "./hub-token.js";

const HEALTH_TIMEOUT_MS = 2_000;
const STARTUP_TIMEOUT_MS = 15_000;
const STARTUP_POLL_INTERVAL_MS = 300;
const LOG_PATH = join(homedir(), ".mempalace", "hook_state", "pi-palace-hub.log");

export interface HubHandle {
	baseUrl: string;
	token: string;
}

export class HubTokenConflictError extends Error {
	constructor(baseUrl: string) {
		super(
			`a MemPalace HTTP hub is already listening at ${baseUrl} with a different bearer token than pi-palace's own ` +
				"(started by something other than this pi-palace instance) — refusing to guess its credentials. " +
				"Stop that process, or point piPalace.mcp.http at a different host/port.",
		);
		this.name = "HubTokenConflictError";
	}
}

async function probeHealth(baseUrl: string, token: string | null, timeoutMs: number): Promise<"ok" | "unauthorized" | "unreachable"> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const headers: Record<string, string> = {};
		if (token) headers.Authorization = `Bearer ${token}`;
		const res = await fetch(`${baseUrl}/healthz`, { signal: controller.signal, headers });
		if (res.status === 401) return "unauthorized";
		return res.ok ? "ok" : "unreachable";
	} catch {
		return "unreachable";
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Confirms our own token is actually accepted by the live hub at baseUrl —
 * /healthz never requires auth (see `mempalace serve`'s own printed
 * "curl .../healthz # liveness (no auth)" hint), so a bare 200 there only
 * proves *something* is listening, not that it's ours. A cheap
 * authenticated call (`tools/list`) is what actually distinguishes "our
 * hub" from "someone else's hub on the same host:port".
 */
async function probeAuth(baseUrl: string, token: string, timeoutMs: number): Promise<"ok" | "unauthorized" | "unreachable"> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${baseUrl}/mcp`, {
			method: "POST",
			signal: controller.signal,
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		});
		if (res.status === 401) return "unauthorized";
		return res.ok ? "ok" : "unreachable";
	} catch {
		return "unreachable";
	} finally {
		clearTimeout(timer);
	}
}

async function spawnHub(http: McpHttpSettings, token: string): Promise<void> {
	await mkdir(join(homedir(), ".mempalace", "hook_state"), { recursive: true });
	const logHandle = await open(LOG_PATH, "a");
	const logFd = logHandle.fd;
	const child = spawn(
		"mempalace",
		["serve", "--read-only", "--host", http.host, "--port", String(http.port), "--token", token],
		{
			stdio: ["ignore", logFd, logFd],
			detached: true,
			env: process.env,
		},
	);
	// Detach fully: this process must survive pi's own exit, and Node keeps
	// the event loop alive for a still-referenced child otherwise.
	child.unref();
	await logHandle.close();
}

/**
 * Ensures a read-only HTTP hub answering pi-palace's own token is reachable
 * at `settings.mcp.http`, spawning one if needed. Returns a ready-to-use
 * handle, or throws `HubTokenConflictError` if a *different* hub already
 * owns that host:port.
 */
export async function ensureHubRunning(http: McpHttpSettings): Promise<HubHandle> {
	const baseUrl = `http://${http.host}:${http.port}`;
	const token = await readOrCreateHubToken();

	const liveness = await probeHealth(baseUrl, null, HEALTH_TIMEOUT_MS);
	if (liveness === "ok") {
		const auth = await probeAuth(baseUrl, token, HEALTH_TIMEOUT_MS);
		if (auth === "ok") return { baseUrl, token };
		if (auth === "unauthorized") throw new HubTokenConflictError(baseUrl);
		// "unreachable" here (health ok, tools/list not) is unexpected but not
		// fatal — fall through and let the caller's next request surface it.
		return { baseUrl, token };
	}

	await spawnHub(http, token);

	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const health = await probeHealth(baseUrl, null, HEALTH_TIMEOUT_MS);
		if (health === "ok") return { baseUrl, token };
		await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_INTERVAL_MS));
	}
	throw new Error(`MemPalace HTTP hub did not become ready at ${baseUrl} within ${STARTUP_TIMEOUT_MS}ms`);
}
