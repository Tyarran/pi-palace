import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DailyMineState {
	lastAttemptDate: string; // YYYY-MM-DD, written as soon as a run is decided
	lastSuccessDate?: string; // YYYY-MM-DD, written only on success
}

// Same state directory convention as the official mempal_save_hook.sh
// (~/.mempalace/hook_state/) — consistent with the rest of the MemPalace
// ecosystem rather than inventing a new location.
const STATE_PATH = join(homedir(), ".mempalace", "hook_state", "pi-palace-daily-mine.json");

export function todayISO(): string {
	const now = new Date();
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

export async function readState(): Promise<DailyMineState | null> {
	try {
		const text = await readFile(STATE_PATH, "utf8");
		const parsed = JSON.parse(text);
		if (typeof parsed?.lastAttemptDate === "string") return parsed as DailyMineState;
		return null;
	} catch {
		return null;
	}
}

export async function writeState(state: DailyMineState): Promise<void> {
	await mkdir(dirname(STATE_PATH), { recursive: true });
	await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}
