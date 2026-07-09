import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	AGENT_ROUTER_PROFILES,
	type AgentPricing,
} from "@superset/shared/agent-router";
import type {
	RouterCustomCombo,
	RouterCustomModel,
	RouterDisabledModel,
	RouterModelAlias,
	RouterModelAvailabilityEntry,
	RouterModelKind,
	RouterProviderAccount,
	RouterProviderKeyId,
	RouterProviderNode,
	RouterProviderNodeApiType,
	RouterProviderNodeType,
} from "@superset/shared/router-control-plane";
import { ROUTER_PROVIDER_KEY_IDS } from "@superset/shared/router-control-plane";
import { app } from "electron";

const MAX_USAGE_ENTRIES = 2000;
const MAX_AVAILABILITY_ENTRIES = 500;

export interface RouterUsageRecordInput {
	endpoint: string;
	method: string;
	provider?: string | null;
	model?: string | null;
	accountId?: string | null;
	accountName?: string | null;
	status: number;
	success: boolean;
	durationMs: number;
	requestTokens?: number;
	responseTokens?: number;
	error?: string | null;
}

export interface RouterUsageEntry {
	id: string;
	timestamp: string;
	endpoint: string;
	method: string;
	provider: string;
	model: string;
	accountId: string | null;
	accountName: string | null;
	status: number;
	success: boolean;
	durationMs: number;
	requestTokens: number;
	responseTokens: number;
	error: string | null;
	totalTokens: number;
	estimatedCostUsd: number;
}

export interface RouterUsageStats {
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	totalTokens: number;
	estimatedCostUsd: number;
	byProvider: Array<{
		provider: string;
		requests: number;
		totalTokens: number;
		estimatedCostUsd: number;
	}>;
	recentRequests: RouterUsageEntry[];
}

export interface RouterStoreSnapshot {
	aliases: RouterModelAlias[];
	customCombos: RouterCustomCombo[];
	customModels: RouterCustomModel[];
	disabledModels: RouterDisabledModel[];
	modelAvailability: RouterModelAvailabilityEntry[];
	providerAccounts: RouterProviderAccount[];
	providerNodes: RouterProviderNode[];
	usage: RouterUsageEntry[];
}

interface RouterStoreFile {
	aliases: RouterModelAlias[];
	customCombos: RouterCustomCombo[];
	customModels: RouterCustomModel[];
	disabledModels: RouterDisabledModel[];
	modelAvailability: RouterModelAvailabilityEntry[];
	providerAccounts: RouterProviderAccount[];
	providerNodes: RouterProviderNode[];
	accountCursor: Partial<Record<RouterProviderKeyId, number>>;
	usage: RouterUsageEntry[];
}

export function getRouterStoreSnapshot(): RouterStoreSnapshot {
	const data = readStore();
	return {
		aliases: data.aliases,
		customCombos: data.customCombos,
		customModels: data.customModels,
		disabledModels: data.disabledModels,
		modelAvailability: data.modelAvailability,
		providerAccounts: data.providerAccounts,
		providerNodes: data.providerNodes,
		usage: data.usage,
	};
}

export function getRouterAliases(): RouterModelAlias[] {
	return readStore().aliases;
}

export function upsertRouterAlias(alias: RouterModelAlias): RouterModelAlias[] {
	const normalized = normalizeAlias(alias);
	const data = readStore();
	const next = [
		...data.aliases.filter((entry) => entry.alias !== normalized.alias),
		normalized,
	].sort((a, b) => a.alias.localeCompare(b.alias));
	writeStore({ ...data, aliases: next });
	return next;
}

export function deleteRouterAlias(alias: string): RouterModelAlias[] {
	const data = readStore();
	const next = data.aliases.filter((entry) => entry.alias !== alias);
	writeStore({ ...data, aliases: next });
	return next;
}

export function getRouterCustomCombos(): RouterCustomCombo[] {
	return readStore().customCombos;
}

export function upsertRouterCustomCombo(
	combo: RouterCustomCombo,
): RouterCustomCombo[] {
	const normalized = normalizeCustomCombo(combo);
	const data = readStore();
	const next = [
		...data.customCombos.filter((entry) => entry.name !== normalized.name),
		normalized,
	].sort((a, b) => a.name.localeCompare(b.name));
	writeStore({ ...data, customCombos: next });
	return next;
}

export function deleteRouterCustomCombo(name: string): RouterCustomCombo[] {
	const data = readStore();
	const next = data.customCombos.filter((entry) => entry.name !== name);
	writeStore({ ...data, customCombos: next });
	return next;
}

export function getRouterCustomModels(): RouterCustomModel[] {
	return sortCustomModels(readStore().customModels);
}

export function upsertRouterCustomModel(
	model: Partial<RouterCustomModel> & {
		id?: string;
		providerAlias?: string;
		type?: RouterModelKind;
	},
): { added: boolean; models: RouterCustomModel[] } {
	const data = readStore();
	const providerAlias = model.providerAlias?.trim() ?? "";
	const id = normalizeModelIdForProvider(providerAlias, model.id ?? "");
	const type = normalizeModelKind(model.type);
	const existing = data.customModels.find(
		(entry) =>
			entry.providerAlias === providerAlias &&
			entry.id === id &&
			entry.type === type,
	);
	const normalized = normalizeCustomModel(
		{
			...model,
			id,
			providerAlias,
			type,
		},
		existing,
	);
	if (!normalized) throw new Error("providerAlias and id are required");
	const next = [
		...data.customModels.filter(
			(entry) =>
				!(
					entry.providerAlias === normalized.providerAlias &&
					entry.id === normalized.id &&
					entry.type === normalized.type
				),
		),
		normalized,
	];
	writeStore({ ...data, customModels: sortCustomModels(next) });
	return { added: !existing, models: getRouterCustomModels() };
}

export function deleteRouterCustomModel({
	id,
	providerAlias,
	type = "llm",
}: {
	id: string;
	providerAlias: string;
	type?: RouterModelKind;
}): RouterCustomModel[] {
	const provider = providerAlias.trim();
	const normalizedId = normalizeModelIdForProvider(provider, id);
	const data = readStore();
	const next = data.customModels.filter(
		(entry) =>
			!(
				entry.providerAlias === provider &&
				entry.id === normalizedId &&
				entry.type === type
			),
	);
	writeStore({ ...data, customModels: sortCustomModels(next) });
	return getRouterCustomModels();
}

export function getRouterDisabledModels(
	providerAlias?: string,
): RouterDisabledModel[] {
	const disabled = readStore().disabledModels;
	return sortDisabledModels(
		providerAlias
			? disabled.filter((entry) => entry.providerAlias === providerAlias)
			: disabled,
	);
}

export function getRouterDisabledModelMap(): Record<string, string[]> {
	const disabled: Record<string, string[]> = {};
	for (const entry of getRouterDisabledModels()) {
		disabled[entry.providerAlias] = [
			...(disabled[entry.providerAlias] ?? []),
			entry.id,
		];
	}
	return disabled;
}

export function disableRouterModels({
	ids,
	providerAlias,
	reason,
}: {
	ids: string[];
	providerAlias: string;
	reason?: string | null;
}): RouterDisabledModel[] {
	const provider = providerAlias.trim();
	const modelIds = Array.from(
		new Set(
			ids
				.map((id) => normalizeModelIdForProvider(provider, id))
				.filter(Boolean),
		),
	);
	if (!provider || modelIds.length === 0) {
		throw new Error("providerAlias and ids are required");
	}

	const data = readStore();
	const now = new Date().toISOString();
	const next = [...data.disabledModels];
	for (const id of modelIds) {
		const index = next.findIndex(
			(entry) => entry.providerAlias === provider && entry.id === id,
		);
		if (index >= 0) {
			next[index] = {
				...next[index],
				reason: reason?.trim() || next[index].reason,
			};
			continue;
		}
		next.push({
			providerAlias: provider,
			id,
			reason: reason?.trim() || null,
			disabledAt: now,
		});
	}

	writeStore({ ...data, disabledModels: sortDisabledModels(next) });
	return getRouterDisabledModels();
}

export function enableRouterModels({
	ids,
	providerAlias,
}: {
	ids?: string[];
	providerAlias: string;
}): RouterDisabledModel[] {
	const provider = providerAlias.trim();
	if (!provider) throw new Error("providerAlias is required");
	const data = readStore();
	const normalizedIds = new Set(
		(ids ?? [])
			.map((id) => normalizeModelIdForProvider(provider, id))
			.filter(Boolean),
	);
	const removeAll = normalizedIds.size === 0;
	const next = data.disabledModels.filter((entry) => {
		if (entry.providerAlias !== provider) return true;
		return !removeAll && !normalizedIds.has(entry.id);
	});
	writeStore({ ...data, disabledModels: sortDisabledModels(next) });
	return getRouterDisabledModels();
}

export function isRouterModelDisabled(
	providerAlias: string,
	modelId: string,
): boolean {
	const provider = providerAlias.trim();
	const id = normalizeModelIdForProvider(provider, modelId);
	return readStore().disabledModels.some(
		(entry) => entry.providerAlias === provider && entry.id === id,
	);
}

export function getRouterModelAvailability(
	limit = 100,
): RouterModelAvailabilityEntry[] {
	return readStore().modelAvailability.slice(0, Math.max(0, limit));
}

export function recordRouterModelAvailability(
	input: Omit<RouterModelAvailabilityEntry, "id" | "checkedAt"> &
		Partial<Pick<RouterModelAvailabilityEntry, "checkedAt" | "id">>,
): RouterModelAvailabilityEntry {
	const data = readStore();
	const entry = normalizeAvailabilityEntry(input);
	writeStore({
		...data,
		modelAvailability: [entry, ...data.modelAvailability].slice(
			0,
			MAX_AVAILABILITY_ENTRIES,
		),
	});
	return entry;
}

export function getRouterProviderNodes(
	type?: RouterProviderNodeType,
): RouterProviderNode[] {
	const nodes = readStore().providerNodes;
	return sortProviderNodes(
		type ? nodes.filter((node) => node.type === type) : nodes,
	);
}

export function createRouterProviderNode(
	node: Omit<Partial<RouterProviderNode>, "id" | "createdAt" | "updatedAt"> & {
		baseUrl?: string;
		name?: string;
		prefix?: string;
		type?: RouterProviderNodeType;
	},
): RouterProviderNode {
	const data = readStore();
	const now = new Date().toISOString();
	const type = node.type ?? "openai-compatible";
	const normalized = normalizeProviderNode({
		id: providerNodeId(type, node.apiType),
		type,
		name: node.name ?? "",
		prefix: node.prefix ?? "",
		baseUrl: node.baseUrl ?? defaultProviderNodeBaseUrl(type),
		apiType: node.apiType,
		apiKeyProvider: node.apiKeyProvider,
		apiKeyAccountId: node.apiKeyAccountId,
		models: node.models ?? [],
		isActive: node.isActive ?? true,
		createdAt: now,
		updatedAt: now,
	});
	writeStore({
		...data,
		providerNodes: sortProviderNodes([...data.providerNodes, normalized]),
	});
	return normalized;
}

export function updateRouterProviderNode(
	id: string,
	updates: Partial<
		Pick<
			RouterProviderNode,
			| "apiKeyAccountId"
			| "apiKeyProvider"
			| "apiType"
			| "baseUrl"
			| "isActive"
			| "models"
			| "name"
			| "prefix"
			| "type"
		>
	>,
): RouterProviderNode[] {
	const data = readStore();
	const sanitizedUpdates = removeUndefinedValues(updates);
	let found = false;
	const next = data.providerNodes.map((node) => {
		if (node.id !== id) return node;
		found = true;
		return normalizeProviderNode({
			...node,
			...sanitizedUpdates,
			updatedAt: new Date().toISOString(),
		});
	});
	if (!found) throw new Error("Provider node not found");
	writeStore({ ...data, providerNodes: sortProviderNodes(next) });
	return getRouterProviderNodes();
}

export function deleteRouterProviderNode(id: string): RouterProviderNode[] {
	const data = readStore();
	writeStore({
		...data,
		providerNodes: data.providerNodes.filter((node) => node.id !== id),
	});
	return getRouterProviderNodes();
}

export function getRouterProviderAccounts(
	provider?: RouterProviderKeyId,
): RouterProviderAccount[] {
	const accounts = readStore().providerAccounts;
	return sortAccounts(
		provider
			? accounts.filter((account) => account.provider === provider)
			: accounts,
	);
}

export function createRouterProviderAccountMetadata({
	name,
	provider,
}: {
	name?: string;
	provider: RouterProviderKeyId;
}): RouterProviderAccount {
	const data = readStore();
	const providerAccounts = data.providerAccounts.filter(
		(account) => account.provider === provider,
	);
	const now = new Date().toISOString();
	const account: RouterProviderAccount = {
		id: randomUUID(),
		provider,
		name: name?.trim() || `${provider} account ${providerAccounts.length + 1}`,
		authType: "api-key",
		priority:
			providerAccounts.reduce(
				(max, candidate) => Math.max(max, candidate.priority),
				0,
			) + 1,
		isActive: true,
		createdAt: now,
		updatedAt: now,
		lastUsedAt: null,
		consecutiveUseCount: 0,
		requestCount: 0,
		failureCount: 0,
		backoffLevel: 0,
		rateLimitedUntil: null,
		lastError: null,
	};
	writeStore({
		...data,
		providerAccounts: sortAccounts([...data.providerAccounts, account]),
	});
	return account;
}

export function updateRouterProviderAccountMetadata(
	id: string,
	updates: Partial<
		Pick<
			RouterProviderAccount,
			| "backoffLevel"
			| "consecutiveUseCount"
			| "failureCount"
			| "isActive"
			| "lastError"
			| "lastUsedAt"
			| "name"
			| "priority"
			| "rateLimitedUntil"
			| "requestCount"
		>
	>,
): RouterProviderAccount[] {
	const data = readStore();
	const next = data.providerAccounts.map((account) =>
		account.id === id
			? {
					...account,
					...sanitizeProviderAccountUpdates(updates),
					updatedAt: new Date().toISOString(),
				}
			: account,
	);
	writeStore({ ...data, providerAccounts: sortAccounts(next) });
	return getRouterProviderAccounts();
}

export function deleteRouterProviderAccountMetadata(
	id: string,
): RouterProviderAccount[] {
	const data = readStore();
	writeStore({
		...data,
		providerAccounts: data.providerAccounts.filter(
			(account) => account.id !== id,
		),
	});
	return getRouterProviderAccounts();
}

export function recordRouterProviderAccountSuccess(id: string): void {
	const account = getRouterProviderAccounts().find(
		(candidate) => candidate.id === id,
	);
	if (!account) return;
	updateRouterProviderAccountMetadata(id, {
		backoffLevel: 0,
		consecutiveUseCount: account.consecutiveUseCount + 1,
		lastError: null,
		lastUsedAt: new Date().toISOString(),
		rateLimitedUntil: null,
		requestCount: account.requestCount + 1,
	});
}

export function recordRouterProviderAccountFailure({
	backoffLevel,
	cooldownMs,
	id,
	message,
	status,
}: {
	backoffLevel: number;
	cooldownMs: number;
	id: string;
	message: string;
	status?: number;
}): void {
	const account = getRouterProviderAccounts().find(
		(candidate) => candidate.id === id,
	);
	if (!account) return;
	updateRouterProviderAccountMetadata(id, {
		backoffLevel,
		consecutiveUseCount: 0,
		failureCount: account.failureCount + 1,
		lastError: {
			status,
			message,
			timestamp: new Date().toISOString(),
		},
		rateLimitedUntil:
			cooldownMs > 0 ? new Date(Date.now() + cooldownMs).toISOString() : null,
	});
}

export function selectRouterProviderAccounts(
	provider: RouterProviderKeyId,
): RouterProviderAccount[] {
	const data = readStore();
	const available = sortAccounts(
		data.providerAccounts.filter(
			(account) =>
				account.provider === provider &&
				account.isActive &&
				!isCooldownActive(account.rateLimitedUntil),
		),
	);
	if (available.length === 0) return [];

	const cursor = data.accountCursor[provider] ?? 0;
	const start = cursor % available.length;
	const ordered = [...available.slice(start), ...available.slice(0, start)];
	writeStore({
		...data,
		accountCursor: {
			...data.accountCursor,
			[provider]: (start + 1) % available.length,
		},
	});
	return ordered;
}

export function recordRouterUsage(input: RouterUsageRecordInput): void {
	const requestTokens = Math.max(0, Math.round(input.requestTokens ?? 0));
	const responseTokens = Math.max(0, Math.round(input.responseTokens ?? 0));
	const provider = input.provider || inferProvider(input.model) || "router";
	const model = input.model || "unknown";
	const totalTokens = requestTokens + responseTokens;
	const data = readStore();
	const entry: RouterUsageEntry = {
		id: randomUUID(),
		timestamp: new Date().toISOString(),
		endpoint: input.endpoint,
		method: input.method,
		provider,
		model,
		accountId: input.accountId ?? null,
		accountName: input.accountName ?? null,
		status: input.status,
		success: input.success,
		durationMs: Math.max(0, Math.round(input.durationMs)),
		requestTokens,
		responseTokens,
		totalTokens,
		error: input.error ?? null,
		estimatedCostUsd: estimateModelCostUsd(
			model,
			requestTokens,
			responseTokens,
		),
	};

	writeStore({
		...data,
		usage: [entry, ...data.usage].slice(0, MAX_USAGE_ENTRIES),
	});
}

export function getRouterUsageStats(limit = 50): RouterUsageStats {
	const usage = readStore().usage;
	const byProviderMap = new Map<
		string,
		{
			provider: string;
			requests: number;
			totalTokens: number;
			estimatedCostUsd: number;
		}
	>();

	for (const entry of usage) {
		const bucket = byProviderMap.get(entry.provider) ?? {
			provider: entry.provider,
			requests: 0,
			totalTokens: 0,
			estimatedCostUsd: 0,
		};
		bucket.requests++;
		bucket.totalTokens += entry.totalTokens;
		bucket.estimatedCostUsd += entry.estimatedCostUsd;
		byProviderMap.set(entry.provider, bucket);
	}

	return {
		totalRequests: usage.length,
		successfulRequests: usage.filter((entry) => entry.success).length,
		failedRequests: usage.filter((entry) => !entry.success).length,
		totalTokens: usage.reduce((sum, entry) => sum + entry.totalTokens, 0),
		estimatedCostUsd: roundCurrency(
			usage.reduce((sum, entry) => sum + entry.estimatedCostUsd, 0),
		),
		byProvider: Array.from(byProviderMap.values())
			.map((entry) => ({
				...entry,
				estimatedCostUsd: roundCurrency(entry.estimatedCostUsd),
			}))
			.sort((a, b) => b.requests - a.requests),
		recentRequests: usage.slice(0, limit),
	};
}

export function clearRouterUsage(): RouterUsageStats {
	const data = readStore();
	writeStore({ ...data, usage: [] });
	return getRouterUsageStats();
}

export function estimateTokens(value: unknown): number {
	if (value === undefined || value === null) return 0;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return Math.ceil(text.length / 4);
}

function normalizeAlias(alias: RouterModelAlias): RouterModelAlias {
	const normalized = {
		alias: alias.alias.trim(),
		targetModel: alias.targetModel.trim(),
	};
	if (!normalized.alias || !normalized.targetModel) {
		throw new Error("Alias and target model are required");
	}
	if (normalized.alias === normalized.targetModel) {
		throw new Error("Alias cannot point to itself");
	}
	return normalized;
}

function normalizeCustomCombo(combo: RouterCustomCombo): RouterCustomCombo {
	const normalized = {
		name: combo.name.trim(),
		models: combo.models.map((model) => model.trim()).filter(Boolean),
	};
	if (!normalized.name || normalized.models.length === 0) {
		throw new Error("Combo name and at least one model are required");
	}
	return normalized;
}

function normalizeCustomModel(
	model: Partial<RouterCustomModel>,
	existing?: RouterCustomModel,
): RouterCustomModel | null {
	const providerAlias = model.providerAlias?.trim() ?? "";
	const id = normalizeModelIdForProvider(providerAlias, model.id ?? "");
	const type = normalizeModelKind(model.type);
	if (!providerAlias || !id) return null;
	const now = new Date().toISOString();
	return {
		providerAlias,
		id,
		type,
		name: model.name?.trim() || existing?.name || id,
		createdAt: existing?.createdAt ?? model.createdAt ?? now,
		updatedAt: now,
	};
}

function normalizeDisabledModel(
	model: Partial<RouterDisabledModel>,
): RouterDisabledModel | null {
	const providerAlias = model.providerAlias?.trim() ?? "";
	const id = normalizeModelIdForProvider(providerAlias, model.id ?? "");
	if (!providerAlias || !id) return null;
	return {
		providerAlias,
		id,
		reason: model.reason?.trim() || null,
		disabledAt: model.disabledAt ?? new Date().toISOString(),
	};
}

function normalizeAvailabilityEntry(
	entry: Partial<RouterModelAvailabilityEntry>,
): RouterModelAvailabilityEntry {
	const model = entry.model?.trim() || "unknown";
	const provider = entry.provider?.trim() || inferProvider(model) || "router";
	return {
		id: entry.id ?? randomUUID(),
		provider,
		model,
		kind: normalizeModelKind(entry.kind),
		status:
			entry.status === "available" ||
			entry.status === "unavailable" ||
			entry.status === "cooldown"
				? entry.status
				: "unavailable",
		checkedAt: entry.checkedAt ?? new Date().toISOString(),
		latencyMs:
			typeof entry.latencyMs === "number" && Number.isFinite(entry.latencyMs)
				? Math.max(0, Math.round(entry.latencyMs))
				: null,
		httpStatus:
			typeof entry.httpStatus === "number" && Number.isFinite(entry.httpStatus)
				? Math.round(entry.httpStatus)
				: null,
		error: entry.error?.trim() || null,
		method: entry.method?.trim() || null,
	};
}

function normalizeModelKind(value: unknown): RouterModelKind {
	if (
		value === "llm" ||
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

function normalizeModelIdForProvider(
	providerAlias: string,
	modelId: string,
): string {
	let id = modelId.trim();
	const provider = providerAlias.trim();
	if (provider && id.startsWith(`${provider}/`)) {
		id = id.slice(provider.length + 1);
	}
	return id;
}

function normalizeProviderNode(node: RouterProviderNode): RouterProviderNode {
	const type = isProviderNodeType(node.type) ? node.type : "openai-compatible";
	const prefix = node.prefix.trim().replace(/^\/+|\/+$/g, "");
	const normalized: RouterProviderNode = {
		id: node.id || providerNodeId(type, node.apiType),
		type,
		name: node.name.trim() || prefix || "Provider node",
		prefix,
		baseUrl: sanitizeProviderNodeBaseUrl(
			node.baseUrl || defaultProviderNodeBaseUrl(type),
			type,
		),
		apiKeyProvider: isRouterProviderKeyId(node.apiKeyProvider)
			? node.apiKeyProvider
			: defaultProviderNodeKeyProvider(type),
		apiKeyAccountId: node.apiKeyAccountId?.trim() || null,
		models: Array.from(
			new Set(
				(Array.isArray(node.models) ? node.models : [])
					.map((model) => model.trim())
					.filter(Boolean),
			),
		).sort((a, b) => a.localeCompare(b)),
		isActive: node.isActive !== false,
		createdAt: node.createdAt || new Date().toISOString(),
		updatedAt: node.updatedAt || new Date().toISOString(),
	};

	if (type === "openai-compatible") {
		normalized.apiType =
			node.apiType === "responses" || node.apiType === "chat"
				? node.apiType
				: "chat";
	}

	if (!normalized.prefix) throw new Error("Provider node prefix is required");
	if (!normalized.baseUrl)
		throw new Error("Provider node base URL is required");

	return normalized;
}

function sanitizeProviderNodeBaseUrl(
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

function providerNodeId(
	type: RouterProviderNodeType,
	apiType?: RouterProviderNodeApiType,
): string {
	if (type === "openai-compatible") {
		return `openai-compatible-${apiType === "responses" ? "responses" : "chat"}-${randomUUID()}`;
	}
	if (type === "anthropic-compatible") {
		return `anthropic-compatible-${randomUUID()}`;
	}
	return `custom-embedding-${randomUUID()}`;
}

function isProviderNodeType(value: unknown): value is RouterProviderNodeType {
	return (
		value === "openai-compatible" ||
		value === "anthropic-compatible" ||
		value === "custom-embedding"
	);
}

function isRouterProviderKeyId(value: unknown): value is RouterProviderKeyId {
	return (
		typeof value === "string" &&
		ROUTER_PROVIDER_KEY_IDS.includes(value as RouterProviderKeyId)
	);
}

function sortProviderNodes(nodes: RouterProviderNode[]): RouterProviderNode[] {
	return [...nodes].sort(
		(a, b) => a.prefix.localeCompare(b.prefix) || a.name.localeCompare(b.name),
	);
}

function removeUndefinedValues<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as Partial<T>;
}

function readStore(): RouterStoreFile {
	const path = getStorePath();
	if (!existsSync(path)) return emptyStore();

	try {
		const parsed = JSON.parse(
			readFileSync(path, "utf8"),
		) as Partial<RouterStoreFile>;
		return {
			aliases: Array.isArray(parsed.aliases) ? parsed.aliases : [],
			customCombos: Array.isArray(parsed.customCombos)
				? parsed.customCombos
				: [],
			customModels: Array.isArray(parsed.customModels)
				? sortCustomModels(
						parsed.customModels
							.map((model) =>
								normalizeCustomModel(model as Partial<RouterCustomModel>),
							)
							.filter((model): model is RouterCustomModel => Boolean(model)),
					)
				: [],
			disabledModels: Array.isArray(parsed.disabledModels)
				? sortDisabledModels(
						parsed.disabledModels
							.map((model) =>
								normalizeDisabledModel(model as Partial<RouterDisabledModel>),
							)
							.filter((model): model is RouterDisabledModel => Boolean(model)),
					)
				: [],
			modelAvailability: Array.isArray(parsed.modelAvailability)
				? parsed.modelAvailability
						.map((entry) =>
							normalizeAvailabilityEntry(
								entry as Partial<RouterModelAvailabilityEntry>,
							),
						)
						.filter(Boolean)
						.slice(0, MAX_AVAILABILITY_ENTRIES)
				: [],
			providerAccounts: Array.isArray(parsed.providerAccounts)
				? parsed.providerAccounts
				: [],
			providerNodes: Array.isArray(parsed.providerNodes)
				? parsed.providerNodes
						.map((node) => normalizeProviderNode(node as RouterProviderNode))
						.filter(Boolean)
				: [],
			accountCursor:
				parsed.accountCursor && typeof parsed.accountCursor === "object"
					? parsed.accountCursor
					: {},
			usage: Array.isArray(parsed.usage)
				? parsed.usage.map(normalizeUsageEntry)
				: [],
		};
	} catch (error) {
		console.error("[agent-router-store] Failed to read store:", error);
		return emptyStore();
	}
}

function writeStore(data: RouterStoreFile): void {
	const path = getStorePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function emptyStore(): RouterStoreFile {
	return {
		aliases: [],
		customCombos: [],
		customModels: [],
		disabledModels: [],
		modelAvailability: [],
		providerAccounts: [],
		providerNodes: [],
		accountCursor: {},
		usage: [],
	};
}

function normalizeUsageEntry(
	entry: Partial<RouterUsageEntry>,
): RouterUsageEntry {
	return {
		id: entry.id ?? randomUUID(),
		timestamp: entry.timestamp ?? new Date().toISOString(),
		endpoint: entry.endpoint ?? "unknown",
		method: entry.method ?? "POST",
		provider: entry.provider ?? "router",
		model: entry.model ?? "unknown",
		accountId: entry.accountId ?? null,
		accountName: entry.accountName ?? null,
		status: entry.status ?? 0,
		success: entry.success ?? false,
		durationMs: entry.durationMs ?? 0,
		requestTokens: entry.requestTokens ?? 0,
		responseTokens: entry.responseTokens ?? 0,
		error: entry.error ?? null,
		totalTokens:
			entry.totalTokens ??
			(entry.requestTokens ?? 0) + (entry.responseTokens ?? 0),
		estimatedCostUsd: entry.estimatedCostUsd ?? 0,
	};
}

function getStorePath(): string {
	return join(app.getPath("userData"), "agent-router-state.json");
}

function inferProvider(model?: string | null): string | null {
	if (!model) return null;
	if (model.startsWith("openrouter/") || model.includes("/"))
		return "openrouter";
	const profile =
		AGENT_ROUTER_PROFILES[model as keyof typeof AGENT_ROUTER_PROFILES];
	return profile?.provider ?? null;
}

function estimateModelCostUsd(
	model: string,
	inputTokens: number,
	outputTokens: number,
): number {
	const pricing = findPricing(model);
	if (!pricing) return 0;
	return roundCurrency(
		(inputTokens / 1_000_000) * pricing.inputPerMillion +
			(outputTokens / 1_000_000) * pricing.outputPerMillion,
	);
}

function findPricing(model: string): AgentPricing | null {
	const normalized = model.startsWith("openrouter/")
		? model.slice("openrouter/".length)
		: model;
	const profile = Object.values(AGENT_ROUTER_PROFILES).find(
		(entry) => entry.modelId === normalized || entry.agent === normalized,
	);
	return profile?.pricing ?? null;
}

function roundCurrency(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

function sortAccounts(
	accounts: RouterProviderAccount[],
): RouterProviderAccount[] {
	return [...accounts].sort(
		(a, b) => a.priority - b.priority || a.name.localeCompare(b.name),
	);
}

function sortCustomModels(models: RouterCustomModel[]): RouterCustomModel[] {
	return [...models].sort(
		(a, b) =>
			a.providerAlias.localeCompare(b.providerAlias) ||
			a.id.localeCompare(b.id) ||
			a.type.localeCompare(b.type),
	);
}

function sortDisabledModels(
	models: RouterDisabledModel[],
): RouterDisabledModel[] {
	return [...models].sort(
		(a, b) =>
			a.providerAlias.localeCompare(b.providerAlias) ||
			a.id.localeCompare(b.id),
	);
}

function isCooldownActive(rateLimitedUntil: string | null): boolean {
	if (!rateLimitedUntil) return false;
	return new Date(rateLimitedUntil).getTime() > Date.now();
}

function sanitizeProviderAccountUpdates(
	updates: Partial<RouterProviderAccount>,
): Partial<RouterProviderAccount> {
	const sanitized = Object.fromEntries(
		Object.entries(updates).filter(([, value]) => value !== undefined),
	) as Partial<RouterProviderAccount>;
	if (sanitized.name !== undefined) {
		sanitized.name = sanitized.name.trim();
	}
	if (sanitized.priority !== undefined) {
		sanitized.priority = Math.max(1, Math.round(sanitized.priority));
	}
	return sanitized;
}
