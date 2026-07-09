import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { AGENT_COMBOS } from "@superset/shared/agent-router";
import {
	buildGeminiModelList,
	buildOpenAIModelList,
	buildRouterModelInfo,
	previewRouterTokenSaver,
	ROUTER_MODEL_KIND_SLUGS,
	type RouterGatewayStatus,
	type RouterModelKind,
	type RouterModelResolutionOptions,
	type RouterModelTarget,
	type RouterModelTestResult,
	type RouterProviderKeyId,
	type RouterProviderNode,
	type RouterProviderNodeType,
	type RouterTokenSaverMode,
	resolveRouterModelTarget,
	routerModelKindsForSlug,
	TOKEN_SAVER_MODES,
} from "@superset/shared/router-control-plane";
import express, {
	type ErrorRequestHandler,
	type Response as ExpressResponse,
	type Request,
} from "express";
import {
	getProviderAccountCredentials,
	markProviderAccountFailure,
	markProviderAccountSuccess,
	type RouterProviderCredential,
} from "./agent-router-accounts";
import {
	clearRouterUsage,
	createRouterProviderNode,
	deleteRouterAlias,
	deleteRouterCustomCombo,
	deleteRouterCustomModel,
	deleteRouterProviderNode,
	disableRouterModels,
	enableRouterModels,
	estimateTokens,
	getRouterAliases,
	getRouterCustomCombos,
	getRouterCustomModels,
	getRouterDisabledModelMap,
	getRouterDisabledModels,
	getRouterModelAvailability,
	getRouterProviderNodes,
	getRouterUsageChart,
	getRouterUsageCompatStats,
	getRouterUsageLogs,
	getRouterUsageProviders,
	getRouterUsageStats,
	isRouterModelDisabled,
	type RouterUsagePeriod,
	recordRouterModelAvailability,
	recordRouterUsage,
	updateRouterProviderNode,
	upsertRouterAlias,
	upsertRouterCustomCombo,
	upsertRouterCustomModel,
} from "./agent-router-store";

export const DEFAULT_AGENT_ROUTER_GATEWAY_PORT = 20128;
const GATEWAY_HOST = "127.0.0.1";
const OPENROUTER_CHAT_COMPLETIONS_URL =
	"https://openrouter.ai/api/v1/chat/completions";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const PERPLEXITY_CHAT_COMPLETIONS_URL =
	"https://api.perplexity.ai/chat/completions";
const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

let server: Server | null = null;
let activePort = DEFAULT_AGENT_ROUTER_GATEWAY_PORT;
let startedAt: string | null = null;
let lastError: string | null = null;
let requestCount = 0;

type JsonObject = Record<string, unknown>;

interface OpenRouterSuccess {
	ok: true;
	account: RouterProviderCredential;
	upstream: globalThis.Response;
	target: RouterModelTarget;
	model: string;
}

interface ProviderNodeTarget {
	node: RouterProviderNode;
	model: string;
	requestedModel: string;
}

interface ProviderNodeSuccess {
	ok: true;
	account?: RouterProviderCredential;
	upstream: globalThis.Response;
	node: RouterProviderNode;
	model: string;
}

export interface RouterDiscoveredProviderNodeModel {
	id: string;
	name: string;
}

export interface RouterProviderNodeValidationInput {
	apiKey?: string;
	apiKeyAccountId?: string | null;
	apiKeyProvider?: RouterProviderKeyId;
	apiType?: "chat" | "responses";
	baseUrl?: string;
	id?: string;
	modelId?: string;
	type?: RouterProviderNodeType;
}

export interface RouterProviderNodeValidationResult {
	valid: boolean;
	error?: string;
	method?: "models" | "chat" | "responses" | "messages" | "embeddings";
	status?: number;
	dimensions?: number | null;
	models?: RouterDiscoveredProviderNodeModel[];
}

export interface RouterProviderNodeDiscoveryResult {
	ok: boolean;
	error?: string;
	status?: number;
	models: RouterDiscoveredProviderNodeModel[];
	applied?: boolean;
}

interface GatewayFailure {
	ok: false;
	status: number;
	body: JsonObject;
}

export async function startAgentRouterGateway(
	port = DEFAULT_AGENT_ROUTER_GATEWAY_PORT,
): Promise<RouterGatewayStatus> {
	if (server?.listening) return getAgentRouterGatewayStatus();

	const app = createAgentRouterGatewayApp();
	const candidatePorts = [port, port + 1, port + 2];

	for (const candidatePort of candidatePorts) {
		try {
			server = await listen(app, candidatePort);
			activePort = candidatePort;
			startedAt = new Date().toISOString();
			lastError = null;
			console.log(
				`[agent-router-gateway] Listening on http://${GATEWAY_HOST}:${candidatePort}`,
			);
			return getAgentRouterGatewayStatus();
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			server = null;
		}
	}

	console.error("[agent-router-gateway] Failed to start:", lastError);
	return getAgentRouterGatewayStatus();
}

export async function stopAgentRouterGateway(): Promise<void> {
	const currentServer = server;
	server = null;
	startedAt = null;

	if (!currentServer?.listening) return;

	await new Promise<void>((resolve) => {
		currentServer.close(() => resolve());
	});
}

export function getAgentRouterGatewayStatus(): RouterGatewayStatus {
	const running = Boolean(server?.listening);
	const url = `http://${GATEWAY_HOST}:${activePort}`;

	return {
		running,
		host: GATEWAY_HOST,
		port: activePort,
		url,
		startedAt: running ? startedAt : null,
		error: running ? null : lastError,
	};
}

function createAgentRouterGatewayApp() {
	const app = express();

	app.disable("x-powered-by");
	app.use((req, res, next) => {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader(
			"Access-Control-Allow-Methods",
			"GET,POST,PUT,DELETE,OPTIONS",
		);
		res.setHeader("Access-Control-Allow-Headers", "*");
		if (req.method === "OPTIONS") {
			res.status(204).end();
			return;
		}
		next();
	});
	app.use(attachUsageLogger);

	app.post(
		["/v1/audio/transcriptions", "/v1/audio/translations"],
		express.raw({ type: () => true, limit: "100mb" }),
		(req, res) =>
			handleOpenAIProxy(req, res, req.path.replace("/v1", ""), {
				rawBody: true,
			}),
	);

	app.use(express.json({ limit: "50mb" }));
	app.use((req, _res, next) => {
		requestCount++;
		console.log(`[agent-router-gateway] ${req.method} ${req.path}`);
		next();
	});

	app.get(["/", "/health", "/v1"], (_req, res) => {
		res.json({
			ok: true,
			name: "ADE Agent Router Gateway",
			compatibility: "9router / OpenAI v1",
			requestCount,
			usage: getRouterUsageStats(5),
			...getAgentRouterGatewayStatus(),
		});
	});

	app.get("/v1/models", (_req, res) => {
		res.json(buildOpenAIModelList(getResolutionOptions()));
	});
	app.get("/v1/models/info", (req, res) => {
		const id = typeof req.query.id === "string" ? req.query.id : "";
		const kind =
			typeof req.query.kind === "string"
				? parseModelKind(req.query.kind)
				: undefined;
		if (!id) {
			res.status(400).json({
				error: {
					message: "Missing required query param: id.",
					type: "invalid_request_error",
				},
			});
			return;
		}
		const info = buildRouterModelInfo(id, getResolutionOptions(), kind);
		if (!info) {
			res.status(404).json({
				error: {
					message: `Model not found: ${id}`,
					type: "not_found",
				},
			});
			return;
		}
		res.json(info);
	});
	app.get("/v1/models/:kind", (req, res) => {
		const kindFilter = routerModelKindsForSlug(req.params.kind);
		if (!kindFilter) {
			res.status(404).json({
				error: {
					message: `Unknown model kind: ${req.params.kind}. Supported: ${Object.keys(ROUTER_MODEL_KIND_SLUGS).join(", ")}`,
					type: "invalid_request_error",
				},
			});
			return;
		}
		res.json(
			buildOpenAIModelList({
				...getResolutionOptions(),
				kindFilter,
			}),
		);
	});
	app.get("/v1beta/models", (_req, res) => {
		res.json(buildGeminiModelList(getResolutionOptions()));
	});

	app.post("/v1/compress", (req, res) => {
		const mode = parseTokenSaverMode(req.body?.mode);
		const text = extractCompressInput(req.body);

		if (!text) {
			res.status(400).json({
				error: {
					message: "Expected a string in `text` or `input`.",
					type: "invalid_request_error",
				},
			});
			return;
		}

		const preview = previewRouterTokenSaver({ text, mode });
		res.json({
			object: "router.compression",
			mode,
			changed: preview.result.changed,
			filter: preview.result.filter,
			input_bytes: preview.result.bytesBefore,
			output_bytes: preview.result.bytesAfter,
			saved_bytes: preview.result.savedBytes,
			notice: preview.notice,
			output: preview.result.text,
		});
	});

	app.post("/v1/chat/completions", handleChatCompletions);
	app.post("/v1/responses", handleResponses);
	app.post("/v1/messages", handleAnthropicMessages);
	app.post("/v1/messages/count_tokens", handleCountTokens);
	app.post("/v1/embeddings", handleEmbeddings);
	app.post("/v1/images/generations", (req, res) =>
		handleOpenAIProxy(req, res, "/images/generations"),
	);
	app.post("/v1/audio/speech", (req, res) =>
		handleOpenAIProxy(req, res, "/audio/speech"),
	);
	app.post("/v1/search", handleSearch);
	app.post("/v1/web/fetch", handleWebFetch);

	app.get("/api/usage/stats", (req, res) => {
		const period = parseUsagePeriod(req.query.period, true);
		if (!period) {
			res.status(400).json({ error: "Invalid period" });
			return;
		}
		res.json(getRouterUsageCompatStats(period));
	});
	app.get("/api/usage/history", (_req, res) => {
		res.json(getRouterUsageCompatStats("all"));
	});
	app.get("/api/usage/providers", (_req, res) => {
		res.json({ providers: getRouterUsageProviders() });
	});
	app.get(["/api/usage/logs", "/api/usage/request-logs"], (_req, res) => {
		res.json(getRouterUsageLogs(200));
	});
	app.get("/api/usage/chart", (req, res) => {
		const period = parseUsagePeriod(req.query.period, false);
		if (!period || period === "all") {
			res.status(400).json({ error: "Invalid period" });
			return;
		}
		res.json(getRouterUsageChart(period));
	});
	app.delete("/api/usage", (_req, res) => {
		res.json(clearRouterUsage());
	});
	app.get("/api/models/alias", (_req, res) => {
		res.json({ aliases: getRouterAliases() });
	});
	app.post("/api/models/alias", (req, res) => {
		res.json({
			aliases: upsertRouterAlias({
				alias: String(req.body?.alias ?? ""),
				targetModel: String(req.body?.targetModel ?? ""),
			}),
		});
	});
	app.delete("/api/models/alias/:alias", (req, res) => {
		res.json({ aliases: deleteRouterAlias(req.params.alias) });
	});
	app.get("/api/models/custom", (_req, res) => {
		res.json({ models: getRouterCustomModels() });
	});
	app.post("/api/models/custom", (req, res) => {
		const result = upsertRouterCustomModel(parseCustomModelBody(req.body));
		res.status(result.added ? 201 : 200).json({
			success: true,
			added: result.added,
			models: result.models,
		});
	});
	app.delete("/api/models/custom", (req, res) => {
		const providerAlias = String(req.query.providerAlias ?? "");
		const id = String(req.query.id ?? "");
		const type = parseModelKind(req.query.type);
		res.json({
			success: true,
			models: deleteRouterCustomModel({ providerAlias, id, type }),
		});
	});
	app.get("/api/models/disabled", (req, res) => {
		const providerAlias =
			typeof req.query.providerAlias === "string"
				? req.query.providerAlias
				: undefined;
		const models = getRouterDisabledModels(providerAlias);
		if (providerAlias) {
			res.json({ ids: models.map((model) => model.id), models });
			return;
		}
		res.json({ disabled: getRouterDisabledModelMap(), models });
	});
	app.post("/api/models/disabled", (req, res) => {
		res.json({
			success: true,
			models: disableRouterModels({
				ids: parseModelList(req.body?.ids) ?? [],
				providerAlias: String(req.body?.providerAlias ?? ""),
				reason:
					typeof req.body?.reason === "string" ? req.body.reason : undefined,
			}),
		});
	});
	app.delete("/api/models/disabled", (req, res) => {
		const providerAlias = String(req.query.providerAlias ?? "");
		const id = typeof req.query.id === "string" ? req.query.id : undefined;
		res.json({
			success: true,
			models: enableRouterModels({
				ids: id ? [id] : undefined,
				providerAlias,
			}),
		});
	});
	app.get("/api/models/availability", (_req, res) => {
		const models = getRouterModelAvailability();
		res.json({
			models,
			recent: models,
			unavailableCount: models.filter((model) => model.status !== "available")
				.length,
		});
	});
	app.post("/api/models/availability", (req, res) => {
		if (req.body?.action !== "clearCooldown") {
			res.status(400).json({ error: "Invalid request" });
			return;
		}
		res.json({ ok: true });
	});
	app.post("/api/models/test", async (req, res) => {
		const result = await testRouterModel({
			kind: parseModelKind(req.body?.kind),
			model: String(req.body?.model ?? ""),
		});
		res.status(result.ok ? 200 : (result.status ?? 502)).json(result);
	});
	app.get("/api/combos", (_req, res) => {
		res.json({
			defaultCombos: Object.values(AGENT_COMBOS),
			customCombos: getRouterCustomCombos(),
		});
	});
	app.post("/api/combos", (req, res) => {
		res.json({
			customCombos: upsertRouterCustomCombo({
				name: String(req.body?.name ?? ""),
				models: Array.isArray(req.body?.models) ? req.body.models : [],
			}),
		});
	});
	app.delete("/api/combos/:name", (req, res) => {
		res.json({ customCombos: deleteRouterCustomCombo(req.params.name) });
	});
	app.get("/api/provider-nodes", (_req, res) => {
		res.json({ nodes: getRouterProviderNodes() });
	});
	app.post("/api/provider-nodes/validate", async (req, res) => {
		res.json(
			await validateRouterProviderNode(
				parseProviderNodeValidationBody(req.body),
			),
		);
	});
	app.post("/api/provider-nodes", (req, res) => {
		const node = createRouterProviderNode(parseProviderNodeBody(req.body));
		res.status(201).json({ node });
	});
	app.get("/api/provider-nodes/:id/models", async (req, res) => {
		const result = await discoverRouterProviderNodeModels({
			id: req.params.id,
		});
		res.status(result.ok ? 200 : (result.status ?? 502)).json(result);
	});
	app.post("/api/provider-nodes/:id/import-models", async (req, res) => {
		const result = await discoverRouterProviderNodeModels({
			apply: true,
			id: req.params.id,
		});
		res.status(result.ok ? 200 : (result.status ?? 502)).json(result);
	});
	app.post("/api/provider-nodes/:id/validate", async (req, res) => {
		res.json(
			await validateRouterProviderNode({
				...parseProviderNodeValidationBody(req.body),
				id: req.params.id,
			}),
		);
	});
	app.put("/api/provider-nodes/:id", (req, res) => {
		res.json({
			nodes: updateRouterProviderNode(
				req.params.id,
				parseProviderNodeBody(req.body),
			),
		});
	});
	app.delete("/api/provider-nodes/:id", (req, res) => {
		res.json({ nodes: deleteRouterProviderNode(req.params.id) });
	});

	const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error("[agent-router-gateway] Request failed:", error);
		res.status(500).json({
			error: {
				message,
				type: "server_error",
			},
		});
	};
	app.use(errorHandler);

	return app;
}

async function handleChatCompletions(req: Request, res: ExpressResponse) {
	const body = toJsonObject(req.body);
	const nodeTarget = resolveProviderNodeTarget(body.model, [
		"openai-compatible",
		"anthropic-compatible",
	]);
	if (nodeTarget) {
		if (writeDisabledModelError(res, nodeTarget)) return;
		await handleProviderNodeChat(nodeTarget, body, req, res);
		return;
	}

	const result = await fetchOpenRouterWithFallback(body);
	if (!result.ok) {
		res.status(result.status).json(result.body);
		return;
	}

	setUsageLocals(res, {
		account: result.account,
		model: result.model,
		provider: "openrouter",
	});
	await pipeUpstreamResponse(result.upstream, res);
}

async function handleResponses(req: Request, res: ExpressResponse) {
	const body = toJsonObject(req.body);
	const nodeTarget = resolveProviderNodeTarget(body.model, [
		"openai-compatible",
		"anthropic-compatible",
	]);
	if (nodeTarget) {
		if (writeDisabledModelError(res, nodeTarget)) return;
		await handleProviderNodeResponses(nodeTarget, body, req, res);
		return;
	}

	const { input, instructions, max_output_tokens, ...rest } = body;
	const messages = responsesInputToMessages(body);
	const chatBody = {
		...rest,
		model: typeof body.model === "string" ? body.model : "budget-coding",
		messages,
		max_tokens: max_output_tokens ?? body.max_tokens,
		stream: false,
	};
	void input;
	void instructions;

	const result = await fetchOpenRouterWithFallback(chatBody);
	if (!result.ok) {
		res.status(result.status).json(result.body);
		return;
	}

	setUsageLocals(res, {
		account: result.account,
		model: result.model,
		provider: "openrouter",
	});
	const upstream = await readJson(result.upstream);
	const text = extractAssistantText(upstream);
	const usage = extractOpenAIUsage(upstream);
	res.json({
		id: `resp_${cryptoId()}`,
		object: "response",
		created_at: Math.floor(Date.now() / 1000),
		status: "completed",
		model: result.model,
		output_text: text,
		output: [
			{
				id: `msg_${cryptoId()}`,
				type: "message",
				status: "completed",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text,
						annotations: [],
					},
				],
			},
		],
		usage: {
			input_tokens: usage.prompt_tokens,
			output_tokens: usage.completion_tokens,
			total_tokens: usage.total_tokens,
		},
	});
}

async function handleAnthropicMessages(req: Request, res: ExpressResponse) {
	const body = toJsonObject(req.body);
	const nodeTarget = resolveProviderNodeTarget(body.model, [
		"openai-compatible",
		"anthropic-compatible",
	]);
	if (nodeTarget) {
		if (writeDisabledModelError(res, nodeTarget)) return;
		await handleProviderNodeAnthropicMessages(nodeTarget, body, req, res);
		return;
	}

	const messages = anthropicMessagesToOpenAiMessages(body);
	const chatBody = {
		model: typeof body.model === "string" ? body.model : "budget-coding",
		messages,
		max_tokens: body.max_tokens,
		temperature: body.temperature,
		stream: false,
	};

	const result = await fetchOpenRouterWithFallback(chatBody);
	if (!result.ok) {
		res.status(result.status).json(result.body);
		return;
	}

	setUsageLocals(res, {
		account: result.account,
		model: result.model,
		provider: "openrouter",
	});
	const upstream = await readJson(result.upstream);
	const text = extractAssistantText(upstream);
	const usage = extractOpenAIUsage(upstream);
	res.json({
		id: `msg_${cryptoId()}`,
		type: "message",
		role: "assistant",
		model: result.model,
		content: [{ type: "text", text }],
		stop_reason: extractStopReason(upstream),
		stop_sequence: null,
		usage: {
			input_tokens: usage.prompt_tokens,
			output_tokens: usage.completion_tokens,
		},
	});
}

function handleCountTokens(req: Request, res: ExpressResponse) {
	const body = toJsonObject(req.body);
	const inputTokens = estimateTokens({
		system: body.system,
		messages: body.messages,
		tools: body.tools,
	});
	res.json({ input_tokens: inputTokens });
}

async function handleEmbeddings(req: Request, res: ExpressResponse) {
	const body = toJsonObject(req.body);
	const nodeTarget = resolveProviderNodeTarget(body.model, [
		"custom-embedding",
		"openai-compatible",
	]);
	if (!nodeTarget) {
		await handleOpenAIProxy(req, res, "/embeddings");
		return;
	}
	if (writeDisabledModelError(res, nodeTarget)) return;

	const result = await fetchProviderNodeWithFallback({
		body: withModel(body, nodeTarget.model),
		nodeTarget,
		path: "/embeddings",
		req,
	});
	if (!result.ok) {
		res.status(result.status).json(result.body);
		return;
	}

	setProviderNodeUsageLocals(res, result);
	await pipeUpstreamResponse(result.upstream, res);
}

async function handleProviderNodeChat(
	nodeTarget: ProviderNodeTarget,
	body: JsonObject,
	req: Request,
	res: ExpressResponse,
) {
	const { node } = nodeTarget;

	if (node.type === "openai-compatible" && node.apiType === "responses") {
		if (body.stream === true) {
			writeStreamingTranslationError(res, "OpenAI Responses provider node");
			return;
		}
		const result = await fetchProviderNodeWithFallback({
			body: chatBodyToResponsesBody(body, nodeTarget.model),
			nodeTarget,
			path: "/responses",
			req,
		});
		if (!result.ok) {
			res.status(result.status).json(result.body);
			return;
		}
		setProviderNodeUsageLocals(res, result);
		const upstream = await readJson(result.upstream);
		res.json(responsesToOpenAiChatResponse(upstream, nodeTarget));
		return;
	}

	if (node.type === "openai-compatible") {
		const result = await fetchProviderNodeWithFallback({
			body: withModel(body, nodeTarget.model),
			nodeTarget,
			path: "/chat/completions",
			req,
		});
		if (!result.ok) {
			res.status(result.status).json(result.body);
			return;
		}
		setProviderNodeUsageLocals(res, result);
		await pipeUpstreamResponse(result.upstream, res);
		return;
	}

	if (body.stream === true) {
		writeStreamingTranslationError(res, "Anthropic-compatible provider node");
		return;
	}

	const result = await fetchProviderNodeWithFallback({
		body: openAiChatToAnthropicBody(body, nodeTarget.model),
		nodeTarget,
		path: "/messages",
		req,
	});
	if (!result.ok) {
		res.status(result.status).json(result.body);
		return;
	}
	setProviderNodeUsageLocals(res, result);
	const upstream = await readJson(result.upstream);
	res.json(anthropicToOpenAiChatResponse(upstream, nodeTarget));
}

async function handleProviderNodeResponses(
	nodeTarget: ProviderNodeTarget,
	body: JsonObject,
	req: Request,
	res: ExpressResponse,
) {
	const { node } = nodeTarget;

	if (node.type === "openai-compatible" && node.apiType === "responses") {
		const result = await fetchProviderNodeWithFallback({
			body: withModel(body, nodeTarget.model),
			nodeTarget,
			path: "/responses",
			req,
		});
		if (!result.ok) {
			res.status(result.status).json(result.body);
			return;
		}
		setProviderNodeUsageLocals(res, result);
		await pipeUpstreamResponse(result.upstream, res);
		return;
	}

	if (body.stream === true) {
		writeStreamingTranslationError(res, `${node.type} provider node`);
		return;
	}

	if (node.type === "openai-compatible") {
		const result = await fetchProviderNodeWithFallback({
			body: responsesBodyToChatBody(body, nodeTarget.model),
			nodeTarget,
			path: "/chat/completions",
			req,
		});
		if (!result.ok) {
			res.status(result.status).json(result.body);
			return;
		}
		setProviderNodeUsageLocals(res, result);
		const upstream = await readJson(result.upstream);
		res.json(openAiChatToResponsesResponse(upstream, nodeTarget));
		return;
	}

	const result = await fetchProviderNodeWithFallback({
		body: openAiChatToAnthropicBody(
			responsesBodyToChatBody(body, nodeTarget.model),
			nodeTarget.model,
		),
		nodeTarget,
		path: "/messages",
		req,
	});
	if (!result.ok) {
		res.status(result.status).json(result.body);
		return;
	}
	setProviderNodeUsageLocals(res, result);
	const upstream = await readJson(result.upstream);
	res.json(anthropicToResponsesResponse(upstream, nodeTarget));
}

async function handleProviderNodeAnthropicMessages(
	nodeTarget: ProviderNodeTarget,
	body: JsonObject,
	req: Request,
	res: ExpressResponse,
) {
	const { node } = nodeTarget;

	if (node.type === "anthropic-compatible") {
		const result = await fetchProviderNodeWithFallback({
			body: withModel(body, nodeTarget.model),
			nodeTarget,
			path: "/messages",
			req,
		});
		if (!result.ok) {
			res.status(result.status).json(result.body);
			return;
		}
		setProviderNodeUsageLocals(res, result);
		await pipeUpstreamResponse(result.upstream, res);
		return;
	}

	if (body.stream === true) {
		writeStreamingTranslationError(res, "OpenAI-compatible provider node");
		return;
	}

	if (node.apiType === "responses") {
		const result = await fetchProviderNodeWithFallback({
			body: anthropicBodyToResponsesBody(body, nodeTarget.model),
			nodeTarget,
			path: "/responses",
			req,
		});
		if (!result.ok) {
			res.status(result.status).json(result.body);
			return;
		}
		setProviderNodeUsageLocals(res, result);
		const upstream = await readJson(result.upstream);
		res.json(responsesToAnthropicMessage(upstream, nodeTarget));
		return;
	}

	const result = await fetchProviderNodeWithFallback({
		body: {
			model: nodeTarget.model,
			messages: anthropicMessagesToOpenAiMessages(body),
			max_tokens: body.max_tokens,
			temperature: body.temperature,
			stream: false,
		},
		nodeTarget,
		path: "/chat/completions",
		req,
	});
	if (!result.ok) {
		res.status(result.status).json(result.body);
		return;
	}
	setProviderNodeUsageLocals(res, result);
	const upstream = await readJson(result.upstream);
	res.json(openAiChatToAnthropicMessage(upstream, nodeTarget));
}

async function handleOpenAIProxy(
	req: Request,
	res: ExpressResponse,
	upstreamPath: string,
	{ rawBody = false }: { rawBody?: boolean } = {},
) {
	const accounts = getProviderAccountCredentials("openai");
	if (accounts.length === 0) {
		res.status(401).json({
			error: {
				message:
					"OpenAI API key is not configured in ADE. Add it in the router dashboard provider key section to use this endpoint.",
				type: "authentication_error",
			},
		});
		return;
	}

	const contentType = req.header("content-type");
	const body = rawBody
		? (req.body as BodyInit)
		: (JSON.stringify(req.body ?? {}) as BodyInit);
	let lastFailure: { status: number; text: string } | null = null;

	for (const account of accounts) {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${account.key}`,
		};
		if (contentType) headers["Content-Type"] = contentType;
		if (!rawBody) headers["Content-Type"] = "application/json";

		const upstream = await fetch(`${OPENAI_BASE_URL}${upstreamPath}`, {
			method: "POST",
			headers,
			body,
		});

		if (upstream.ok) {
			markProviderAccountSuccess(account);
			setUsageLocals(res, {
				account,
				model: inferModelForRequest(req.path, req.body),
				provider: "openai",
			});
			await pipeUpstreamResponse(upstream, res);
			return;
		}

		const text = await upstream.text().catch(() => upstream.statusText);
		lastFailure = { status: upstream.status, text };
		markProviderAccountFailure({
			credential: account,
			status: upstream.status,
			text,
		});
	}

	res.status(lastFailure?.status ?? 502).json({
		error: {
			message: "All OpenAI accounts failed.",
			type: "upstream_error",
			details: lastFailure,
		},
	});
}

async function handleSearch(req: Request, res: ExpressResponse) {
	const body = toJsonObject(req.body);
	const query = extractSearchQuery(body);
	if (!query) {
		res.status(400).json({
			error: {
				message: "Expected `query`, `q`, or a message containing search text.",
				type: "invalid_request_error",
			},
		});
		return;
	}

	const braveAccounts = getProviderAccountCredentials("brave-search");
	for (const account of braveAccounts) {
		const url = new URL(BRAVE_SEARCH_URL);
		url.searchParams.set("q", query);
		url.searchParams.set("count", String(Number(body.count ?? 10)));
		const upstream = await fetch(url, {
			headers: {
				Accept: "application/json",
				"X-Subscription-Token": account.key,
			},
		});
		if (upstream.ok) {
			markProviderAccountSuccess(account);
			setUsageLocals(res, {
				account,
				model: "brave-search",
				provider: "brave-search",
			});
			await pipeUpstreamResponse(upstream, res);
			return;
		}
		const text = await upstream.text().catch(() => upstream.statusText);
		markProviderAccountFailure({
			credential: account,
			status: upstream.status,
			text,
		});
	}

	const perplexityAccounts = getProviderAccountCredentials("perplexity");
	for (const account of perplexityAccounts) {
		const upstream = await fetch(PERPLEXITY_CHAT_COMPLETIONS_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${account.key}`,
			},
			body: JSON.stringify({
				model: typeof body.model === "string" ? body.model : "sonar",
				messages: [
					{
						role: "user",
						content: query,
					},
				],
			}),
		});
		if (upstream.ok) {
			markProviderAccountSuccess(account);
			setUsageLocals(res, {
				account,
				model: typeof body.model === "string" ? body.model : "sonar",
				provider: "perplexity",
			});
			await pipeUpstreamResponse(upstream, res);
			return;
		}
		const text = await upstream.text().catch(() => upstream.statusText);
		markProviderAccountFailure({
			credential: account,
			status: upstream.status,
			text,
		});
	}

	res.status(401).json({
		error: {
			message: "Configure Brave Search or Perplexity in ADE to use /v1/search.",
			type: "authentication_error",
		},
	});
}

async function handleWebFetch(req: Request, res: ExpressResponse) {
	const body = toJsonObject(req.body);
	const url = typeof body.url === "string" ? body.url : "";
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		res.status(400).json({
			error: {
				message: "Expected a valid `url`.",
				type: "invalid_request_error",
			},
		});
		return;
	}

	if (!["http:", "https:"].includes(parsedUrl.protocol)) {
		res.status(400).json({
			error: {
				message: "Only http and https URLs can be fetched.",
				type: "invalid_request_error",
			},
		});
		return;
	}

	const upstream = await fetch(parsedUrl, {
		headers: { Accept: "text/html,application/json,text/plain,*/*" },
	});
	const text = await upstream.text();
	const maxBytes = Number(body.maxBytes ?? 1_000_000);
	res.status(upstream.status).json({
		url: parsedUrl.toString(),
		status: upstream.status,
		content_type: upstream.headers.get("content-type"),
		text: text.slice(0, Number.isFinite(maxBytes) ? maxBytes : 1_000_000),
		truncated: text.length > maxBytes,
	});
}

export async function testRouterModel({
	kind = "llm",
	model,
}: {
	kind?: RouterModelKind;
	model: string;
}): Promise<RouterModelTestResult> {
	const requestedModel = model.trim();
	const modelKind = parseModelKind(kind);
	const startedAtMs = Date.now();
	const provider = inferProviderFromModel(requestedModel);
	let method = "chat";

	const finish = (result: Omit<RouterModelTestResult, "latencyMs">) => {
		const latencyMs = Date.now() - startedAtMs;
		recordRouterModelAvailability({
			error: result.error,
			httpStatus: result.status,
			kind: result.kind,
			latencyMs,
			method: result.method,
			model: result.model,
			provider: result.provider,
			status: result.ok ? "available" : "unavailable",
		});
		return { ...result, latencyMs };
	};

	if (!requestedModel) {
		return finish({
			ok: false,
			model: requestedModel,
			kind: modelKind,
			provider,
			status: 400,
			error: "Model required",
			method,
		});
	}

	if (isModelPathDisabled(requestedModel)) {
		return finish({
			ok: false,
			model: requestedModel,
			kind: modelKind,
			provider,
			status: 403,
			error: "Model is disabled in the router registry",
			method,
		});
	}

	try {
		const baseUrl = `http://${GATEWAY_HOST}:${activePort}`;
		let response: globalThis.Response;

		if (modelKind === "embedding") {
			method = "embeddings";
			response = await fetchWithTimeout(
				`${baseUrl}/v1/embeddings`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ model: requestedModel, input: "test" }),
				},
				15_000,
			);
			return finish(
				await modelTestResultFromResponse({
					response,
					model: requestedModel,
					kind: modelKind,
					provider,
					method,
					validate: (data) => {
						const embedding = (
							(data.data as unknown[])?.[0] as JsonObject | undefined
						)?.embedding;
						return Array.isArray(embedding)
							? null
							: "Provider returned no embedding data";
					},
				}),
			);
		}

		if (modelKind === "image") {
			method = "images";
			response = await fetchWithTimeout(
				`${baseUrl}/v1/images/generations`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ model: requestedModel, prompt: "test" }),
				},
				15_000,
			);
			return finish(
				await modelTestResultFromResponse({
					response,
					model: requestedModel,
					kind: modelKind,
					provider,
					method,
					validate: (data) =>
						Array.isArray(data.data) && data.data.length > 0
							? null
							: "Provider returned no image data",
				}),
			);
		}

		if (modelKind === "stt") {
			method = "transcriptions";
			const form = new FormData();
			form.append("file", createSilentWavFile(), "test.wav");
			form.append("model", requestedModel);
			response = await fetchWithTimeout(
				`${baseUrl}/v1/audio/transcriptions`,
				{
					method: "POST",
					body: form,
				},
				15_000,
			);
			return finish(
				await modelTestResultFromResponse({
					response,
					model: requestedModel,
					kind: modelKind,
					provider,
					method,
					validate: (data) =>
						typeof data.text === "string" && data.text.trim()
							? null
							: "Provider returned no transcription text",
				}),
			);
		}

		method = "chat";
		response = await fetchWithTimeout(
			`${baseUrl}/v1/chat/completions`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: requestedModel,
					max_tokens: 16,
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			},
			15_000,
		);
		return finish(
			await modelTestResultFromResponse({
				response,
				model: requestedModel,
				kind: modelKind,
				provider,
				method,
				validate: (data) =>
					Array.isArray(data.choices) && data.choices.length > 0
						? null
						: "Provider returned no completion choices",
			}),
		);
	} catch (error) {
		return finish({
			ok: false,
			model: requestedModel,
			kind: modelKind,
			provider,
			status: null,
			error: getProviderNodeNetworkErrorMessage(error),
			method,
		});
	}
}

export async function validateRouterProviderNode(
	input: RouterProviderNodeValidationInput,
): Promise<RouterProviderNodeValidationResult> {
	try {
		const candidate = resolveProviderNodeValidationCandidate(input);
		if (!candidate.ok) return { valid: false, ...candidate.error };

		const { node } = candidate;
		if (!isValidHttpUrl(node.baseUrl)) {
			return { valid: false, error: "Invalid URL format", status: 400 };
		}

		if (node.apiKeyAccountId && candidate.credentials.length === 0) {
			return {
				valid: false,
				error: "Selected provider account is not available.",
				status: 401,
			};
		}

		if (node.type === "custom-embedding") {
			return validateProviderNodeEmbedding(candidate, input.modelId);
		}

		const modelsAttempt = await fetchProviderNodeModels(candidate);
		if (modelsAttempt.ok) {
			return {
				valid: true,
				method: "models",
				models: modelsAttempt.models,
			};
		}

		if (modelsAttempt.status === 401 || modelsAttempt.status === 403) {
			return {
				valid: false,
				error: "API key unauthorized",
				status: modelsAttempt.status,
			};
		}

		const modelId = input.modelId?.trim();
		if (!modelId) {
			return {
				valid: false,
				error: getModelsErrorMessage(modelsAttempt.status),
				status: modelsAttempt.status,
			};
		}

		return validateProviderNodeInference(candidate, modelId);
	} catch (error) {
		return {
			valid: false,
			error: getProviderNodeNetworkErrorMessage(error),
			status: 500,
		};
	}
}

export async function discoverRouterProviderNodeModels(
	input: RouterProviderNodeValidationInput & { apply?: boolean },
): Promise<RouterProviderNodeDiscoveryResult> {
	try {
		const candidate = resolveProviderNodeValidationCandidate(input);
		if (!candidate.ok) {
			return {
				ok: false,
				error: candidate.error.error,
				status: candidate.error.status,
				models: [],
			};
		}

		if (!isValidHttpUrl(candidate.node.baseUrl)) {
			return {
				ok: false,
				error: "Invalid URL format",
				status: 400,
				models: [],
			};
		}

		if (candidate.node.apiKeyAccountId && candidate.credentials.length === 0) {
			return {
				ok: false,
				error: "Selected provider account is not available.",
				status: 401,
				models: [],
			};
		}

		const result = await fetchProviderNodeModels(candidate);
		if (!result.ok) {
			return {
				ok: false,
				error: getModelsErrorMessage(result.status),
				status: result.status,
				models: [],
			};
		}

		const models = result.models;
		if (input.apply && input.id) {
			updateRouterProviderNode(input.id, {
				models: models.map((model) => model.id),
			});
		}

		return {
			ok: true,
			models,
			applied: Boolean(input.apply && input.id),
		};
	} catch (error) {
		return {
			ok: false,
			error: getProviderNodeNetworkErrorMessage(error),
			status: 500,
			models: [],
		};
	}
}

async function validateProviderNodeEmbedding(
	candidate: ProviderNodeValidationCandidate,
	modelId: string | undefined,
): Promise<RouterProviderNodeValidationResult> {
	const model = modelId?.trim();
	if (!model) {
		return {
			valid: false,
			error: "Model ID required for embedding validation",
			status: 400,
		};
	}

	const attempts = providerNodeValidationAttempts(candidate);
	for (const account of attempts) {
		const upstream = await fetchWithTimeout(
			providerNodeUrl(candidate.node, "/embeddings"),
			{
				method: "POST",
				headers: providerNodeHeadersForVersion(candidate.node, account),
				body: JSON.stringify({ model, input: "ping" }),
			},
		);
		if (upstream.ok) {
			const data = await readJson(upstream);
			const embedding = (
				(data.data as unknown[])?.[0] as JsonObject | undefined
			)?.embedding;
			return {
				valid: true,
				method: "embeddings",
				dimensions: Array.isArray(embedding) ? embedding.length : null,
			};
		}
		if (upstream.status === 401 || upstream.status === 403) {
			return {
				valid: false,
				error: "API key unauthorized",
				status: upstream.status,
			};
		}
		const text = await upstream.text().catch(() => upstream.statusText);
		return {
			valid: false,
			error: `Embeddings request failed (${upstream.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
			method: "embeddings",
			status: upstream.status,
		};
	}

	return {
		valid: false,
		error: "No validation attempt was available.",
		status: 401,
	};
}

async function validateProviderNodeInference(
	candidate: ProviderNodeValidationCandidate,
	modelId: string,
): Promise<RouterProviderNodeValidationResult> {
	const { node } = candidate;
	const isResponses =
		node.type === "openai-compatible" && node.apiType === "responses";
	const path =
		node.type === "anthropic-compatible"
			? "/messages"
			: isResponses
				? "/responses"
				: "/chat/completions";
	const body =
		node.type === "anthropic-compatible"
			? {
					model: modelId,
					messages: [{ role: "user", content: "ping" }],
					max_tokens: 1,
				}
			: isResponses
				? {
						model: modelId,
						input: "ping",
						max_output_tokens: 1,
						stream: false,
					}
				: {
						model: modelId,
						messages: [{ role: "user", content: "ping" }],
						max_tokens: 1,
					};
	const method =
		node.type === "anthropic-compatible"
			? "messages"
			: isResponses
				? "responses"
				: "chat";

	for (const account of providerNodeValidationAttempts(candidate)) {
		const upstream = await fetchWithTimeout(providerNodeUrl(node, path), {
			method: "POST",
			headers: providerNodeHeadersForVersion(node, account),
			body: JSON.stringify(body),
		});
		if (upstream.ok) return { valid: true, method };
		return {
			valid: false,
			error: getChatErrorMessage(upstream.status),
			method,
			status: upstream.status,
		};
	}

	return {
		valid: false,
		error: "No validation attempt was available.",
		status: 401,
	};
}

async function fetchProviderNodeWithFallback({
	body,
	nodeTarget,
	path,
	req,
}: {
	body: JsonObject;
	nodeTarget: ProviderNodeTarget;
	path: string;
	req: Request;
}): Promise<ProviderNodeSuccess | GatewayFailure> {
	const { node } = nodeTarget;
	const credentials = getProviderNodeCredentials(node);
	if (node.apiKeyAccountId && credentials.length === 0) {
		return {
			ok: false,
			status: 401,
			body: {
				error: {
					message:
						"Provider node account is selected but no active credential is available.",
					type: "authentication_error",
				},
			},
		};
	}

	const attempts: Array<RouterProviderCredential | undefined> =
		credentials.length > 0 ? credentials : [undefined];
	let lastFailure: { account: string; status: number; text: string } | null =
		null;

	for (const account of attempts) {
		const upstream = await fetch(providerNodeUrl(node, path), {
			method: "POST",
			headers: providerNodeHeaders(node, account, req),
			body: JSON.stringify(body),
		});

		if (upstream.ok) {
			if (account) markProviderAccountSuccess(account);
			return {
				ok: true,
				account,
				upstream,
				node,
				model: nodeTarget.model,
			};
		}

		const text = await upstream.text().catch(() => upstream.statusText);
		lastFailure = {
			account: account?.name ?? "no-auth",
			status: upstream.status,
			text,
		};
		if (account) {
			markProviderAccountFailure({
				credential: account,
				status: upstream.status,
				text,
			});
		}
	}

	return {
		ok: false,
		status: lastFailure?.status ?? 502,
		body: {
			error: {
				message: "Provider node request failed.",
				type: "upstream_error",
				details: lastFailure,
				node: node.id,
			},
		},
	};
}

interface ProviderNodeValidationCandidate {
	node: RouterProviderNode;
	credentials: RouterProviderCredential[];
}

type ProviderNodeCandidateResolution =
	| {
			ok: true;
			node: RouterProviderNode;
			credentials: RouterProviderCredential[];
	  }
	| {
			ok: false;
			error: {
				error: string;
				status: number;
			};
	  };

async function fetchProviderNodeModels(
	candidate: ProviderNodeValidationCandidate,
): Promise<
	| { ok: true; models: RouterDiscoveredProviderNodeModel[] }
	| { ok: false; status: number }
> {
	for (const account of providerNodeValidationAttempts(candidate)) {
		const upstream = await fetchWithTimeout(
			providerNodeUrl(candidate.node, "/models"),
			{
				method: "GET",
				headers: providerNodeHeadersForVersion(candidate.node, account),
			},
		);
		if (upstream.ok) {
			return {
				ok: true,
				models: parseDiscoveredProviderNodeModels(await readJson(upstream)),
			};
		}
		return { ok: false, status: upstream.status };
	}

	return { ok: false, status: 401 };
}

function resolveProviderNodeValidationCandidate(
	input: RouterProviderNodeValidationInput,
): ProviderNodeCandidateResolution {
	const existing = input.id
		? getRouterProviderNodes().find((node) => node.id === input.id)
		: undefined;
	if (input.id && !existing) {
		return {
			ok: false,
			error: { error: "Provider node not found", status: 404 },
		};
	}

	const type = input.type ?? existing?.type ?? "openai-compatible";
	const baseUrl = sanitizeProviderNodeBaseUrlForRequest(
		input.baseUrl ?? existing?.baseUrl ?? defaultProviderNodeBaseUrl(type),
		type,
	);
	const node: RouterProviderNode = {
		id: existing?.id ?? "draft-provider-node",
		type,
		name: existing?.name ?? "Draft provider node",
		prefix: existing?.prefix ?? "draft",
		baseUrl,
		apiType:
			type === "openai-compatible"
				? (input.apiType ?? existing?.apiType ?? "chat")
				: undefined,
		apiKeyProvider:
			input.apiKeyProvider ??
			existing?.apiKeyProvider ??
			defaultProviderNodeKeyProvider(type),
		apiKeyAccountId:
			input.apiKeyAccountId === undefined
				? (existing?.apiKeyAccountId ?? null)
				: input.apiKeyAccountId,
		models: existing?.models ?? [],
		isActive: existing?.isActive ?? true,
		createdAt: existing?.createdAt ?? new Date().toISOString(),
		updatedAt: existing?.updatedAt ?? new Date().toISOString(),
	};

	return {
		ok: true,
		node,
		credentials: getProviderNodeValidationCredentials(node, input),
	};
}

function getProviderNodeValidationCredentials(
	node: RouterProviderNode,
	input: RouterProviderNodeValidationInput,
): RouterProviderCredential[] {
	const directKey = input.apiKey?.trim();
	if (directKey) {
		const provider =
			input.apiKeyProvider ??
			node.apiKeyProvider ??
			defaultProviderNodeKeyProvider(node.type) ??
			"openai";
		return [
			{
				id: "direct-validation-key",
				name: "Direct validation key",
				provider,
				key: directKey,
				legacy: true,
			},
		];
	}

	if (!node.apiKeyProvider) return [];
	const credentials = getProviderAccountCredentials(node.apiKeyProvider);
	if (!node.apiKeyAccountId) return credentials;
	return credentials.filter(
		(credential) => credential.id === node.apiKeyAccountId,
	);
}

function providerNodeValidationAttempts({
	credentials,
}: ProviderNodeValidationCandidate): Array<
	RouterProviderCredential | undefined
> {
	return credentials.length > 0 ? credentials : [undefined];
}

function resolveProviderNodeTarget(
	model: unknown,
	allowedTypes: RouterProviderNodeType[],
): ProviderNodeTarget | null {
	const requestedModel = resolveRequestedModel(model);
	if (!requestedModel) return null;

	const slashIndex = requestedModel.indexOf("/");
	if (slashIndex <= 0 || slashIndex === requestedModel.length - 1) return null;

	const prefix = requestedModel.slice(0, slashIndex);
	const modelId = requestedModel.slice(slashIndex + 1);
	const node = getRouterProviderNodes().find(
		(candidate) =>
			candidate.isActive &&
			allowedTypes.includes(candidate.type) &&
			candidate.prefix === prefix,
	);
	if (!node) return null;

	return {
		node,
		model: modelId,
		requestedModel,
	};
}

function resolveRequestedModel(model: unknown): string | null {
	if (typeof model !== "string") return null;
	let requestedModel = model.trim();
	if (!requestedModel) return null;

	for (let depth = 0; depth < 8; depth++) {
		const alias = getRouterAliases().find(
			(candidate) => candidate.alias === requestedModel,
		);
		if (!alias) return requestedModel;
		const next = alias.targetModel.trim();
		if (!next || next === requestedModel) return requestedModel;
		requestedModel = next;
	}

	return requestedModel;
}

function getProviderNodeCredentials(
	node: RouterProviderNode,
): RouterProviderCredential[] {
	if (!node.apiKeyProvider) return [];
	const credentials = getProviderAccountCredentials(node.apiKeyProvider);
	if (!node.apiKeyAccountId) return credentials;
	return credentials.filter(
		(credential) => credential.id === node.apiKeyAccountId,
	);
}

function providerNodeHeaders(
	node: RouterProviderNode,
	account: RouterProviderCredential | undefined,
	req: Request,
): Record<string, string> {
	return providerNodeHeadersForVersion(
		node,
		account,
		req.header("anthropic-version") ?? "2023-06-01",
	);
}

function providerNodeHeadersForVersion(
	node: RouterProviderNode,
	account: RouterProviderCredential | undefined,
	anthropicVersion = "2023-06-01",
): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (!account?.key) return headers;

	if (node.type === "anthropic-compatible") {
		headers["x-api-key"] = account.key;
		headers.Authorization = `Bearer ${account.key}`;
		headers["anthropic-version"] = anthropicVersion;
		return headers;
	}

	headers.Authorization = `Bearer ${account.key}`;
	return headers;
}

function providerNodeUrl(node: RouterProviderNode, path: string): string {
	const baseUrl = node.baseUrl.replace(/\/+$/g, "");
	return baseUrl.endsWith(path) ? baseUrl : `${baseUrl}${path}`;
}

function sanitizeProviderNodeBaseUrlForRequest(
	baseUrl: string,
	type: RouterProviderNodeType,
): string {
	let sanitized = baseUrl.trim().replace(/\/+$/g, "");
	if (type === "anthropic-compatible" && sanitized.endsWith("/messages")) {
		sanitized = sanitized.slice(0, -"/messages".length);
	}
	if (type === "custom-embedding" && sanitized.endsWith("/embeddings")) {
		sanitized = sanitized.slice(0, -"/embeddings".length);
	}
	return sanitized;
}

function defaultProviderNodeBaseUrl(type: RouterProviderNodeType): string {
	if (type === "anthropic-compatible") return "https://api.anthropic.com/v1";
	return "https://api.openai.com/v1";
}

function defaultProviderNodeKeyProvider(
	type: RouterProviderNodeType,
): RouterProviderKeyId | undefined {
	if (type === "anthropic-compatible") return "anthropic";
	if (type === "openai-compatible" || type === "custom-embedding")
		return "openai";
	return undefined;
}

function setProviderNodeUsageLocals(
	res: ExpressResponse,
	result: ProviderNodeSuccess,
) {
	res.locals.routerProvider = result.node.id;
	res.locals.routerModel = `${result.node.prefix}/${result.model}`;
	if (result.account) {
		res.locals.routerAccountId = result.account.id;
		res.locals.routerAccountName = result.account.name;
	}
}

async function modelTestResultFromResponse({
	kind,
	method,
	model,
	provider,
	response,
	validate,
}: {
	kind: RouterModelKind;
	method: string;
	model: string;
	provider: string;
	response: globalThis.Response;
	validate: (data: JsonObject) => string | null;
}): Promise<Omit<RouterModelTestResult, "latencyMs">> {
	const rawText = await response.text().catch(() => "");
	let parsed: JsonObject = {};
	try {
		parsed = rawText ? (JSON.parse(rawText) as JsonObject) : {};
	} catch {
		parsed = {};
	}

	if (!response.ok) {
		const detail = errorTextFromBody(parsed) || rawText;
		return {
			ok: false,
			model,
			kind,
			provider,
			status: response.status,
			error: `HTTP ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ""}`,
			method,
		};
	}

	const providerStatus = parsed.status;
	const providerMessage =
		stringValue(parsed.msg) ??
		stringValue(parsed.message) ??
		errorTextFromBody(parsed);
	if (
		providerStatus !== undefined &&
		providerStatus !== null &&
		String(providerStatus) !== "200" &&
		String(providerStatus) !== "0" &&
		providerMessage
	) {
		return {
			ok: false,
			model,
			kind,
			provider,
			status: response.status,
			error: `Provider status ${providerStatus}: ${providerMessage.slice(0, 240)}`,
			method,
		};
	}

	if (parsed.error) {
		return {
			ok: false,
			model,
			kind,
			provider,
			status: response.status,
			error: (errorTextFromBody(parsed) ?? "Provider returned an error").slice(
				0,
				240,
			),
			method,
		};
	}

	const validationError = validate(parsed);
	return {
		ok: !validationError,
		model,
		kind,
		provider,
		status: response.status,
		error: validationError,
		method,
	};
}

function createSilentWavFile(): Blob {
	const sampleRate = 16_000;
	const channels = 1;
	const bitsPerSample = 16;
	const durationMs = 250;
	const sampleCount = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
	const dataSize = sampleCount * channels * (bitsPerSample / 8);
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);
	const writeAscii = (offset: number, value: string) => {
		for (let index = 0; index < value.length; index++) {
			view.setUint8(offset + index, value.charCodeAt(index));
		}
	};

	writeAscii(0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	writeAscii(8, "WAVE");
	writeAscii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
	view.setUint16(32, channels * (bitsPerSample / 8), true);
	view.setUint16(34, bitsPerSample, true);
	writeAscii(36, "data");
	view.setUint32(40, dataSize, true);

	return new Blob([buffer], { type: "audio/wav" });
}

function writeDisabledModelError(
	res: ExpressResponse,
	nodeTarget: ProviderNodeTarget,
): boolean {
	if (!isProviderNodeTargetDisabled(nodeTarget)) return false;
	res.status(403).json({
		error: {
			message: `Model ${nodeTarget.requestedModel} is disabled in the router registry.`,
			type: "model_disabled",
		},
	});
	return true;
}

function isProviderNodeTargetDisabled(nodeTarget: ProviderNodeTarget): boolean {
	return (
		isRouterModelDisabled(nodeTarget.node.prefix, nodeTarget.model) ||
		isRouterModelDisabled(nodeTarget.node.id, nodeTarget.model)
	);
}

function isModelPathDisabled(model: string): boolean {
	const requestedModel = resolveRequestedModel(model) ?? model;
	const nodeTarget = resolveProviderNodeTarget(requestedModel, [
		"openai-compatible",
		"anthropic-compatible",
		"custom-embedding",
	]);
	if (nodeTarget && isProviderNodeTargetDisabled(nodeTarget)) return true;
	return isRouterModelDisabledForModelPath(requestedModel);
}

function isRouterModelDisabledForModelPath(model: string): boolean {
	const slashIndex = model.indexOf("/");
	if (slashIndex <= 0 || slashIndex === model.length - 1) return false;
	return isRouterModelDisabled(
		model.slice(0, slashIndex),
		model.slice(slashIndex + 1),
	);
}

function inferProviderFromModel(model: string): string {
	const requestedModel = resolveRequestedModel(model) ?? model;
	const nodeTarget = resolveProviderNodeTarget(requestedModel, [
		"openai-compatible",
		"anthropic-compatible",
		"custom-embedding",
	]);
	if (nodeTarget) return nodeTarget.node.prefix;
	const slashIndex = requestedModel.indexOf("/");
	if (slashIndex > 0) return requestedModel.slice(0, slashIndex);
	const target = resolveRouterModelTarget(
		requestedModel,
		getResolutionOptions(),
	);
	return target?.provider ?? "router";
}

function errorTextFromBody(body: JsonObject): string | null {
	const error = body.error;
	if (typeof error === "string") return error;
	if (error && typeof error === "object") {
		const value = error as JsonObject;
		return stringValue(value.message) ?? stringValue(value.error) ?? null;
	}
	return stringValue(body.message) ?? stringValue(body.msg) ?? null;
}

function parseCustomModelBody(value: unknown) {
	const body = toJsonObject(value);
	return {
		id: typeof body.id === "string" ? body.id : "",
		name: typeof body.name === "string" ? body.name : undefined,
		providerAlias:
			typeof body.providerAlias === "string" ? body.providerAlias : "",
		type: parseModelKind(body.type),
	};
}

function parseModelKind(value: unknown): RouterModelKind {
	if (
		value === "embedding" ||
		value === "image" ||
		value === "tts" ||
		value === "stt" ||
		value === "imageToText" ||
		value === "webSearch" ||
		value === "webFetch" ||
		value === "video" ||
		value === "search" ||
		value === "other"
	) {
		return value;
	}
	return "llm";
}

function parseUsagePeriod(
	value: unknown,
	allowAll: boolean,
): RouterUsagePeriod | null {
	const period = typeof value === "string" ? value : "7d";
	if (
		period === "today" ||
		period === "24h" ||
		period === "7d" ||
		period === "30d" ||
		period === "60d" ||
		(allowAll && period === "all")
	) {
		return period;
	}
	return null;
}

function parseProviderNodeBody(value: unknown): Partial<RouterProviderNode> {
	const body = toJsonObject(value);
	return {
		apiKeyAccountId:
			typeof body.apiKeyAccountId === "string"
				? body.apiKeyAccountId
				: body.apiKeyAccountId === null
					? null
					: undefined,
		apiKeyProvider:
			typeof body.apiKeyProvider === "string"
				? (body.apiKeyProvider as RouterProviderKeyId)
				: undefined,
		apiType:
			body.apiType === "responses" || body.apiType === "chat"
				? body.apiType
				: undefined,
		baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
		isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
		models: parseModelList(body.models),
		name: typeof body.name === "string" ? body.name : undefined,
		prefix: typeof body.prefix === "string" ? body.prefix : undefined,
		type: parseProviderNodeType(body.type),
	};
}

function parseProviderNodeValidationBody(
	value: unknown,
): RouterProviderNodeValidationInput {
	const body = toJsonObject(value);
	return {
		...parseProviderNodeBody(value),
		apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
		id: typeof body.id === "string" ? body.id : undefined,
		modelId: typeof body.modelId === "string" ? body.modelId : undefined,
	};
}

function parseModelList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) return value.map(String);
	if (typeof value === "string") {
		return value
			.split(/[\n,]+/)
			.map((model) => model.trim())
			.filter(Boolean);
	}
	return undefined;
}

function parseProviderNodeType(
	value: unknown,
): RouterProviderNodeType | undefined {
	if (
		value === "openai-compatible" ||
		value === "anthropic-compatible" ||
		value === "custom-embedding"
	) {
		return value;
	}
	return undefined;
}

function parseDiscoveredProviderNodeModels(
	data: JsonObject,
): RouterDiscoveredProviderNodeModel[] {
	const rawModels = extractRawModelList(data);
	const models = new Map<string, RouterDiscoveredProviderNodeModel>();
	for (const item of rawModels) {
		const value = toJsonObject(item);
		const id =
			stringValue(value.id) ??
			stringValue(value.model) ??
			stringValue(value.slug) ??
			stringValue(value.name);
		if (!id) continue;
		models.set(id, {
			id,
			name:
				stringValue(value.display_name) ??
				stringValue(value.displayName) ??
				stringValue(value.name) ??
				id,
		});
	}
	return Array.from(models.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function extractRawModelList(data: JsonObject): unknown[] {
	if (Array.isArray(data)) return data;
	if (Array.isArray(data.data)) return data.data;
	if (Array.isArray(data.models)) return data.models;
	if (Array.isArray(data.results)) return data.results;
	if (data.models && typeof data.models === "object") {
		return Object.entries(data.models as Record<string, unknown>).map(
			([id, value]) => ({
				...toJsonObject(value),
				id,
			}),
		);
	}
	return [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs = 10_000,
): Promise<globalThis.Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

function isValidHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function getModelsErrorMessage(status: number): string {
	if (status === 401 || status === 403) return "API key unauthorized";
	if (status === 404)
		return "/models endpoint not found - enter a model ID to validate via inference.";
	if (status >= 500) return "Server error - try again later";
	return `Unexpected response (${status})`;
}

function getChatErrorMessage(status: number): string {
	if (status === 401 || status === 403) return "API key unauthorized";
	if (status === 400) return "Invalid model or bad request";
	if (status === 404) return "Inference endpoint not found";
	if (status >= 500) return "Server error - try again later";
	return `Inference request failed (${status})`;
}

function getProviderNodeNetworkErrorMessage(error: unknown): string {
	const value = error as { cause?: { code?: string }; message?: string };
	if (value.cause?.code === "ECONNREFUSED")
		return "Connection refused - provider node offline or unreachable";
	if (value.cause?.code === "ENOTFOUND")
		return "DNS lookup failed - invalid domain or network issue";
	if (value.cause?.code === "ETIMEDOUT")
		return "Connection timeout - provider node too slow";
	if (value.message?.includes("abort") || value.message?.includes("timeout"))
		return "Request timeout (>10s) - provider node not responding";
	if (value.cause?.code === "CERT_HAS_EXPIRED")
		return "SSL certificate expired";
	if (value.cause?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE")
		return "SSL certificate verification failed";
	if (value.cause?.code) return `Network error: ${value.cause.code}`;
	return "Network connection failed - check URL and network connectivity";
}

function withModel(body: JsonObject, model: string): JsonObject {
	return { ...body, model };
}

function openAiChatToAnthropicBody(
	body: JsonObject,
	model: string,
): JsonObject {
	const messages: JsonObject[] = [];
	const systemParts: string[] = [];
	const sourceMessages = Array.isArray(body.messages) ? body.messages : [];

	for (const item of sourceMessages) {
		if (!item || typeof item !== "object") continue;
		const value = item as JsonObject;
		const role = typeof value.role === "string" ? value.role : "user";
		const text = extractContentText(value.content);
		if (!text) continue;
		if (role === "system") {
			systemParts.push(text);
			continue;
		}
		messages.push({
			role: role === "assistant" ? "assistant" : "user",
			content: text,
		});
	}

	return {
		model,
		messages: messages.length > 0 ? messages : [{ role: "user", content: "" }],
		max_tokens: Number(body.max_tokens ?? body.max_output_tokens ?? 1024),
		system:
			typeof body.system === "string"
				? body.system
				: systemParts.length > 0
					? systemParts.join("\n\n")
					: undefined,
		temperature: body.temperature,
		top_p: body.top_p,
		stop_sequences: parseStopSequences(body.stop),
		stream: false,
	};
}

function chatBodyToResponsesBody(body: JsonObject, model: string): JsonObject {
	const { max_tokens, messages, stream, ...rest } = body;
	const sourceMessages = Array.isArray(messages) ? messages : [];
	const systemParts: string[] = [];
	const inputParts: string[] = [];
	for (const item of sourceMessages) {
		if (!item || typeof item !== "object") continue;
		const value = item as JsonObject;
		const role = typeof value.role === "string" ? value.role : "user";
		const text = extractContentText(value.content);
		if (!text) continue;
		if (role === "system") systemParts.push(text);
		else inputParts.push(`${role}: ${text}`);
	}
	void stream;
	return {
		...rest,
		model,
		instructions: systemParts.join("\n\n") || rest.instructions,
		input: inputParts.join("\n\n") || rest.input || "Continue.",
		max_output_tokens: rest.max_output_tokens ?? max_tokens,
		stream: false,
	};
}

function anthropicBodyToResponsesBody(
	body: JsonObject,
	model: string,
): JsonObject {
	const messages = anthropicMessagesToOpenAiMessages(body);
	return chatBodyToResponsesBody(
		{
			...body,
			messages,
			max_tokens: body.max_tokens,
		},
		model,
	);
}

function responsesBodyToChatBody(body: JsonObject, model: string): JsonObject {
	const { input, instructions, max_output_tokens, ...rest } = body;
	void input;
	void instructions;
	return {
		...rest,
		model,
		messages: responsesInputToMessages(body),
		max_tokens: max_output_tokens ?? body.max_tokens,
		stream: false,
	};
}

function openAiChatToResponsesResponse(
	upstream: JsonObject,
	nodeTarget: ProviderNodeTarget,
): JsonObject {
	const text = extractAssistantText(upstream);
	const usage = extractOpenAIUsage(upstream);
	return buildResponsesResponse({
		inputTokens: usage.prompt_tokens,
		model: nodeTarget.requestedModel,
		outputTokens: usage.completion_tokens,
		text,
	});
}

function anthropicToResponsesResponse(
	upstream: JsonObject,
	nodeTarget: ProviderNodeTarget,
): JsonObject {
	const usage = extractAnthropicUsage(upstream);
	return buildResponsesResponse({
		inputTokens: usage.input_tokens,
		model: nodeTarget.requestedModel,
		outputTokens: usage.output_tokens,
		text: extractAnthropicText(upstream),
	});
}

function responsesToOpenAiChatResponse(
	upstream: JsonObject,
	nodeTarget: ProviderNodeTarget,
): JsonObject {
	const usage = extractResponsesUsage(upstream);
	return buildOpenAiChatResponse({
		completionTokens: usage.output_tokens,
		finishReason: "stop",
		model: nodeTarget.requestedModel,
		promptTokens: usage.input_tokens,
		text: extractResponsesText(upstream),
	});
}

function anthropicToOpenAiChatResponse(
	upstream: JsonObject,
	nodeTarget: ProviderNodeTarget,
): JsonObject {
	const usage = extractAnthropicUsage(upstream);
	return buildOpenAiChatResponse({
		completionTokens: usage.output_tokens,
		finishReason:
			typeof upstream.stop_reason === "string" ? upstream.stop_reason : "stop",
		model: nodeTarget.requestedModel,
		promptTokens: usage.input_tokens,
		text: extractAnthropicText(upstream),
	});
}

function openAiChatToAnthropicMessage(
	upstream: JsonObject,
	nodeTarget: ProviderNodeTarget,
): JsonObject {
	const usage = extractOpenAIUsage(upstream);
	return buildAnthropicMessage({
		inputTokens: usage.prompt_tokens,
		model: nodeTarget.requestedModel,
		outputTokens: usage.completion_tokens,
		stopReason: extractStopReason(upstream),
		text: extractAssistantText(upstream),
	});
}

function responsesToAnthropicMessage(
	upstream: JsonObject,
	nodeTarget: ProviderNodeTarget,
): JsonObject {
	const usage = extractResponsesUsage(upstream);
	return buildAnthropicMessage({
		inputTokens: usage.input_tokens,
		model: nodeTarget.requestedModel,
		outputTokens: usage.output_tokens,
		stopReason: "end_turn",
		text: extractResponsesText(upstream),
	});
}

function buildOpenAiChatResponse({
	completionTokens,
	finishReason,
	model,
	promptTokens,
	text,
}: {
	completionTokens: number;
	finishReason: string | null;
	model: string;
	promptTokens: number;
	text: string;
}): JsonObject {
	return {
		id: `chatcmpl_${cryptoId()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: text },
				finish_reason: finishReason ?? "stop",
			},
		],
		usage: {
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			total_tokens: promptTokens + completionTokens,
		},
	};
}

function buildResponsesResponse({
	inputTokens,
	model,
	outputTokens,
	text,
}: {
	inputTokens: number;
	model: string;
	outputTokens: number;
	text: string;
}): JsonObject {
	return {
		id: `resp_${cryptoId()}`,
		object: "response",
		created_at: Math.floor(Date.now() / 1000),
		status: "completed",
		model,
		output_text: text,
		output: [
			{
				id: `msg_${cryptoId()}`,
				type: "message",
				status: "completed",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text,
						annotations: [],
					},
				],
			},
		],
		usage: {
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			total_tokens: inputTokens + outputTokens,
		},
	};
}

function buildAnthropicMessage({
	inputTokens,
	model,
	outputTokens,
	stopReason,
	text,
}: {
	inputTokens: number;
	model: string;
	outputTokens: number;
	stopReason: string | null;
	text: string;
}): JsonObject {
	return {
		id: `msg_${cryptoId()}`,
		type: "message",
		role: "assistant",
		model,
		content: [{ type: "text", text }],
		stop_reason: stopReason ?? "end_turn",
		stop_sequence: null,
		usage: {
			input_tokens: inputTokens,
			output_tokens: outputTokens,
		},
	};
}

function extractAnthropicText(upstream: JsonObject): string {
	const content = upstream.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const value = part as JsonObject;
			return typeof value.text === "string" ? value.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function extractResponsesText(upstream: JsonObject): string {
	if (typeof upstream.output_text === "string") return upstream.output_text;
	const output = upstream.output;
	if (!Array.isArray(output)) return "";
	return output
		.flatMap((item) => {
			if (!item || typeof item !== "object") return [];
			const content = (item as JsonObject).content;
			return Array.isArray(content) ? content : [];
		})
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const value = part as JsonObject;
			return typeof value.text === "string" ? value.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function extractAnthropicUsage(upstream: JsonObject) {
	const usage = upstream.usage as JsonObject | undefined;
	const inputTokens = Number(usage?.input_tokens ?? 0);
	const outputTokens = Number(usage?.output_tokens ?? 0);
	return {
		input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
		output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
	};
}

function extractResponsesUsage(upstream: JsonObject) {
	const usage = upstream.usage as JsonObject | undefined;
	const inputTokens = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
	const outputTokens = Number(
		usage?.output_tokens ?? usage?.completion_tokens ?? 0,
	);
	return {
		input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
		output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
	};
}

function parseStopSequences(value: unknown): string[] | undefined {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) {
		const stop = value.filter(
			(entry): entry is string => typeof entry === "string",
		);
		return stop.length > 0 ? stop : undefined;
	}
	return undefined;
}

function writeStreamingTranslationError(
	res: ExpressResponse,
	target: string,
): void {
	res.status(501).json({
		error: {
			message: `Streaming format translation for ${target} is not available yet. Use stream=false or call the provider-native endpoint.`,
			type: "unsupported_feature",
		},
	});
}

async function fetchOpenRouterWithFallback(
	body: JsonObject,
): Promise<OpenRouterSuccess | GatewayFailure> {
	const target = resolveRouterModelTarget(
		typeof body.model === "string" ? body.model : undefined,
		getResolutionOptions(),
	);

	if (!target) {
		return {
			ok: false,
			status: 400,
			body: {
				error: {
					message:
						"Unsupported model for the embedded gateway. Use an OpenRouter model, an OpenRouter-backed agent, a model alias, or a combo with OpenRouter fallback.",
					type: "invalid_request_error",
				},
			},
		};
	}

	const fallbackModels = target.fallbackModels.filter(
		(model) =>
			!isRouterModelDisabled("openrouter", model) &&
			!isRouterModelDisabledForModelPath(model),
	);
	if (fallbackModels.length === 0) {
		return {
			ok: false,
			status: 403,
			body: {
				error: {
					message:
						"All fallback models for this route are disabled in the router registry.",
					type: "model_disabled",
					models: target.fallbackModels,
				},
			},
		};
	}

	const accounts = getProviderAccountCredentials("openrouter");
	if (accounts.length === 0) {
		return {
			ok: false,
			status: 401,
			body: {
				error: {
					message:
						"OpenRouter API key is not configured in ADE. Add it in the router dashboard provider key section to use OpenRouter-backed endpoints.",
					type: "authentication_error",
				},
			},
		};
	}

	let lastFailure: {
		account: string;
		model: string;
		status: number;
		text: string;
	} | null = null;
	for (const model of fallbackModels) {
		for (const account of accounts) {
			const upstreamBody = { ...body, model };
			const upstream = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${account.key}`,
					"HTTP-Referer": "https://github.com/per-simmons/damon-ade",
					"X-Title": "ADE Orchestrator Router",
				},
				body: JSON.stringify(upstreamBody),
			});

			if (upstream.ok) {
				markProviderAccountSuccess(account);
				return {
					ok: true,
					account,
					upstream,
					target,
					model,
				};
			}

			const text = await upstream.text().catch(() => upstream.statusText);
			lastFailure = {
				account: account.name,
				model,
				status: upstream.status,
				text,
			};
			markProviderAccountFailure({
				credential: account,
				status: upstream.status,
				text,
			});
		}
	}

	return {
		ok: false,
		status: lastFailure?.status ?? 502,
		body: {
			error: {
				message: "All OpenRouter fallback models failed.",
				type: "upstream_error",
				details: lastFailure,
				models: fallbackModels,
			},
		},
	};
}

async function pipeUpstreamResponse(
	upstream: globalThis.Response,
	res: ExpressResponse,
) {
	res.status(upstream.status);
	const contentType = upstream.headers.get("content-type");
	if (contentType) res.setHeader("Content-Type", contentType);

	for (const [key, value] of upstream.headers.entries()) {
		const lowerKey = key.toLowerCase();
		if (
			lowerKey === "content-length" ||
			lowerKey === "content-encoding" ||
			lowerKey === "transfer-encoding"
		) {
			continue;
		}
		res.setHeader(key, value);
	}

	if (!upstream.body) {
		res.end(await upstream.text());
		return;
	}

	await new Promise<void>((resolve, reject) => {
		const nodeStream = Readable.fromWeb(upstream.body as never);
		nodeStream.on("error", reject);
		res.on("finish", resolve);
		res.on("close", resolve);
		nodeStream.pipe(res);
	});
}

async function readJson(response: globalThis.Response): Promise<JsonObject> {
	const text = await response.text();
	try {
		return JSON.parse(text) as JsonObject;
	} catch {
		return {};
	}
}

function parseTokenSaverMode(value: unknown): RouterTokenSaverMode {
	if (
		typeof value === "string" &&
		TOKEN_SAVER_MODES.includes(value as RouterTokenSaverMode)
	) {
		return value as RouterTokenSaverMode;
	}
	return "rtk";
}

function extractCompressInput(body: unknown): string | null {
	if (!body || typeof body !== "object") return null;
	const input = body as { text?: unknown; input?: unknown };
	if (typeof input.text === "string") return input.text;
	if (typeof input.input === "string") return input.input;
	return null;
}

function getResolutionOptions(): RouterModelResolutionOptions {
	return {
		aliases: getRouterAliases(),
		customCombos: getRouterCustomCombos(),
		customModels: getRouterCustomModels(),
		disabledModels: getRouterDisabledModels(),
		providerNodes: getRouterProviderNodes(),
	};
}

function responsesInputToMessages(body: JsonObject): JsonObject[] {
	const messages: JsonObject[] = [];
	if (typeof body.instructions === "string") {
		messages.push({ role: "system", content: body.instructions });
	}

	if (typeof body.input === "string") {
		messages.push({ role: "user", content: body.input });
		return messages;
	}

	if (Array.isArray(body.input)) {
		for (const item of body.input) {
			if (!item || typeof item !== "object") continue;
			const value = item as JsonObject;
			messages.push({
				role: typeof value.role === "string" ? value.role : "user",
				content: extractContentText(value.content),
			});
		}
	}

	return messages.length > 0
		? messages
		: [{ role: "user", content: "Continue." }];
}

function anthropicMessagesToOpenAiMessages(body: JsonObject): JsonObject[] {
	const messages: JsonObject[] = [];
	if (typeof body.system === "string") {
		messages.push({ role: "system", content: body.system });
	}

	if (Array.isArray(body.messages)) {
		for (const item of body.messages) {
			if (!item || typeof item !== "object") continue;
			const value = item as JsonObject;
			messages.push({
				role: typeof value.role === "string" ? value.role : "user",
				content: extractContentText(value.content),
			});
		}
	}

	return messages.length > 0
		? messages
		: [{ role: "user", content: "Continue." }];
}

function extractContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object") {
				const value = part as JsonObject;
				if (typeof value.text === "string") return value.text;
				if (typeof value.content === "string") return value.content;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function extractAssistantText(upstream: JsonObject): string {
	const choices = upstream.choices;
	if (!Array.isArray(choices)) return "";
	const first = choices[0] as JsonObject | undefined;
	const message = first?.message as JsonObject | undefined;
	const content = message?.content;
	return typeof content === "string" ? content : extractContentText(content);
}

function extractStopReason(upstream: JsonObject): string | null {
	const choices = upstream.choices;
	if (!Array.isArray(choices)) return null;
	const first = choices[0] as JsonObject | undefined;
	return typeof first?.finish_reason === "string" ? first.finish_reason : null;
}

function extractOpenAIUsage(upstream: JsonObject) {
	const usage = upstream.usage as JsonObject | undefined;
	const promptTokens = Number(usage?.prompt_tokens ?? 0);
	const completionTokens = Number(usage?.completion_tokens ?? 0);
	const totalTokens = Number(
		usage?.total_tokens ?? promptTokens + completionTokens,
	);
	return {
		prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : 0,
		completion_tokens: Number.isFinite(completionTokens) ? completionTokens : 0,
		total_tokens: Number.isFinite(totalTokens) ? totalTokens : 0,
	};
}

function extractSearchQuery(body: JsonObject): string | null {
	if (typeof body.query === "string") return body.query;
	if (typeof body.q === "string") return body.q;
	if (Array.isArray(body.messages)) {
		const last = body.messages.at(-1);
		if (last && typeof last === "object") {
			return extractContentText((last as JsonObject).content);
		}
	}
	return null;
}

function toJsonObject(value: unknown): JsonObject {
	return value && typeof value === "object" ? (value as JsonObject) : {};
}

function setUsageLocals(
	res: ExpressResponse,
	{
		account,
		model,
		provider,
	}: {
		account?: RouterProviderCredential;
		model: string;
		provider: RouterProviderKeyId | "router" | "search";
	},
) {
	res.locals.routerProvider = provider;
	res.locals.routerModel = model;
	if (account) {
		res.locals.routerAccountId = account.id;
		res.locals.routerAccountName = account.name;
	}
}

function attachUsageLogger(
	req: Request,
	res: ExpressResponse,
	next: () => void,
) {
	const startedAtMs = Date.now();
	res.on("finish", () => {
		if (!shouldRecordUsage(req)) return;
		try {
			recordRouterUsage({
				endpoint: req.path,
				method: req.method,
				provider:
					typeof res.locals.routerProvider === "string"
						? res.locals.routerProvider
						: inferProviderForRequest(req.path),
				model:
					typeof res.locals.routerModel === "string"
						? res.locals.routerModel
						: inferModelForRequest(req.path, req.body),
				accountId:
					typeof res.locals.routerAccountId === "string"
						? res.locals.routerAccountId
						: null,
				accountName:
					typeof res.locals.routerAccountName === "string"
						? res.locals.routerAccountName
						: null,
				status: res.statusCode,
				success: res.statusCode < 400,
				durationMs: Date.now() - startedAtMs,
				requestTokens: estimateRequestTokens(req.body),
				responseTokens: 0,
				error: res.statusCode >= 400 ? res.statusMessage : null,
			});
		} catch (error) {
			console.error("[agent-router-gateway] Failed to record usage:", error);
		}
	});
	next();
}

function shouldRecordUsage(req: Request): boolean {
	return req.method === "POST" && req.path.startsWith("/v1/");
}

function estimateRequestTokens(body: unknown): number {
	if (Buffer.isBuffer(body)) return Math.ceil(body.byteLength / 4);
	return estimateTokens(body);
}

function inferModelForRequest(path: string, body: unknown): string {
	if (body && typeof body === "object") {
		const model = (body as JsonObject).model;
		if (typeof model === "string") return model;
	}
	if (path === "/v1/compress") return "token-saver";
	if (path === "/v1/search") return "search";
	if (path === "/v1/web/fetch") return "web-fetch";
	return "unknown";
}

function inferProviderForRequest(path: string): string {
	if (
		path.startsWith("/v1/audio/") ||
		path === "/v1/embeddings" ||
		path === "/v1/images/generations"
	) {
		return "openai";
	}
	if (path === "/v1/search") return "search";
	if (path === "/v1/web/fetch" || path === "/v1/compress") return "router";
	return "openrouter";
}

function cryptoId(): string {
	return Math.random().toString(36).slice(2, 12);
}

function listen(
	app: ReturnType<typeof createAgentRouterGatewayApp>,
	port: number,
) {
	return new Promise<Server>((resolve, reject) => {
		const candidate = createServer(app);
		candidate.once("error", reject);
		candidate.listen(port, GATEWAY_HOST, () => {
			candidate.off("error", reject);
			resolve(candidate);
		});
	});
}
