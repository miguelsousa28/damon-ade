import { describe, expect, it } from "bun:test";
import {
	buildOpenAIModelList,
	buildRouterDashboardSnapshot,
	previewRouterTokenSaver,
	ROUTER_ENDPOINTS,
	ROUTER_TOKEN_SAVERS,
	resolveRouterModelTarget,
} from "./router-control-plane";

describe("router control plane", () => {
	it("builds a dashboard snapshot with provider key presence", () => {
		const snapshot = buildRouterDashboardSnapshot({
			providerKeyStatus: { openrouter: true },
			now: new Date("2026-07-08T12:00:00.000Z"),
		});

		expect(snapshot.generatedAt).toBe("2026-07-08T12:00:00.000Z");
		expect(snapshot.stats.providers).toBeGreaterThan(0);
		expect(snapshot.stats.endpoints).toBe(ROUTER_ENDPOINTS.length);
		expect(snapshot.stats.tokenSavers).toBe(ROUTER_TOKEN_SAVERS.length);
		expect(
			snapshot.providers.find((provider) => provider.id === "openrouter")
				?.keyConfigured,
		).toBe(true);
	});

	it("previews native token saver modes", () => {
		const text = [
			"Sure, here is the output:",
			...Array.from({ length: 260 }, (_, index) => `line ${index}`),
			"Finished",
		].join("\n");

		const preview = previewRouterTokenSaver({ text, mode: "ponytail" });

		expect(preview.mode).toBe("ponytail");
		expect(preview.result.changed).toBe(true);
		expect(preview.result.savedBytes).toBeGreaterThan(0);
	});

	it("exports OpenAI-compatible model and combo names", () => {
		const list = buildOpenAIModelList({
			aliases: [{ alias: "fast-code", targetModel: "openrouter/z-ai/glm-5.2" }],
			customCombos: [{ name: "my-budget-stack", models: ["glm", "minimax"] }],
			customModels: [
				{
					providerAlias: "local",
					id: "manual-model",
					type: "llm",
					name: "Manual Model",
					createdAt: "2026-07-09T00:00:00.000Z",
					updatedAt: "2026-07-09T00:00:00.000Z",
				},
			],
			disabledModels: [
				{
					providerAlias: "local",
					id: "qwen3-coder",
					reason: "cooldown",
					disabledAt: "2026-07-09T00:00:00.000Z",
				},
			],
			providerNodes: [
				{
					id: "openai-compatible-chat-local",
					type: "openai-compatible",
					name: "Local OpenAI",
					prefix: "local",
					baseUrl: "http://127.0.0.1:1234/v1",
					apiType: "chat",
					apiKeyProvider: "openai",
					apiKeyAccountId: null,
					models: ["qwen3-coder"],
					isActive: true,
					createdAt: "2026-07-09T00:00:00.000Z",
					updatedAt: "2026-07-09T00:00:00.000Z",
				},
				{
					id: "anthropic-compatible-paused",
					type: "anthropic-compatible",
					name: "Paused Anthropic",
					prefix: "paused",
					baseUrl: "http://127.0.0.1:3000/v1",
					apiKeyProvider: "anthropic",
					apiKeyAccountId: null,
					models: ["claude-local"],
					isActive: false,
					createdAt: "2026-07-09T00:00:00.000Z",
					updatedAt: "2026-07-09T00:00:00.000Z",
				},
			],
		});
		const ids = list.data.map((model) => model.id);

		expect(list.object).toBe("list");
		expect(ids).toContain("premium-coding");
		expect(ids).toContain("glm");
		expect(ids).toContain("openrouter/z-ai/glm-5.2");
		expect(ids).toContain("fast-code");
		expect(ids).toContain("my-budget-stack");
		expect(ids).toContain("local/manual-model");
		expect(ids).not.toContain("local/qwen3-coder");
		expect(ids).not.toContain("paused/claude-local");
	});

	it("resolves OpenRouter-backed combos into fallback models", () => {
		const target = resolveRouterModelTarget("premium-coding");

		expect(target?.provider).toBe("openrouter");
		expect(target?.source).toBe("combo");
		expect(target?.fallbackModels).toContain("z-ai/glm-5.2");
		expect(target?.fallbackModels).toContain("minimax/minimax-m3");
	});

	it("resolves aliases and custom combos into OpenRouter fallback models", () => {
		const options = {
			aliases: [{ alias: "fast-code", targetModel: "openrouter/z-ai/glm-5.2" }],
			customCombos: [
				{ name: "my-budget-stack", models: ["fast-code", "minimax"] },
			],
		};

		const aliasTarget = resolveRouterModelTarget("fast-code", options);
		const comboTarget = resolveRouterModelTarget("my-budget-stack", options);

		expect(aliasTarget?.source).toBe("alias");
		expect(aliasTarget?.model).toBe("z-ai/glm-5.2");
		expect(comboTarget?.source).toBe("custom-combo");
		expect(comboTarget?.fallbackModels).toEqual([
			"z-ai/glm-5.2",
			"minimax/minimax-m3",
		]);
	});
});
