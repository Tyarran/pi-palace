import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createMempalaceCheckpointTool } from "./checkpoint-tool.js";
import type { McpManager } from "./mcp-manager.js";
import type { ModelSettings } from "./settings.js";

/**
 * Runs an isolated, in-memory Haiku sub-session to curate and file the given
 * conversation excerpt into MemPalace.
 *
 * Isolation is achieved via a DefaultResourceLoader with every discovery
 * flag disabled (noExtensions/noSkills/noPromptTemplates/noThemes/
 * noContextFiles) plus appendSystemPromptOverride — this sub-session never
 * loads the user's other extensions/MCP servers, skills, or context files,
 * and gets a fully replaced system prompt (no APPEND_SYSTEM.md pollution).
 *
 * authStorage/modelRegistry are intentionally NOT constructed here:
 * AuthStorage is not part of the export surface available to extension code
 * (credentials access is restricted), and createAgentSession() already
 * defaults both internally (AuthStorage.create(agentDir/auth.json)) when
 * omitted. The model is resolved by the caller via ctx.modelRegistry, which
 * IS part of the supported ExtensionContext API.
 */
export async function runCheckpointAgent(options: {
	conversationExcerpt: string;
	systemPrompt: string;
	cwd: string;
	model: Model<Api>;
	mcpManager: McpManager;
}): Promise<void> {
	const { conversationExcerpt, systemPrompt, cwd, model, mcpManager } = options;

	const checkpointTool = createMempalaceCheckpointTool(mcpManager);

	const agentDir = getAgentDir();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => systemPrompt,
		appendSystemPromptOverride: () => [],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		thinkingLevel: "off",
		sessionManager: SessionManager.inMemory(),
		resourceLoader,
		noTools: "builtin", // disable read/bash/edit/write, keep customTools active
		customTools: [checkpointTool],
	});

	try {
		await session.prompt(`Conversation excerpt to analyze:\n\n${conversationExcerpt}`);
	} finally {
		session.dispose();
	}
}

/**
 * Resolves the checkpoint sub-agent's model from user config. Deliberately
 * has NO hardcoded fallback (e.g. to Haiku) — an unconfigured or unknown
 * model returns undefined, and the caller (index.ts) treats that as
 * "disable checkpoint features", per the explicit-over-implicit decision
 * made when this became configurable (any provider, for genericity /
 * benchmarking other models).
 */
export function resolveConfiguredModel(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	modelSettings: ModelSettings | undefined,
): Model<Api> | undefined {
	if (!modelSettings) return undefined;
	return ctx.modelRegistry.find(modelSettings.provider, modelSettings.id);
}
