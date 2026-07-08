import { describe, expect, it } from "bun:test";
import {
	buildRouterDashboardSnapshot,
	previewRouterTokenSaver,
	ROUTER_ENDPOINTS,
	ROUTER_TOKEN_SAVERS,
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
});
