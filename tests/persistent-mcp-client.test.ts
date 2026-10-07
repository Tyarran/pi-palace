import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type FakeMcp, installFakeMcp } from "./helpers/fake-mcp-server.js";

let fake: FakeMcp;

beforeEach(async () => {
	fake = await installFakeMcp();
});

afterEach(async () => {
	await fake.restore();
});

describe("PersistentMcpClient — call timeout timer", () => {
	test("does not keep the process alive after a response arrived and the client was closed", async () => {
		// The 30s per-call timeout used to stay armed after the response came
		// back, keeping the event loop (and thus `pi -p`) alive for 30s. Run the
		// client in a separate process and require it to exit well before that.
		const clientPath = join(__dirname, "../src/persistent-mcp-client.ts");
		const script = `
			import { PersistentMcpClient } from ${JSON.stringify(clientPath)};
			const client = new PersistentMcpClient("mempalace-light-mcp");
			await client.listTools();
			client.close();
		`;
		const started = Date.now();
		const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "pipe", env: process.env });
		const killer = setTimeout(() => proc.kill(), 8000);
		const code = await proc.exited;
		clearTimeout(killer);
		expect(code).toBe(0);
		expect(Date.now() - started).toBeLessThan(6000);
	}, 15000);
});
