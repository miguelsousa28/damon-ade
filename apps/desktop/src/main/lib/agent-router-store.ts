import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	AGENT_ROUTER_PROFILES,
	type AgentPricing,
} from "@superset/shared/agent-router";
import type {
	RouterCustomCombo,
	RouterModelAlias,
	RouterProviderAccount,
	RouterProviderKeyId,
} from "@superset/shared/router-control-plane";
import { app } from "electron";

const MAX_USAGE_ENTRIES = 2000;

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
	providerAccounts: RouterProviderAccount[];
	usage: RouterUsageEntry[];
}

interface RouterStoreFile {
	aliases: RouterModelAlias[];
	customCombos: RouterCustomCombo[];
	providerAccounts: RouterProviderAccount[];
	accountCursor: Partial<Record<RouterProviderKeyId, number>>;
	usage: RouterUsageEntry[];
}

export function getRouterStoreSnapshot(): RouterStoreSnapshot {
	const data = readStore();
	return {
		aliases: data.aliases,
		customCombos: data.customCombos,
		providerAccounts: data.providerAccounts,
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
			providerAccounts: Array.isArray(parsed.providerAccounts)
				? parsed.providerAccounts
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
		providerAccounts: [],
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
