import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

type SessionEntryLike = {
	id?: string;
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const p = part as { type?: string; text?: string };
			return p.type === "text" && typeof p.text === "string" ? p.text : "";
		})
		.join("\n")
		.trim();
}

export interface RelevantMessage {
	id?: string;
	role: "user" | "assistant";
	text: string;
}

/**
 * User messages that count towards the autosave interval: non-empty text,
 * not a slash command. We do not need an auto-save marker exclusion like
 * mempalace-pi does, because our injected checkpoint work never lands as a
 * visible user message in the main session (it runs in an isolated
 * sub-session instead).
 */
export function getRelevantUserMessages(entries: Iterable<SessionEntryLike>): RelevantMessage[] {
	const relevant: RelevantMessage[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "user") continue;
		const text = extractText(message.content);
		if (!text) continue;
		if (text.trim().startsWith("/")) continue;
		relevant.push({ id: entry.id, role: "user", text });
	}
	return relevant;
}

export function countRelevantUserMessages(ctx: Pick<ExtensionContext, "sessionManager">): number {
	return getRelevantUserMessages(ctx.sessionManager.getBranch()).length;
}

/**
 * Extracts the last N user/assistant exchanges (as plain text) from the
 * session branch, for feeding the isolated checkpoint sub-agent.
 */
export function extractRecentExchanges(entries: Iterable<SessionEntryLike>, sinceUserMessageCount: number): string {
	const all: RelevantMessage[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractText(entry.message?.content);
		if (!text) continue;
		if (role === "user" && text.trim().startsWith("/")) continue;
		all.push({ id: entry.id, role, text });
	}

	// Walk backwards, keep everything since we've seen `sinceUserMessageCount` user messages.
	let userSeen = 0;
	let startIndex = 0;
	for (let i = all.length - 1; i >= 0; i--) {
		if (all[i].role === "user") userSeen++;
		if (userSeen >= sinceUserMessageCount) {
			startIndex = i;
			break;
		}
	}

	return formatExchanges(all.slice(startIndex));
}

export function extractAllExchanges(entries: Iterable<SessionEntryLike>): string {
	const all: RelevantMessage[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractText(entry.message?.content);
		if (!text) continue;
		all.push({ id: entry.id, role, text });
	}
	return formatExchanges(all);
}

function formatExchanges(messages: RelevantMessage[]): string {
	return messages.map((m) => `[${m.role.toUpperCase()}]\n${m.text}`).join("\n\n---\n\n");
}
