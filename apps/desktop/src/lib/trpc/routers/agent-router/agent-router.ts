import { classifyFallbackError } from "@superset/shared/agent-router";
import {
	buildRouterDashboardSnapshot,
	previewRouterTokenSaver,
	ROUTER_PROVIDER_KEY_IDS,
	TOKEN_SAVER_MODES,
} from "@superset/shared/router-control-plane";
import {
	createRouterProviderAccount,
	deleteRouterProviderAccount,
	listRouterProviderAccountViews,
	updateRouterProviderAccount,
} from "main/lib/agent-router-accounts";
import {
	getAgentRouterGatewayStatus,
	startAgentRouterGateway,
	stopAgentRouterGateway,
} from "main/lib/agent-router-gateway";
import {
	clearRouterUsage,
	createRouterProviderNode,
	deleteRouterAlias,
	deleteRouterCustomCombo,
	deleteRouterProviderNode,
	getRouterAliases,
	getRouterCustomCombos,
	getRouterProviderNodes,
	getRouterUsageStats,
	updateRouterProviderNode,
	upsertRouterAlias,
	upsertRouterCustomCombo,
} from "main/lib/agent-router-store";
import { getProviderKeyStatus } from "main/lib/provider-keys";
import { z } from "zod";
import { publicProcedure, router } from "../..";

const tokenSaverModeSchema = z.enum(TOKEN_SAVER_MODES);
const providerKeySchema = z.enum(ROUTER_PROVIDER_KEY_IDS);
const providerNodeTypeSchema = z.enum([
	"openai-compatible",
	"anthropic-compatible",
	"custom-embedding",
]);
const providerNodeApiTypeSchema = z.enum(["chat", "responses"]);
const providerNodeInputSchema = z.object({
	apiKeyAccountId: z.string().nullable().optional(),
	apiKeyProvider: providerKeySchema.optional(),
	apiType: providerNodeApiTypeSchema.optional(),
	baseUrl: z.string().min(1).optional(),
	isActive: z.boolean().optional(),
	models: z.array(z.string()).optional(),
	name: z.string().min(1).optional(),
	prefix: z.string().min(1).optional(),
	type: providerNodeTypeSchema.optional(),
});

export const createAgentRouterRouter = () => {
	return router({
		dashboard: publicProcedure.query(() =>
			buildRouterDashboardSnapshot({
				providerKeyStatus: getProviderKeyStatus(),
				gateway: getAgentRouterGatewayStatus(),
			}),
		),

		gatewayStatus: publicProcedure.query(() => getAgentRouterGatewayStatus()),

		startGateway: publicProcedure.mutation(() => startAgentRouterGateway()),

		stopGateway: publicProcedure.mutation(async () => {
			await stopAgentRouterGateway();
			return getAgentRouterGatewayStatus();
		}),

		restartGateway: publicProcedure.mutation(async () => {
			await stopAgentRouterGateway();
			return startAgentRouterGateway();
		}),

		providerAccounts: publicProcedure
			.input(z.object({ provider: providerKeySchema.optional() }).optional())
			.query(({ input }) => listRouterProviderAccountViews(input?.provider)),

		createProviderAccount: publicProcedure
			.input(
				z.object({
					provider: providerKeySchema,
					name: z.string().optional(),
					key: z.string().min(1),
				}),
			)
			.mutation(({ input }) => createRouterProviderAccount(input)),

		updateProviderAccount: publicProcedure
			.input(
				z.object({
					id: z.string().min(1),
					name: z.string().optional(),
					key: z.string().optional(),
					isActive: z.boolean().optional(),
					priority: z.number().int().positive().optional(),
				}),
			)
			.mutation(({ input }) => updateRouterProviderAccount(input)),

		deleteProviderAccount: publicProcedure
			.input(z.object({ id: z.string().min(1) }))
			.mutation(({ input }) => deleteRouterProviderAccount(input.id)),

		usageStats: publicProcedure.query(() => getRouterUsageStats()),

		clearUsage: publicProcedure.mutation(() => clearRouterUsage()),

		aliases: publicProcedure.query(() => getRouterAliases()),

		upsertAlias: publicProcedure
			.input(
				z.object({
					alias: z.string().min(1),
					targetModel: z.string().min(1),
				}),
			)
			.mutation(({ input }) => upsertRouterAlias(input)),

		deleteAlias: publicProcedure
			.input(z.object({ alias: z.string().min(1) }))
			.mutation(({ input }) => deleteRouterAlias(input.alias)),

		customCombos: publicProcedure.query(() => getRouterCustomCombos()),

		providerNodes: publicProcedure
			.input(z.object({ type: providerNodeTypeSchema.optional() }).optional())
			.query(({ input }) => getRouterProviderNodes(input?.type)),

		createProviderNode: publicProcedure
			.input(
				providerNodeInputSchema.extend({
					baseUrl: z.string().min(1),
					name: z.string().min(1),
					prefix: z.string().min(1),
				}),
			)
			.mutation(({ input }) => createRouterProviderNode(input)),

		updateProviderNode: publicProcedure
			.input(
				providerNodeInputSchema.extend({
					id: z.string().min(1),
				}),
			)
			.mutation(({ input }) => {
				const { id, ...updates } = input;
				return updateRouterProviderNode(id, updates);
			}),

		deleteProviderNode: publicProcedure
			.input(z.object({ id: z.string().min(1) }))
			.mutation(({ input }) => deleteRouterProviderNode(input.id)),

		upsertCustomCombo: publicProcedure
			.input(
				z.object({
					name: z.string().min(1),
					models: z.array(z.string().min(1)).min(1),
				}),
			)
			.mutation(({ input }) => upsertRouterCustomCombo(input)),

		deleteCustomCombo: publicProcedure
			.input(z.object({ name: z.string().min(1) }))
			.mutation(({ input }) => deleteRouterCustomCombo(input.name)),

		previewTokenSaver: publicProcedure
			.input(
				z.object({
					text: z.string(),
					mode: tokenSaverModeSchema.default("rtk"),
				}),
			)
			.mutation(({ input }) =>
				previewRouterTokenSaver({
					text: input.text,
					mode: input.mode,
				}),
			),

		classifyFallback: publicProcedure
			.input(
				z.object({
					status: z.number().int().optional(),
					text: z.string().optional(),
					backoffLevel: z.number().int().min(0).default(0),
				}),
			)
			.query(({ input }) => classifyFallbackError(input)),
	});
};

export type AgentRouterRouter = ReturnType<typeof createAgentRouterRouter>;
