import { describe, expect, test } from "bun:test";

// Smoke test: valide que l'outillage bun:test tourne correctement
// sur ce projet (TS strict, imports .ts). À étoffer avec de vrais
// cas de counter.ts une fois le périmètre de tests décidé.
describe("tooling smoke test", () => {
	test("bun test runner works", () => {
		expect(1 + 1).toBe(2);
	});
});
