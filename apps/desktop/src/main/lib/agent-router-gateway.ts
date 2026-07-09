import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { AGENT_COMBOS } from "@superset/shared/agent-router";
import {
	buildOpenAIModelList,
	previewRouterTokenSaver,
	type RouterGatewayStatus,
	type RouterModelResolutionOptions,
	type RouterModelTarget,
	type RouterProviderKeyId,
	type RouterTokenSaverMode,
	resolveRouterModelTarget,
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
	deleteRouterAlias,
	deleteRouterCustomCombo,
	estimateTokens,
	getRouterAliases,
	getRouterCustomCombos,
	getRouterUsageStats,
	recordRouterUsage,
	upsertRouterAlias,
	upsertRouterCustomCombo,
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
		res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
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
	app.post("/v1/embeddings", (req, res) =>
		handleOpenAIProxy(req, res, "/embeddings"),
	);
	app.post("/v1/images/generations", (req, res) =>
		handleOpenAIProxy(req, res, "/images/generations"),
	);
	app.post("/v1/audio/speech", (req, res) =>
		handleOpenAIProxy(req, res, "/audio/speech"),
	);
	app.post("/v1/search", handleSearch);
	app.post("/v1/web/fetch", handleWebFetch);

	app.get("/api/usage/stats", (_req, res) => {
		res.json(getRouterUsageStats());
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
	const result = await fetchOpenRouterWithFallback(req.body ?? {});
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
	for (const model of target.fallbackModels) {
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
				models: target.fallbackModels,
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
