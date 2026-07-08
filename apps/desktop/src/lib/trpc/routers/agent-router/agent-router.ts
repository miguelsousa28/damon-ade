import { classifyFallbackError } from "@superset/shared/agent-router";
import {
	buildRouterDashboardSnapshot,
	previewRouterTokenSaver,
	TOKEN_SAVER_MODES,
} from "@superset/shared/router-control-plane";
import {
	getAgentRouterGatewayStatus,
	startAgentRouterGateway,
	stopAgentRouterGateway,
} from "main/lib/agent-router-gateway";
import {
	clearRouterUsage,
	deleteRouterAlias,
	deleteRouterCustomCombo,
	getRouterAliases,
	getRouterCustomCombos,
	getRouterUsageStats,
	upsertRouterAlias,
	upsertRouterCustomCombo,
} from "main/lib/agent-router-store";
import { getProviderKeyStatus } from "main/lib/provider-keys";
import { z } from "zod";
import { publicProcedure, router } from "../..";

const tokenSaverModeSchema = z.enum(TOKEN_SAVER_MODES);

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
