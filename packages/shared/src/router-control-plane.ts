import {
	AGENT_COMBOS,
	AGENT_ROUTER_PROFILES,
	AGENT_TIER_ORDER,
	type AgentCombo,
	type AgentRoutingTier,
	FALLBACK_RULES,
} from "./agent-router";
import {
	AGENT_CAPABILITY_REGISTRY,
	type AgentCapability,
	type SpecialistAgentType,
} from "./agent-routing";
import {
	formatTokenCutNotice,
	type TokenCutOptions,
	type TokenCutResult,
	tokenCut,
} from "./token-cut";

export type RouterProviderConnection =
	| "agent-runtime"
	| "openai-compatible"
	| "oauth"
	| "local"
	| "media"
	| "search";

export type RouterProviderStatus =
	| "native"
	| "key-ready"
	| "oauth-ready"
	| "catalog";

export interface RouterProviderCatalogItem {
	id: string;
	label: string;
	tier: AgentRoutingTier | "media" | "search" | "local";
	connection: RouterProviderConnection;
	status: RouterProviderStatus;
	auth: "built-in" | "api-key" | "oauth" | "local";
	keyProvider?: string;
	capabilities: string[];
	defaultModels: string[];
	notes: string;
}

export interface RouterEndpoint {
	path: string;
	method: "GET" | "POST";
	compatibility: "OpenAI" | "Anthropic" | "Router";
	capability: string;
	status: "native-dashboard" | "gateway-catalogued";
}

export type RouterTokenSaverMode = "rtk" | "headroom" | "caveman" | "ponytail";

export interface RouterTokenSaver {
	mode: RouterTokenSaverMode;
	label: string;
	description: string;
	status: "native";
}

export interface RouterTokenSaverPreview {
	mode: RouterTokenSaverMode;
	result: TokenCutResult;
	notice: string | null;
}

export interface RouterFeature {
	id: string;
	label: string;
	status: "active" | "native-ui" | "router-core" | "catalogued";
	description: string;
}

export interface RouterProviderSnapshot extends RouterProviderCatalogItem {
	keyConfigured: boolean | null;
	agent?: SpecialistAgentType;
	modelId?: string;
	contextWindow?: number;
	quotaHint?: string;
}

export interface RouterDashboardSnapshot {
	generatedAt: string;
	stats: {
		providers: number;
		nativeAgents: number;
		combos: number;
		endpoints: number;
		tokenSavers: number;
		fallbackRules: number;
	};
	providers: RouterProviderSnapshot[];
	combos: AgentCombo[];
	profiles: typeof AGENT_ROUTER_PROFILES;
	capabilities: Record<SpecialistAgentType, AgentCapability[]>;
	endpoints: RouterEndpoint[];
	tokenSavers: RouterTokenSaver[];
	fallbackRules: typeof FALLBACK_RULES;
	features: RouterFeature[];
	tierOrder: typeof AGENT_TIER_ORDER;
}

export const ROUTER_PROVIDER_CATALOG: RouterProviderCatalogItem[] = [
	{
		id: "claude-code",
		label: "Claude Code",
		tier: "subscription",
		connection: "agent-runtime",
		status: "native",
		auth: "built-in",
		capabilities: ["coding", "architecture", "review"],
		defaultModels: ["claude-code"],
		notes: "Primary subscription runtime for careful design and review work.",
	},
	{
		id: "codex-cli",
		label: "Codex CLI",
		tier: "subscription",
		connection: "agent-runtime",
		status: "native",
		auth: "built-in",
		capabilities: ["coding", "debugging", "windows", "frontend"],
		defaultModels: ["gpt-5.5-codex"],
		notes: "Hands-on executor for repo edits, shell work, and verification.",
	},
	{
		id: "gemini-cli",
		label: "Gemini CLI",
		tier: "subscription",
		connection: "agent-runtime",
		status: "native",
		auth: "built-in",
		capabilities: ["large-context", "research", "review"],
		defaultModels: ["gemini-cli"],
		notes: "Broad context scanner for large repositories and docs.",
	},
	{
		id: "github-copilot",
		label: "GitHub Copilot",
		tier: "subscription",
		connection: "agent-runtime",
		status: "native",
		auth: "built-in",
		capabilities: ["coding", "frontend"],
		defaultModels: ["github-copilot"],
		notes: "GitHub-linked coding fallback when installed.",
	},
	{
		id: "cursor",
		label: "Cursor",
		tier: "subscription",
		connection: "agent-runtime",
		status: "native",
		auth: "built-in",
		capabilities: ["coding", "frontend", "ui-iteration"],
		defaultModels: ["cursor-agent"],
		notes: "Useful when a task benefits from Cursor-native iteration.",
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		tier: "cheap",
		connection: "openai-compatible",
		status: "key-ready",
		auth: "api-key",
		keyProvider: "openrouter",
		capabilities: ["chat", "coding", "fallback", "model-market"],
		defaultModels: [
			"z-ai/glm-5.2",
			"minimax/minimax-m3",
			"moonshotai/kimi-k2.7-code",
		],
		notes: "Cheap fallback layer used by GLM, MiniMax, and Kimi runtimes.",
	},
	{
		id: "opencode",
		label: "OpenCode",
		tier: "free",
		connection: "local",
		status: "native",
		auth: "local",
		capabilities: ["coding", "local", "free-fallback"],
		defaultModels: ["opencode-local"],
		notes: "Local/free emergency fallback for simple implementation tasks.",
	},
	{
		id: "anthropic",
		label: "Anthropic API",
		tier: "subscription",
		connection: "openai-compatible",
		status: "catalog",
		auth: "api-key",
		capabilities: ["chat", "messages", "tool-use", "vision"],
		defaultModels: ["claude-sonnet-4.5", "claude-opus-4.5"],
		notes: "Catalogued for the OpenAI/Anthropic translator layer.",
	},
	{
		id: "openai",
		label: "OpenAI API",
		tier: "subscription",
		connection: "openai-compatible",
		status: "catalog",
		auth: "api-key",
		capabilities: ["responses", "chat", "images", "audio", "embeddings"],
		defaultModels: ["gpt-5.2", "gpt-5.2-codex"],
		notes: "Catalogued for Responses and Chat Completions compatibility.",
	},
	{
		id: "ollama",
		label: "Ollama",
		tier: "local",
		connection: "local",
		status: "catalog",
		auth: "local",
		capabilities: ["local-chat", "embeddings"],
		defaultModels: ["llama", "qwen", "deepseek-coder"],
		notes: "Local model provider for offline or private routing.",
	},
	{
		id: "perplexity",
		label: "Perplexity",
		tier: "search",
		connection: "search",
		status: "catalog",
		auth: "api-key",
		capabilities: ["search", "research", "citations"],
		defaultModels: ["sonar"],
		notes: "Search-backed research provider.",
	},
	{
		id: "brave-search",
		label: "Brave Search",
		tier: "search",
		connection: "search",
		status: "catalog",
		auth: "api-key",
		capabilities: ["web-search"],
		defaultModels: ["brave-search"],
		notes: "Search provider for router-side web lookup tools.",
	},
	{
		id: "elevenlabs",
		label: "ElevenLabs",
		tier: "media",
		connection: "media",
		status: "catalog",
		auth: "api-key",
		capabilities: ["tts", "speech"],
		defaultModels: ["elevenlabs-tts"],
		notes: "Media provider catalogued for audio generation.",
	},
	{
		id: "stability-ai",
		label: "Stability AI",
		tier: "media",
		connection: "media",
		status: "catalog",
		auth: "api-key",
		capabilities: ["image-generation"],
		defaultModels: ["stable-image"],
		notes: "Media provider catalogued for image generation routes.",
	},
];

export const ROUTER_ENDPOINTS: RouterEndpoint[] = [
	{
		path: "/v1/models",
		method: "GET",
		compatibility: "OpenAI",
		capability: "Model catalogue",
		status: "native-dashboard",
	},
	{
		path: "/v1/chat/completions",
		method: "POST",
		compatibility: "OpenAI",
		capability: "Chat and coding proxy",
		status: "gateway-catalogued",
	},
	{
		path: "/v1/responses",
		method: "POST",
		compatibility: "OpenAI",
		capability: "Responses API proxy",
		status: "gateway-catalogued",
	},
	{
		path: "/v1/messages",
		method: "POST",
		compatibility: "Anthropic",
		capability: "Claude Messages proxy",
		status: "gateway-catalogued",
	},
	{
		path: "/v1/messages/count_tokens",
		method: "POST",
		compatibility: "Anthropic",
		capability: "Token counting",
		status: "gateway-catalogued",
	},
	{
		path: "/v1/images/generations",
		method: "POST",
		compatibility: "OpenAI",
		capability: "Image generation",
		status: "gateway-catalogued",
	},
	{
		path: "/v1/audio/speech",
		method: "POST",
		compatibility: "OpenAI",
		capability: "Text to speech",
		status: "gateway-catalogued",
	},
	{
		path: "/v1/audio/transcriptions",
		method: "POST",
		compatibility: "OpenAI",
		capability: "Speech to text",
		status: "gateway-catalogued",
	},
	{
		path: "/v1/embeddings",
		method: "POST",
		compatibility: "OpenAI",
		capability: "Embeddings",
		status: "gateway-catalogued",
	},
	{
		path: "/v1/compress",
		method: "POST",
		compatibility: "Router",
		capability: "Token saver compression",
		status: "native-dashboard",
	},
];

export const TOKEN_SAVER_MODES = [
	"rtk",
	"headroom",
	"caveman",
	"ponytail",
] as const satisfies readonly RouterTokenSaverMode[];

export const ROUTER_TOKEN_SAVERS: RouterTokenSaver[] = [
	{
		mode: "rtk",
		label: "RTK token-cut",
		description:
			"Detects diffs, status output, grep/find lists, logs, and builds.",
		status: "native",
	},
	{
		mode: "headroom",
		label: "Headroom",
		description:
			"Keeps tighter context windows so fallbacks have room to answer.",
		status: "native",
	},
	{
		mode: "caveman",
		label: "Caveman Mode",
		description:
			"Removes polite filler and keeps terse, command-focused content.",
		status: "native",
	},
	{
		mode: "ponytail",
		label: "Ponytail",
		description:
			"Keeps the head and recent tail, tuned for long agent transcripts.",
		status: "native",
	},
];

export const ROUTER_FEATURES: RouterFeature[] = [
	{
		id: "orchestrator-runtime",
		label: "Orchestrator runtime",
		status: "active",
		description: "Default agent coordinates specialist runtimes by intent.",
	},
	{
		id: "combo-routing",
		label: "Combos and tiers",
		status: "router-core",
		description:
			"Subscription, cheap, and free fallback chains with fusion review.",
	},
	{
		id: "token-savers",
		label: "Token savers",
		status: "active",
		description: "RTK, Headroom, Caveman, and Ponytail compression modes.",
	},
	{
		id: "provider-catalog",
		label: "Provider catalog",
		status: "native-ui",
		description:
			"9router-style provider catalogue exposed in the native dashboard.",
	},
	{
		id: "fallback-classifier",
		label: "Fallback classifier",
		status: "router-core",
		description:
			"Rate limit, quota, auth, capacity, and HTTP failure backoff rules.",
	},
	{
		id: "native-dashboard",
		label: "Native dashboard",
		status: "active",
		description:
			"Control plane lives inside ADE instead of a localhost web UI.",
	},
];

const PROVIDER_TO_AGENT: Record<string, SpecialistAgentType | undefined> = {
	"claude-code": "claude",
	"codex-cli": "codex",
	"gemini-cli": "gemini",
	"github-copilot": "copilot",
	cursor: "cursor-agent",
	openrouter: "glm",
	opencode: "opencode",
};

export function buildRouterDashboardSnapshot({
	providerKeyStatus = {},
	now = new Date(),
}: {
	providerKeyStatus?: Record<string, boolean | undefined>;
	now?: Date;
} = {}): RouterDashboardSnapshot {
	const providers = ROUTER_PROVIDER_CATALOG.map((provider) => {
		const agent = PROVIDER_TO_AGENT[provider.id];
		const profile = agent ? AGENT_ROUTER_PROFILES[agent] : undefined;
		const keyConfigured = provider.keyProvider
			? providerKeyStatus[provider.keyProvider] === true
			: null;

		return {
			...provider,
			keyConfigured,
			agent,
			modelId: profile?.modelId,
			contextWindow: profile?.contextWindow,
			quotaHint: profile?.quotaHint,
		};
	});

	return {
		generatedAt: now.toISOString(),
		stats: {
			providers: providers.length,
			nativeAgents: Object.keys(AGENT_ROUTER_PROFILES).length,
			combos: Object.keys(AGENT_COMBOS).length,
			endpoints: ROUTER_ENDPOINTS.length,
			tokenSavers: ROUTER_TOKEN_SAVERS.length,
			fallbackRules: FALLBACK_RULES.length,
		},
		providers,
		combos: Object.values(AGENT_COMBOS),
		profiles: AGENT_ROUTER_PROFILES,
		capabilities: Object.fromEntries(
			Object.entries(AGENT_CAPABILITY_REGISTRY).map(([agent, profile]) => [
				agent,
				profile.capabilities,
			]),
		) as Record<SpecialistAgentType, AgentCapability[]>,
		endpoints: ROUTER_ENDPOINTS,
		tokenSavers: ROUTER_TOKEN_SAVERS,
		fallbackRules: FALLBACK_RULES,
		features: ROUTER_FEATURES,
		tierOrder: AGENT_TIER_ORDER,
	};
}

export function previewRouterTokenSaver({
	text,
	mode = "rtk",
	options,
}: {
	text: string;
	mode?: RouterTokenSaverMode;
	options?: TokenCutOptions;
}): RouterTokenSaverPreview {
	const result = applyRouterTokenSaver(text, mode, options);
	return {
		mode,
		result,
		notice: result.changed ? formatTokenCutNotice(result) : null,
	};
}

export function applyRouterTokenSaver(
	text: string,
	mode: RouterTokenSaverMode,
	options: TokenCutOptions = {},
): TokenCutResult {
	switch (mode) {
		case "rtk":
			return tokenCut(text, options);
		case "headroom":
			return tokenCut(text, {
				minSize: 200,
				headLines: 80,
				tailLines: 40,
				...options,
			});
		case "caveman":
			return compactCaveman(text, options);
		case "ponytail":
			return compactPonytail(text, options);
	}
}

function compactCaveman(
	text: string,
	options: TokenCutOptions,
): TokenCutResult {
	const terse = text
		.split("\n")
		.filter((line) => {
			const value = line.trim();
			if (!value) return true;
			return !/^(certainly|sure|thanks|thank you|please note|here is|here are|i will|i can|let me)\b/i.test(
				value,
			);
		})
		.join("\n");

	const cut = tokenCut(terse, {
		minSize: 200,
		headLines: 80,
		tailLines: 50,
		...options,
	});

	if (cut.changed || terse !== text) {
		return toResult(text, cut.text, "smart-truncate");
	}
	return cut;
}

function compactPonytail(
	text: string,
	options: TokenCutOptions,
): TokenCutResult {
	const lines = text.split("\n");
	const headLines = options.headLines ?? 60;
	const tailLines = options.tailLines ?? 140;

	if (lines.length <= headLines + tailLines + 1) {
		return tokenCut(text, options);
	}

	const next = [
		...lines.slice(0, headLines),
		`[token-cut ponytail omitted ${lines.length - headLines - tailLines} middle lines]`,
		...lines.slice(-tailLines),
	].join("\n");

	return toResult(text, next, "smart-truncate");
}

function toResult(
	original: string,
	next: string,
	filter: TokenCutResult["filter"],
): TokenCutResult {
	if (next.length >= original.length) {
		return {
			text: original,
			changed: false,
			filter: null,
			bytesBefore: original.length,
			bytesAfter: original.length,
			savedBytes: 0,
		};
	}

	return {
		text: next,
		changed: true,
		filter,
		bytesBefore: original.length,
		bytesAfter: next.length,
		savedBytes: original.length - next.length,
	};
}
