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

export interface SubmitMcpToolJobResult {
	success: boolean;
	jobId?: string;
	state?: string;
	error?: string;
}

/**
 * Outcome of a blocking (`wait:true`, `stop_on_lock_deferral:true`) daemon job
 * submission — see `submitMcpToolJobWaiting`. A discriminated union instead
 * of a single result shape so callers are forced to handle the "deferred by
 * the palace write lock" case explicitly rather than mistaking it for either
 * a normal success or a normal failure.
 */
export type DaemonJobOutcome =
	| { kind: "succeeded"; result: Record<string, unknown> }
	| { kind: "lockedByMine" }
	| { kind: "failed"; error: string };

/**
 * Raw shape of a job dict as returned by the daemon HTTP API / `submit_job`
 * (see `daemon.py`'s `job_to_dict` and `job_deferred_by_lock`) — the subset
 * this client actually reads.
 */
export interface RawDaemonJob {
	state?: string;
	result?: Record<string, unknown> | null;
	error?: { error_class?: string; message?: string } | null;
}

/**
 * Classifies a raw daemon job dict into a `DaemonJobOutcome`, mirroring
 * `daemon.py`'s own `job_deferred_by_lock` logic: a job is "deferred by the
 * palace write lock" (not failed, not succeeded) when it's back in `queued`
 * state with `error.error_class === "LockHeldByOtherProcess"` — the state
 * `client.wait(..., stop_on_lock_deferral=True)` returns early with instead
 * of blocking through the whole duration of whatever else is holding the
 * lock (typically a mine). Pulled out as a pure function so the mapping is
 * unit-testable without spawning python/the daemon.
 */
export function classifyDaemonJobOutcome(job: RawDaemonJob): DaemonJobOutcome {
	if (job.state === "queued" && job.error?.error_class === "LockHeldByOtherProcess") {
		return { kind: "lockedByMine" };
	}
	if (job.state === "succeeded") {
		return { kind: "succeeded", result: job.result ?? {} };
	}
	return { kind: "failed", error: job.error?.message ?? "job failed" };
}

/**
 * Point 6 — known MemPalace/daemon failure signatures, classified from a
 * raw error message so callers (currently `triggerCheckpoint` in index.ts)
 * can show an actionable toast instead of a generic one. Pattern-matched
 * against whatever string ends up in the error (JSON-RPC error message from
 * `persistent-mcp-client.ts`, a `DaemonError` string, or `classifyDaemonJobOutcome`'s
 * own `failed`/`lockedByMine` messages) — there is no structured error code
 * threaded all the way through every path, so this is deliberately a
 * best-effort string match, not an exhaustive parser.
 */
export type MempalaceErrorKind = "staleLibrary" | "indexCorrupt" | "lockedByMine" | "daemonUnavailable" | "unknown";

const ERROR_PATTERNS: Array<{ kind: MempalaceErrorKind; pattern: RegExp }> = [
	// -32005: a write tool refused because the MCP server's loaded library no
	// longer matches what's installed on disk (see mempalace_status's
	// library_versions.stale) — fixed by restarting the MCP server, not by
	// retrying the call.
	{ kind: "staleLibrary", pattern: /-32005|action_required.*restart_mcp_server|stale librar(y|ies)/i },
	// HNSW segment-writer / ChromaDB compaction errors, or a server that stays
	// "Not connected" after a write — the vector index is out of sync with
	// chroma.sqlite3; fixed with `mempalace repair --mode from-sqlite`, never
	// by re-mining (drops MCP-added drawers/diary entries).
	{ kind: "indexCorrupt", pattern: /HNSW|segment[- ]writer|compaction|not connected/i },
	// The palace write lock is held by another process (typically a mine) —
	// covers both classifyDaemonJobOutcome's lockedByMine wording and the
	// older direct-MCP "Peer MCP writer active" message this routing mostly
	// eliminated (see mcp-manager.ts) but which can still surface from paths
	// not yet migrated.
	{ kind: "lockedByMine", pattern: /LockHeldByOtherProcess|palace write lock held|Peer MCP writer active/i },
	{ kind: "daemonUnavailable", pattern: /daemon is not running|daemon did not become ready|ECONNREFUSED/i },
];

export function classifyMempalaceError(message: string): MempalaceErrorKind {
	for (const { kind, pattern } of ERROR_PATTERNS) {
		if (pattern.test(message)) return kind;
	}
	return "unknown";
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

/**
 * Submits an arbitrary write-classified MCP tool call as a daemon job
 * (`kind: "mcp_tool"`), instead of executing it directly against a
 * per-session `mempalace-light-mcp` process.
 *
 * Why this exists: the light MCP server each pi session opens tries to
 * acquire the palace's single-writer flock itself. When another process
 * already holds it (typically the daemon, mid-mine — a mine can run for a
 * long time), every OTHER session's mutating call (e.g. `/checkpoint`)
 * fails immediately with "Peer MCP writer active" instead of waiting its
 * turn — silently dropping the checkpoint (autosave runs in "silent" mode
 * by default). Routing through the daemon's job queue instead means the
 * call is durably queued and executed once the daemon is free, regardless
 * of how many pi/opencode sessions are open concurrently or how long a
 * mine is running.
 *
 * Deliberately `wait: false` (fire-and-forget submission, mirroring
 * submitDailyMineJob): a caller wanting a blocking checkpoint would stall
 * behind an arbitrarily long mine, which is worse than not knowing the
 * exact completion time. No `dedupe_key` is passed — unlike the daily mine
 * (one fixed key, intentionally collapsing duplicate daily runs), each
 * checkpoint call carries different content and must never be coalesced
 * with another one.
 */
export async function submitMcpToolJob(name: string, args: Record<string, unknown>): Promise<SubmitMcpToolJobResult> {
	const script = [
		"import json, sys",
		"from mempalace.daemon import submit_job, DaemonError",
		"payload = json.loads(sys.argv[1])",
		"try:",
		"    result = submit_job(",
		"        'mcp_tool',",
		"        {'name': payload['name'], 'arguments': payload['arguments']},",
		"        wait=False,",
		"        auto_start=True,",
		"    )",
		// wait=False returns the freshly-created job dict immediately (state
		// 'queued' or 'running'), not the tool's actual result — submission
		// itself succeeding is what we treat as success here.
		"    print(json.dumps({'success': True, 'job_id': result.get('id'), 'state': result.get('state')}))",
		"except DaemonError as exc:",
		"    print(json.dumps({'success': False, 'error': str(exc)}))",
	].join("\n");

	const payload = JSON.stringify({ name, arguments: args });

	try {
		const python = await resolveMempalacePython();
		const { stdout } = await execFileAsync(python, ["-c", script, payload], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
		const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
		const lastLine = lines[lines.length - 1];
		const parsed = JSON.parse(lastLine ?? "{}");
		return { success: Boolean(parsed.success), jobId: parsed.job_id, state: parsed.state, error: parsed.error };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; message?: string };
		return { success: false, error: e.stderr || e.message || "unknown error" };
	}
}

/**
 * Submits a write-classified MCP tool call to the daemon's job queue like
 * `submitMcpToolJob`, but BLOCKS for the real result instead of fire-and-
 * forgetting a "queued" acknowledgement.
 *
 * Callers that need this (the generic write-tool routing in
 * `mcp-manager.ts`, the audit/repair session, the checkpoint sub-agent's
 * knowledge-graph tools) have to know whether the write actually happened —
 * e.g. an interactive repair step needs to confirm a tunnel was really
 * deleted before asking the next question, and a KG fact write feeding back
 * into the same conversation needs its real outcome, not just a job id.
 *
 * Uses the daemon's own `wait=True, stop_on_lock_deferral=True` (see
 * `daemon.py`'s `DaemonClient.wait`): if the palace write lock is currently
 * held by another process (typically a mine), the call does NOT block for
 * the lock holder's entire duration — it returns as soon as the job comes
 * back deferred (`state: 'queued'`, `error.error_class:
 * 'LockHeldByOtherProcess'`), classified here as `{ kind: 'lockedByMine' }`
 * via `classifyDaemonJobOutcome`. Callers should surface that as "a mine is
 * currently running, try again later" rather than treating it as a normal
 * failure or retrying it themselves (the daemon already re-queues it on its
 * own backoff).
 *
 * Deliberately NOT used by `submitDailyMineJob` or the checkpoint autosave
 * path (`checkpoint-tool.ts`) — both keep the existing fire-and-forget
 * `submitMcpToolJob`/`wait:false` behavior on purpose, since neither wants
 * to stall a session turn behind an arbitrarily long job.
 */
export async function submitMcpToolJobWaiting(name: string, args: Record<string, unknown>): Promise<DaemonJobOutcome> {
	const script = [
		"import json, sys",
		"from mempalace.daemon import submit_job, DaemonError",
		"payload = json.loads(sys.argv[1])",
		"try:",
		"    job = submit_job(",
		"        'mcp_tool',",
		"        {'name': payload['name'], 'arguments': payload['arguments']},",
		"        wait=True,",
		"        stop_on_lock_deferral=True,",
		"        auto_start=True,",
		"    )",
		// The full job dict (state/result/error) — classifyDaemonJobOutcome reads
		// it directly, mirroring daemon.py's own job_deferred_by_lock check.
		"    print(json.dumps({'state': job.get('state'), 'result': job.get('result'), 'error': job.get('error')}))",
		"except DaemonError as exc:",
		"    print(json.dumps({'state': 'failed', 'result': None, 'error': {'message': str(exc)}}))",
	].join("\n");

	const payload = JSON.stringify({ name, arguments: args });

	try {
		const python = await resolveMempalacePython();
		// Generous timeout: unlike submitMcpToolJob (submission-only), this call
		// can legitimately wait for the tool's own execution time — bounded by
		// stop_on_lock_deferral against the one open-ended case (a concurrent
		// mine holding the lock).
		const { stdout } = await execFileAsync(python, ["-c", script, payload], { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
		const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
		const lastLine = lines[lines.length - 1];
		const job = JSON.parse(lastLine ?? "{}") as RawDaemonJob;
		return classifyDaemonJobOutcome(job);
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; message?: string };
		return { kind: "failed", error: e.stderr || e.message || "unknown error" };
	}
}
