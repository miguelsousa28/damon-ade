import { classifyFallbackError } from "@superset/shared/agent-router";
import type {
	RouterProviderAccount,
	RouterProviderAccountAuthType,
	RouterProviderKeyId,
} from "@superset/shared/router-control-plane";
import {
	createRouterProviderAccountMetadata,
	deleteRouterProviderAccountMetadata,
	getRouterProviderAccounts,
	recordRouterProviderAccountFailure,
	recordRouterProviderAccountSuccess,
	selectRouterProviderAccounts,
	updateRouterProviderAccountMetadata,
} from "./agent-router-store";
import {
	clearProviderAccountKey,
	getProviderAccountKey,
	getProviderKey,
	hasProviderAccountKey,
	setProviderAccountKey,
} from "./provider-keys";

export interface RouterProviderCredential {
	id: string;
	name: string;
	provider: RouterProviderKeyId;
	key: string;
	legacy: boolean;
}

export interface RouterProviderAccountView extends RouterProviderAccount {
	hasKey: boolean;
}

export function listRouterProviderAccountViews(
	provider?: RouterProviderKeyId,
): RouterProviderAccountView[] {
	return getRouterProviderAccounts(provider).map((account) => ({
		...account,
		hasKey: hasProviderAccountKey(account.provider, account.id),
	}));
}

export function createRouterProviderAccount({
	authType,
	email,
	expiresAt,
	key,
	name,
	provider,
	providerSpecificData,
}: {
	authType?: RouterProviderAccountAuthType;
	email?: string | null;
	expiresAt?: string | null;
	key: string;
	name?: string;
	provider: RouterProviderKeyId;
	providerSpecificData?: Record<string, unknown>;
}): RouterProviderAccountView[] {
	const account = createRouterProviderAccountMetadata({
		authType,
		email,
		expiresAt,
		name,
		provider,
		providerSpecificData,
	});
	try {
		setProviderAccountKey(provider, account.id, key);
	} catch (error) {
		deleteRouterProviderAccountMetadata(account.id);
		throw error;
	}
	return listRouterProviderAccountViews(provider);
}

export function updateRouterProviderAccount({
	id,
	authType,
	email,
	expiresAt,
	isActive,
	key,
	name,
	priority,
	providerSpecificData,
}: {
	id: string;
	authType?: RouterProviderAccountAuthType;
	email?: string | null;
	expiresAt?: string | null;
	isActive?: boolean;
	key?: string;
	name?: string;
	priority?: number;
	providerSpecificData?: Record<string, unknown>;
}): RouterProviderAccountView[] {
	const account = getRouterProviderAccounts().find(
		(candidate) => candidate.id === id,
	);
	if (!account) throw new Error("Provider account not found");

	if (key?.trim()) {
		setProviderAccountKey(account.provider, account.id, key);
	}

	updateRouterProviderAccountMetadata(id, {
		authType,
		email,
		expiresAt,
		isActive,
		name,
		priority,
		providerSpecificData,
	});
	return listRouterProviderAccountViews(account.provider);
}

export function deleteRouterProviderAccount(
	id: string,
): RouterProviderAccountView[] {
	const account = getRouterProviderAccounts().find(
		(candidate) => candidate.id === id,
	);
	if (!account) return listRouterProviderAccountViews();
	clearProviderAccountKey(account.provider, account.id);
	deleteRouterProviderAccountMetadata(id);
	return listRouterProviderAccountViews(account.provider);
}

export function getProviderAccountCredentials(
	provider: RouterProviderKeyId,
): RouterProviderCredential[] {
	const credentials: RouterProviderCredential[] = [];
	for (const account of selectRouterProviderAccounts(provider)) {
		const key = getProviderAccountKey(provider, account.id);
		if (!key) continue;
		credentials.push({
			id: account.id,
			name: account.name,
			provider,
			key,
			legacy: false,
		});
	}

	if (credentials.length > 0) return credentials;

	const legacyKey = getProviderKey(provider);
	return legacyKey
		? [
				{
					id: provider,
					name: "Default key",
					provider,
					key: legacyKey,
					legacy: true,
				},
			]
		: [];
}

export function markProviderAccountSuccess(
	credential: RouterProviderCredential,
): void {
	if (credential.legacy) return;
	recordRouterProviderAccountSuccess(credential.id);
}

export function markProviderAccountFailure({
	credential,
	status,
	text,
}: {
	credential: RouterProviderCredential;
	status?: number;
	text?: string;
}): void {
	if (credential.legacy) return;
	const account = getRouterProviderAccounts().find(
		(candidate) => candidate.id === credential.id,
	);
	const decision = classifyFallbackError({
		status,
		text,
		backoffLevel: account?.backoffLevel ?? 0,
	});
	recordRouterProviderAccountFailure({
		backoffLevel: decision.backoffLevel,
		cooldownMs: decision.cooldownMs,
		id: credential.id,
		message: text || `HTTP ${status ?? "unknown"}`,
		status,
	});
}
