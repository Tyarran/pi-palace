/**
 * Test helper: a fake MCP stdio server installed on PATH under the names of
 * the real binaries (`mempalace-light-mcp`, `mempalace-mcp`), so code that
 * spawns them by bare command name can be exercised without MemPalace.
 *
 * Behavior is controlled through environment variables (inherited by the
 * spawned process, so tests set them on `process.env` before the call):
 * - FAKE_MCP_FAIL_CALL=1: answer every `tools/call` with a JSON-RPC error.
 * - FAKE_MCP_HANG=1: never answer anything (initialize included).
 * Every start appends a line to $SPAWN_LOG and the pid to $FAKE_MCP_PID_LOG
 * (both set by `installFakeMcp`).
 */
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER_SOURCE = `
const { appendFileSync } = require("node:fs");
if (process.env.SPAWN_LOG) appendFileSync(process.env.SPAWN_LOG, "spawn\\n");
if (process.env.FAKE_MCP_PID_LOG) appendFileSync(process.env.FAKE_MCP_PID_LOG, process.pid + "\\n");
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let idx;
	while ((idx = buffer.indexOf("\\n")) !== -1) {
		const line = buffer.slice(0, idx).trim();
		buffer = buffer.slice(idx + 1);
		if (!line || process.env.FAKE_MCP_HANG) continue;
		const req = JSON.parse(line);
		if (req.id === undefined) continue;
		if (req.method === "initialize") {
			send({ id: req.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "0" } } });
		} else if (req.method === "tools/list") {
			send({ id: req.id, result: { tools: [{ name: "palace_query", description: "fake query", inputSchema: { type: "object", properties: {} } }] } });
		} else if (req.method === "tools/call") {
			if (process.env.FAKE_MCP_FAIL_CALL) send({ id: req.id, error: { code: -32000, message: "boom" } });
			else send({ id: req.id, result: { content: [{ type: "text", text: JSON.stringify(req.params.arguments) }] } });
		}
	}
});
process.stdin.on("end", () => process.exit(0));
`;

export interface FakeMcp {
	/** Number of processes started so far. */
	spawnCount(): number;
	/** Pids of every process started so far. */
	pids(): number[];
	/** Removes the fake binaries, restores PATH and clears the env switches. */
	restore(): Promise<void>;
}

export async function installFakeMcp(names: string[] = ["mempalace-light-mcp", "mempalace-mcp"]): Promise<FakeMcp> {
	const dir = await mkdtemp(join(tmpdir(), "pi-palace-fake-mcp-"));
	const spawnLog = join(dir, "spawn.log");
	const pidLog = join(dir, "pid.log");
	await writeFile(spawnLog, "");
	await writeFile(pidLog, "");
	for (const name of names) {
		const file = join(dir, name);
		await writeFile(file, `#!${process.execPath}\n${SERVER_SOURCE}`);
		await chmod(file, 0o755);
	}
	const saved = {
		PATH: process.env.PATH,
		SPAWN_LOG: process.env.SPAWN_LOG,
		FAKE_MCP_PID_LOG: process.env.FAKE_MCP_PID_LOG,
	};
	process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
	process.env.SPAWN_LOG = spawnLog;
	process.env.FAKE_MCP_PID_LOG = pidLog;
	const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);
	return {
		spawnCount: () => lines(spawnLog).length,
		pids: () => lines(pidLog).map(Number),
		async restore() {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			delete process.env.FAKE_MCP_FAIL_CALL;
			delete process.env.FAKE_MCP_HANG;
			await rm(dir, { recursive: true, force: true });
		},
	};
}

/** True while a process with this pid still exists. */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Resolves once the pid is gone (polling), or rejects after `timeoutMs`. */
export async function waitForExit(pid: number, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (isAlive(pid)) {
		if (Date.now() - start > timeoutMs) throw new Error(`process ${pid} still alive after ${timeoutMs}ms`);
		await new Promise((r) => setTimeout(r, 10));
	}
}
