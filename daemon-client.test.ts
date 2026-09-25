import { describe, expect, test } from "bun:test";
import { classifyDaemonJobOutcome, classifyMempalaceError } from "./daemon-client.js";

describe("classifyDaemonJobOutcome", () => {
	test("succeeded job returns its result payload", () => {
		const outcome = classifyDaemonJobOutcome({ state: "succeeded", result: { success: true, drawer_id: "drw_1" } });
		expect(outcome).toEqual({ kind: "succeeded", result: { success: true, drawer_id: "drw_1" } });
	});

	test("succeeded job with no result defaults to an empty object", () => {
		const outcome = classifyDaemonJobOutcome({ state: "succeeded", result: null });
		expect(outcome).toEqual({ kind: "succeeded", result: {} });
	});

	test("queued job deferred by the palace write lock is classified as lockedByMine", () => {
		const outcome = classifyDaemonJobOutcome({
			state: "queued",
			error: { error_class: "LockHeldByOtherProcess", message: "palace write lock held by another process" },
		});
		expect(outcome).toEqual({ kind: "lockedByMine" });
	});

	test("queued job with a different error class is not mistaken for a lock deferral", () => {
		const outcome = classifyDaemonJobOutcome({ state: "queued", error: { error_class: "SomethingElse", message: "boom" } });
		expect(outcome.kind).toBe("failed");
	});

	test("failed job surfaces the error message", () => {
		const outcome = classifyDaemonJobOutcome({ state: "failed", error: { message: "boom" } });
		expect(outcome).toEqual({ kind: "failed", error: "boom" });
	});

	test("failed job with no error message falls back to a generic message", () => {
		const outcome = classifyDaemonJobOutcome({ state: "failed" });
		expect(outcome).toEqual({ kind: "failed", error: "job failed" });
	});
});

describe("classifyMempalaceError", () => {
	test("detects a stale-library gate error (-32005)", () => {
		expect(classifyMempalaceError("MCP tools/call(mempalace_checkpoint) failed: -32005 stale library, action_required: restart_mcp_server")).toBe(
			"staleLibrary",
		);
	});

	test("detects a corrupted vector index (HNSW segment-writer error)", () => {
		expect(classifyMempalaceError("HNSW segment-writer error during compaction")).toBe("indexCorrupt");
	});

	test('detects a server that stays "Not connected" after a write', () => {
		expect(classifyMempalaceError("Not connected")).toBe("indexCorrupt");
	});

	test("detects the palace write lock being held by another process", () => {
		expect(classifyMempalaceError("palace write lock held by another process")).toBe("lockedByMine");
	});

	test('detects the legacy "Peer MCP writer active" message', () => {
		expect(classifyMempalaceError("Peer MCP writer active")).toBe("lockedByMine");
	});

	test("detects an unreachable daemon", () => {
		expect(classifyMempalaceError("daemon is not running")).toBe("daemonUnavailable");
	});

	test("falls back to unknown for an unrecognized message", () => {
		expect(classifyMempalaceError("something unrelated went wrong")).toBe("unknown");
	});
});
