import { describe, expect, test } from "bun:test";
import { resolveWakeUpWing } from "./wake-up.js";
import type { AutosaveSettings } from "./settings.js";

type Settings = Pick<AutosaveSettings, "userWing" | "injectWakeUp">;

function withSource(source: Settings["injectWakeUp"]["source"], userWing?: string, wing?: string): Settings {
	return {
		userWing,
		injectWakeUp: { enabled: true, mode: "sync", source, wing },
	};
}

describe("resolveWakeUpWing", () => {
	test('source "user" returns userWing when set', () => {
		expect(resolveWakeUpWing(withSource("user", "romain"), "/tmp/some-project")).toBe("romain");
	});

	test('source "user" degrades to null when userWing is unset', () => {
		expect(resolveWakeUpWing(withSource("user", undefined), "/tmp/some-project")).toBeNull();
	});

	test('source "project" returns the cwd basename regardless of userWing', () => {
		expect(resolveWakeUpWing(withSource("project", "romain"), "/tmp/some-project")).toBe("some-project");
	});

	test('source "custom" returns the configured wing when set', () => {
		expect(resolveWakeUpWing(withSource("custom", "romain", "custom-wing"), "/tmp/some-project")).toBe("custom-wing");
	});

	test('source "custom" degrades to userWing when wing is unset', () => {
		expect(resolveWakeUpWing(withSource("custom", "romain", undefined), "/tmp/some-project")).toBe("romain");
	});

	test('source "custom" degrades to null when neither wing nor userWing is set', () => {
		expect(resolveWakeUpWing(withSource("custom", undefined, undefined), "/tmp/some-project")).toBeNull();
	});

	test("source null always returns null", () => {
		expect(resolveWakeUpWing(withSource(null, "romain"), "/tmp/some-project")).toBeNull();
	});
});
