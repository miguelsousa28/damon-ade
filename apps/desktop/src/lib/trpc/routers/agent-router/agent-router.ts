import { classifyFallbackError } from "@superset/shared/agent-router";
import {
	buildRouterDashboardSnapshot,
	previewRouterTokenSaver,
	TOKEN_SAVER_MODES,
} from "@superset/shared/router-control-plane";
import { getProviderKeyStatus } from "main/lib/provider-keys";
import { z } from "zod";
import { publicProcedure, router } from "../..";

const tokenSaverModeSchema = z.enum(TOKEN_SAVER_MODES);

export const createAgentRouterRouter = () => {
	return router({
		dashboard: publicProcedure.query(() =>
			buildRouterDashboardSnapshot({
				providerKeyStatus: getProviderKeyStatus(),
			}),
		),

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
