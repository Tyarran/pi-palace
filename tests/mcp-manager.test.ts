import { describe, expect, test } from "bun:test";
import { isReadOnlyCoordinateCall, isReadOnlyTool } from "../src/mcp-manager.js";

describe("isReadOnlyTool", () => {
	test("classifies the mempalace-light unified query tool as read-only", () => {
		// Regression: palace_query is the only mempalace-light tool name that
		// isn't in the mempalace-full 45-tool list this Set was originally
		// built from — omitting it silently daemon-routed every read.
		expect(isReadOnlyTool("palace_query")).toBe(true);
	});

	test("classifies known mempalace-full read tools as read-only", () => {
		expect(isReadOnlyTool("mempalace_search")).toBe(true);
		expect(isReadOnlyTool("mempalace_status")).toBe(true);
	});

	test("does not classify palace_exec as read-only (always a write)", () => {
		expect(isReadOnlyTool("palace_exec")).toBe(false);
	});

	test("does not classify palace_coordinate as read-only by name alone", () => {
		// palace_coordinate is mixed read/write — isReadOnlyTool (name-only)
		// must never green-light it; isReadOnlyCoordinateCall handles it
		// instead, based on the call's actual action/command.
		expect(isReadOnlyTool("palace_coordinate")).toBe(false);
	});

	test("fail-safe: unknown tool names are treated as writes", () => {
		expect(isReadOnlyTool("mempalace_some_future_tool")).toBe(false);
	});
});

describe("isReadOnlyCoordinateCall", () => {
	test("action field: recognizes read actions", () => {
		expect(isReadOnlyCoordinateCall({ action: "event_list" })).toBe(true);
		expect(isReadOnlyCoordinateCall({ action: "event_wait" })).toBe(true);
		expect(isReadOnlyCoordinateCall({ action: "mesh_peers" })).toBe(true);
		expect(isReadOnlyCoordinateCall({ action: "artifact_get" })).toBe(true);
		expect(isReadOnlyCoordinateCall({ action: "inbox" })).toBe(true);
	});

	test("action field: is case-insensitive", () => {
		expect(isReadOnlyCoordinateCall({ action: "EVENT_LIST" })).toBe(true);
	});

	test("action field: recognizes write actions as non-read-only", () => {
		expect(isReadOnlyCoordinateCall({ action: "task_create" })).toBe(false);
		expect(isReadOnlyCoordinateCall({ action: "event_append" })).toBe(false);
		expect(isReadOnlyCoordinateCall({ action: "event_ack" })).toBe(false);
		expect(isReadOnlyCoordinateCall({ action: "artifact_put" })).toBe(false);
		expect(isReadOnlyCoordinateCall({ action: "patch_submit" })).toBe(false);
	});

	test("command DSL: recognizes read commands", () => {
		expect(isReadOnlyCoordinateCall({ command: "EVENT LIST stream:project/x LIMIT 5" })).toBe(true);
		expect(isReadOnlyCoordinateCall({ command: "event wait correlation:task_1" })).toBe(true);
		expect(isReadOnlyCoordinateCall({ command: "EVENT INBOX to:agent" })).toBe(true);
		expect(isReadOnlyCoordinateCall({ command: "MESH PEERS" })).toBe(true);
		expect(isReadOnlyCoordinateCall({ command: "ARTIFACT GET id:art_1" })).toBe(true);
	});

	test("command DSL: recognizes write commands as non-read-only", () => {
		expect(isReadOnlyCoordinateCall({ command: 'TASK CREATE project:x from:a to:b goal:"g" branch:b base:c done:"d"' })).toBe(
			false,
		);
		expect(isReadOnlyCoordinateCall({ command: "EVENT APPEND type:task.request" })).toBe(false);
		expect(isReadOnlyCoordinateCall({ command: "EVENT ACK id:evt_1 from:a status:applied" })).toBe(false);
		expect(isReadOnlyCoordinateCall({ command: "PATCH SUBMIT ..." })).toBe(false);
	});

	test("fail-safe: missing/malformed action and command are treated as writes", () => {
		expect(isReadOnlyCoordinateCall({})).toBe(false);
		expect(isReadOnlyCoordinateCall({ action: 123 })).toBe(false);
		expect(isReadOnlyCoordinateCall({ command: 456 })).toBe(false);
	});
});
