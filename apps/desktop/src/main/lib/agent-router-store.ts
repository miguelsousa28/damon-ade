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
} from "@superset/shared/router-control-plane";
import { app } from "electron";

const MAX_USAGE_ENTRIES = 2000;

export interface RouterUsageRecordInput {
	endpoint: string;
	method: string;
	provider?: string | null;
	model?: string | null;
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
	usage: RouterUsageEntry[];
}

interface RouterStoreFile {
	aliases: RouterModelAlias[];
	customCombos: RouterCustomCombo[];
	usage: RouterUsageEntry[];
}

export function getRouterStoreSnapshot(): RouterStoreSnapshot {
	const data = readStore();
	return {
		aliases: data.aliases,
		customCombos: data.customCombos,
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
			usage: Array.isArray(parsed.usage) ? parsed.usage : [],
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
		usage: [],
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
