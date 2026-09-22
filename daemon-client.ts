/**
 * Manages the MemPalace daemon lifecycle (check/start) and submits the
 * daily-mine job with a fixed dedupe_key, so concurrent pi sessions never
 * cause two identical mine jobs to run at once.
 *
 * dedupe_key is not exposed by the `mempalace mine` CLI (verified during
 * this session), only by the Python daemon.submit_job() API. We call it
 * directly via a small python -c script — daemon.py is a standalone module
 * without the "stdio protection" side effects that made mcp_server fragile
 * to import directly (see checkpoint-tool.ts's history: we moved away from
 * importing mcp_server internals for exactly that reason). daemon.py is
 * safe to import on its own.
 */
import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Resolves the Python interpreter that owns the `mempalace` package, via
 * the `mempalace` launcher's shebang (same strategy as mempalace-pi and the
 * official hook scripts) — avoids hardcoding a venv path that won't exist
 * on another machine/install.
 */
let cachedPython: string | undefined;
async function resolveMempalacePython(): Promise<string> {
	if (cachedPython) return cachedPython;
	const candidates = (process.env.PATH ?? "").split(delimiter);
	for (const dir of candidates) {
		if (!dir) continue;
		const launcher = join(dir, "mempalace");
		try {
			await access(launcher);
			const resolved = await realpath(launcher);
			const firstLine = (await readFile(resolved, "utf8")).split(/\r?\n/, 1)[0]?.trim() ?? "";
			if (firstLine.startsWith("#!")) {
				const parts = firstLine.slice(2).trim().split(/\s+/);
				const interpreter = parts[0] === "/usr/bin/env" ? parts.find((p) => /^python(?:3(?:\.\d+)?)?$/.test(p)) : parts[0];
				if (interpreter && isAbsolute(interpreter)) {
					await access(interpreter);
					cachedPython = interpreter;
					return interpreter;
				}
			}
		} catch {
			// try next PATH entry
		}
	}
	cachedPython = "python3"; // last-resort fallback
	return cachedPython;
}

const DAILY_MINE_DEDUPE_KEY = "pi-daily-sessions-mine";

export interface DaemonMineResult {
	success: boolean;
	error?: string;
}

async function runMempalaceCli(args: string[], timeoutMs = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await execFileAsync("mempalace", args, { timeout: timeoutMs });
		return { code: 0, stdout, stderr };
	} catch (err) {
		const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
		return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "unknown error" };
	}
}

export async function ensureDaemonRunning(): Promise<boolean> {
	const status = await runMempalaceCli(["daemon", "status"]);
	if (status.code === 0) return true; // already running

	const start = await runMempalaceCli(["daemon", "start"], 20_000);
	return start.code === 0;
}

/**
 * Submits the daily mine job WITHOUT waiting for it to complete
 * (wait=False). We only wait for the job to be *accepted into the queue*
 * (dedupe_key rejection is the only expected "failure" here besides a dead
 * daemon). This was a deliberate trade-off after testing: waiting
 * (wait=True) can block behind an arbitrarily long queue (e.g. a full
 * opencode-sessions mine ahead of it), which in turn delayed pi's own
 * process exit far longer than acceptable. The cost: we lose the
 * "finished" toast — success here means "submitted", not "completed".
 */
export async function submitDailyMineJob(sessionsDir: string, wing: string, limit: number): Promise<DaemonMineResult> {
	const script = [
		"import json, sys",
		"from mempalace.daemon import submit_job, DaemonError",
		"payload = json.loads(sys.argv[1])",
		"try:",
		"    result = submit_job(",
		"        'mine',",
		"        {",
		"            'source': payload['source'],",
		"            'mode': 'convos',",
		"            'wing': payload['wing'],",
		"            'agent': 'mempalace',",
		"            'dry_run': False,",
		"            'extract': 'exchange',",
		"            'include_ignored': [],",
		"            'limit': payload['limit'],",
		"            'max_chunks_per_file': None,",
		"            'no_gitignore': False,",
		"            'redetect_origin': False,",
		"        },",
		"        dedupe_key=payload['dedupe_key'],",
		"        wait=False,",
		"        auto_start=True,",
		"    )",
		// wait=False returns the freshly-created job dict immediately (state
		// 'queued' or 'running'), not a terminal state — submission itself
		// succeeding is what we treat as success.
		"    print(json.dumps({'success': True, 'job_id': result.get('id'), 'state': result.get('state')}))",
		"except DaemonError as exc:",
		"    print(json.dumps({'success': False, 'error': str(exc)}))",
	].join("\n");

	// limit follows mempalace mine's own --limit convention: 0 = unlimited.
	const payload = JSON.stringify({ source: sessionsDir, wing, limit, dedupe_key: DAILY_MINE_DEDUPE_KEY });

	try {
		const python = await resolveMempalacePython();
		// Submission itself is fast (no wait for job completion) — a generous
		// but bounded timeout here only guards against the python process
		// itself hanging unexpectedly (e.g. daemon socket issue), not against
		// the mine job's own duration.
		const { stdout } = await execFileAsync(python, ["-c", script, payload], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
		const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
		const lastLine = lines[lines.length - 1];
		const parsed = JSON.parse(lastLine ?? "{}");
		return { success: Boolean(parsed.success), error: parsed.error };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; message?: string };
		return { success: false, error: e.stderr || e.message || "unknown error" };
	}
}
