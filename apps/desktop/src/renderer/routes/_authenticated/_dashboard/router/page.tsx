import {
	previewRouterTokenSaver,
	type RouterDashboardSnapshot,
	type RouterProviderKeyId,
	type RouterTokenSaverMode,
} from "@superset/shared/router-control-plane";
import { cn } from "@superset/ui/utils";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import {
	LuActivity,
	LuAudioLines,
	LuBadgeCheck,
	LuBrainCircuit,
	LuGauge,
	LuImage,
	LuKeyRound,
	LuNetwork,
	LuPlugZap,
	LuRoute,
	LuSearch,
	LuShieldAlert,
	LuSparkles,
	LuWorkflow,
} from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";

export const Route = createFileRoute("/_authenticated/_dashboard/router/")({
	component: RouterDashboardPage,
});

type TabId =
	| "overview"
	| "providers"
	| "combos"
	| "endpoints"
	| "token-savers"
	| "fallback"
	| "usage"
	| "aliases";

const TABS: { id: TabId; label: string }[] = [
	{ id: "overview", label: "Overview" },
	{ id: "providers", label: "Providers" },
	{ id: "combos", label: "Combos" },
	{ id: "endpoints", label: "Endpoints" },
	{ id: "token-savers", label: "Token Saver" },
	{ id: "fallback", label: "Fallback" },
	{ id: "usage", label: "Usage" },
	{ id: "aliases", label: "Aliases" },
];

const SAMPLE_TOKEN_INPUT = [
	"Sure, here is the build output:",
	"npm warn deprecated left-pad@1.3.0",
	"Compiling packages/shared/src/router-control-plane.ts",
	"Successfully built package @superset/shared",
	"ERROR: src/app/example.ts:42: missing provider mapping",
	"Here are the next steps I will take.",
	...Array.from(
		{ length: 90 },
		(_, index) => `packages/example/file-${index}.ts:12:sample match ${index}`,
	),
	"Finished with 1 warning and 1 actionable error.",
].join("\n");

function RouterDashboardPage() {
	const [activeTab, setActiveTab] = useState<TabId>("overview");
	const utils = electronTrpc.useUtils();
	const { data, isLoading, error } =
		electronTrpc.agentRouter.dashboard.useQuery(undefined, {
			refetchInterval: 15_000,
		});
	const invalidateDashboard = () => utils.agentRouter.dashboard.invalidate();
	const startGateway = electronTrpc.agentRouter.startGateway.useMutation({
		onSuccess: invalidateDashboard,
	});
	const stopGateway = electronTrpc.agentRouter.stopGateway.useMutation({
		onSuccess: invalidateDashboard,
	});
	const restartGateway = electronTrpc.agentRouter.restartGateway.useMutation({
		onSuccess: invalidateDashboard,
	});
	const setProviderKey = electronTrpc.settings.providerKeys.set.useMutation({
		onSuccess: invalidateDashboard,
	});
	const clearProviderKey = electronTrpc.settings.providerKeys.clear.useMutation(
		{
			onSuccess: invalidateDashboard,
		},
	);

	if (isLoading) {
		return (
			<main className="flex-1 overflow-hidden bg-background">
				<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
					Loading router control plane...
				</div>
			</main>
		);
	}

	if (error || !data) {
		return (
			<main className="flex-1 overflow-hidden bg-background">
				<div className="flex h-full items-center justify-center text-sm text-destructive">
					Could not load router dashboard.
				</div>
			</main>
		);
	}

	return (
		<main className="flex-1 overflow-y-auto bg-background">
			<div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-5">
				<header className="flex flex-wrap items-start justify-between gap-4">
					<div className="min-w-0">
						<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
							<LuRoute className="size-4" />
							9router native control plane
						</div>
						<h1 className="mt-2 text-2xl font-semibold tracking-tight">
							Orchestrator Router
						</h1>
						<p className="mt-1 max-w-3xl text-sm text-muted-foreground">
							Providers, combos, token savers, endpoints, and fallback policy
							now live inside ADE. No localhost dashboard needed.
						</p>
					</div>
					<div className="flex min-w-72 flex-col gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
						<div className="flex items-center justify-between gap-3">
							<span className="font-medium text-foreground">
								Gateway {data.gateway?.running ? "running" : "stopped"}
							</span>
							<span
								className={cn(
									"rounded px-1.5 py-0.5",
									data.gateway?.running
										? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
										: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
								)}
							>
								{data.gateway?.running ? "live" : "offline"}
							</span>
						</div>
						<div className="truncate font-mono text-muted-foreground">
							{data.gateway?.url ?? "http://127.0.0.1:20128"}
						</div>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={() => startGateway.mutate()}
								disabled={data.gateway?.running || startGateway.isPending}
								className="rounded border px-2 py-1 text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
							>
								Start
							</button>
							<button
								type="button"
								onClick={() => restartGateway.mutate()}
								disabled={restartGateway.isPending}
								className="rounded border px-2 py-1 text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
							>
								Restart
							</button>
							<button
								type="button"
								onClick={() => stopGateway.mutate()}
								disabled={!data.gateway?.running || stopGateway.isPending}
								className="rounded border px-2 py-1 text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
							>
								Stop
							</button>
						</div>
						<div className="text-muted-foreground">
							Updated {new Date(data.generatedAt).toLocaleTimeString()}
						</div>
					</div>
				</header>

				<nav className="flex flex-wrap gap-2 border-b pb-3">
					{TABS.map((tab) => (
						<button
							key={tab.id}
							type="button"
							onClick={() => setActiveTab(tab.id)}
							className={cn(
								"rounded-md px-3 py-1.5 text-sm transition-colors",
								activeTab === tab.id
									? "bg-foreground text-background"
									: "text-muted-foreground hover:bg-muted hover:text-foreground",
							)}
						>
							{tab.label}
						</button>
					))}
				</nav>

				{activeTab === "overview" && <OverviewTab data={data} />}
				{activeTab === "providers" && (
					<ProvidersTab
						data={data}
						clearProviderKey={(provider) =>
							clearProviderKey.mutateAsync({ provider })
						}
						isSavingKey={setProviderKey.isPending || clearProviderKey.isPending}
						setProviderKey={(provider, key) =>
							setProviderKey.mutateAsync({ provider, key })
						}
					/>
				)}
				{activeTab === "combos" && <CombosTab data={data} />}
				{activeTab === "endpoints" && <EndpointsTab data={data} />}
				{activeTab === "token-savers" && <TokenSaversTab data={data} />}
				{activeTab === "fallback" && <FallbackTab data={data} />}
				{activeTab === "usage" && <UsageTab />}
				{activeTab === "aliases" && <AliasesTab />}
			</div>
		</main>
	);
}

function OverviewTab({ data }: { data: RouterDashboardSnapshot }) {
	const activeProviders = data.providers.filter(
		(provider) => provider.status === "native" || provider.keyConfigured,
	);

	return (
		<div className="flex flex-col gap-6">
			<div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
				<StatCard
					icon={LuPlugZap}
					label="Providers"
					value={data.stats.providers}
				/>
				<StatCard
					icon={LuBrainCircuit}
					label="Native agents"
					value={data.stats.nativeAgents}
				/>
				<StatCard icon={LuWorkflow} label="Combos" value={data.stats.combos} />
				<StatCard
					icon={LuNetwork}
					label="Endpoints"
					value={data.stats.endpoints}
				/>
				<StatCard
					icon={LuSparkles}
					label="Token savers"
					value={data.stats.tokenSavers}
				/>
				<StatCard
					icon={LuShieldAlert}
					label="Fallback rules"
					value={data.stats.fallbackRules}
				/>
			</div>

			<section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
				<div className="rounded-lg border bg-card p-4">
					<h2 className="text-sm font-semibold">Live routing features</h2>
					<div className="mt-4 grid gap-3 md:grid-cols-2">
						{data.features.map((feature) => (
							<div
								key={feature.id}
								className="rounded-md border bg-background p-3"
							>
								<div className="flex items-center justify-between gap-2">
									<span className="text-sm font-medium">{feature.label}</span>
									<StatusBadge status={feature.status} />
								</div>
								<p className="mt-2 text-xs leading-relaxed text-muted-foreground">
									{feature.description}
								</p>
							</div>
						))}
					</div>
				</div>

				<div className="rounded-lg border bg-card p-4">
					<h2 className="text-sm font-semibold">Active provider surface</h2>
					<div className="mt-4 flex flex-col gap-3">
						{activeProviders.slice(0, 8).map((provider) => (
							<div
								key={provider.id}
								className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2"
							>
								<div className="min-w-0">
									<div className="truncate text-sm font-medium">
										{provider.label}
									</div>
									<div className="truncate text-xs text-muted-foreground">
										{provider.defaultModels.join(", ")}
									</div>
								</div>
								<TierBadge tier={provider.tier} />
							</div>
						))}
					</div>
				</div>
			</section>
		</div>
	);
}

function ProvidersTab({
	data,
	clearProviderKey,
	isSavingKey,
	setProviderKey,
}: {
	data: RouterDashboardSnapshot;
	clearProviderKey: (provider: RouterProviderKeyId) => Promise<unknown>;
	isSavingKey: boolean;
	setProviderKey: (
		provider: RouterProviderKeyId,
		key: string,
	) => Promise<unknown>;
}) {
	const [inputs, setInputs] = useState<Record<string, string>>({});
	const [pendingProvider, setPendingProvider] = useState<string | null>(null);

	const saveKey = async (provider: RouterProviderKeyId) => {
		const key = inputs[provider]?.trim();
		if (!key) return;
		setPendingProvider(provider);
		try {
			await setProviderKey(provider, key);
			setInputs((current) => ({ ...current, [provider]: "" }));
		} finally {
			setPendingProvider(null);
		}
	};

	const clearKey = async (provider: RouterProviderKeyId) => {
		setPendingProvider(provider);
		try {
			await clearProviderKey(provider);
		} finally {
			setPendingProvider(null);
		}
	};

	return (
		<section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
			{data.providers.map((provider) => (
				<div key={provider.id} className="rounded-lg border bg-card p-4">
					<div className="flex items-start justify-between gap-3">
						<div className="min-w-0">
							<h2 className="truncate text-sm font-semibold">
								{provider.label}
							</h2>
							<p className="mt-1 text-xs text-muted-foreground">
								{provider.connection} / {provider.auth}
							</p>
						</div>
						<TierBadge tier={provider.tier} />
					</div>

					<p className="mt-3 text-xs leading-relaxed text-muted-foreground">
						{provider.notes}
					</p>

					<div className="mt-4 flex flex-wrap gap-1.5">
						{provider.capabilities.map((capability) => (
							<Pill key={capability}>{capability}</Pill>
						))}
					</div>

					<div className="mt-4 flex items-center justify-between gap-3 border-t pt-3 text-xs">
						<span className="text-muted-foreground">Credential</span>
						{provider.keyConfigured === null ? (
							<span className="text-muted-foreground">managed by runtime</span>
						) : provider.keyConfigured ? (
							<span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
								<LuBadgeCheck className="size-3.5" />
								configured
							</span>
						) : (
							<span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
								<LuKeyRound className="size-3.5" />
								needs key
							</span>
						)}
					</div>

					{provider.keyProvider && (
						<div className="mt-3 grid grid-cols-[1fr_auto_auto] gap-2">
							<input
								type="password"
								value={inputs[provider.keyProvider] ?? ""}
								onChange={(event) =>
									setInputs((current) => ({
										...current,
										[provider.keyProvider as string]: event.target.value,
									}))
								}
								placeholder={`${provider.keyProvider} key`}
								className="min-w-0 rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
							/>
							<button
								type="button"
								onClick={() =>
									saveKey(provider.keyProvider as RouterProviderKeyId)
								}
								disabled={
									isSavingKey ||
									pendingProvider === provider.keyProvider ||
									!inputs[provider.keyProvider]?.trim()
								}
								className="rounded-md border px-2 py-1.5 text-xs text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
							>
								Save
							</button>
							<button
								type="button"
								onClick={() =>
									clearKey(provider.keyProvider as RouterProviderKeyId)
								}
								disabled={
									isSavingKey ||
									pendingProvider === provider.keyProvider ||
									!provider.keyConfigured
								}
								className="rounded-md border px-2 py-1.5 text-xs text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
							>
								Clear
							</button>
						</div>
					)}
				</div>
			))}
		</section>
	);
}

function CombosTab({ data }: { data: RouterDashboardSnapshot }) {
	return (
		<section className="grid gap-3 lg:grid-cols-2">
			{data.combos.map((combo) => (
				<div key={combo.name} className="rounded-lg border bg-card p-4">
					<div className="flex items-start justify-between gap-3">
						<div>
							<h2 className="text-sm font-semibold">{combo.name}</h2>
							<p className="mt-1 text-xs text-muted-foreground">
								{combo.description}
							</p>
						</div>
						<Pill>{combo.strategy}</Pill>
					</div>

					<div className="mt-4 flex flex-wrap items-center gap-2">
						{combo.agents.map((agent, index) => (
							<div
								key={`${combo.name}-${agent}`}
								className="flex items-center gap-2"
							>
								<span className="rounded-md border bg-background px-2 py-1 text-xs font-medium">
									{agent}
								</span>
								{index < combo.agents.length - 1 && (
									<span className="text-xs text-muted-foreground">then</span>
								)}
							</div>
						))}
					</div>

					{combo.judge && (
						<div className="mt-4 rounded-md bg-muted/40 px-3 py-2 text-xs">
							Judge: <span className="font-medium">{combo.judge}</span>
						</div>
					)}
				</div>
			))}
		</section>
	);
}

function EndpointsTab({ data }: { data: RouterDashboardSnapshot }) {
	return (
		<section className="rounded-lg border bg-card">
			<div className="grid grid-cols-[120px_1fr_120px_1fr_140px] gap-3 border-b px-4 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<span>Method</span>
				<span>Path</span>
				<span>API</span>
				<span>Capability</span>
				<span>Status</span>
			</div>
			<div className="divide-y">
				{data.endpoints.map((endpoint) => (
					<div
						key={`${endpoint.method}-${endpoint.path}`}
						className="grid grid-cols-[120px_1fr_120px_1fr_140px] gap-3 px-4 py-3 text-sm"
					>
						<span className="font-mono text-xs">{endpoint.method}</span>
						<span className="min-w-0 truncate font-mono text-xs">
							{endpoint.path}
						</span>
						<span className="text-xs">{endpoint.compatibility}</span>
						<span className="min-w-0 truncate text-xs text-muted-foreground">
							{endpoint.capability}
						</span>
						<EndpointBadge status={endpoint.status} />
					</div>
				))}
			</div>
		</section>
	);
}

function TokenSaversTab({ data }: { data: RouterDashboardSnapshot }) {
	const [mode, setMode] = useState<RouterTokenSaverMode>("rtk");
	const [input, setInput] = useState(SAMPLE_TOKEN_INPUT);
	const preview = useMemo(
		() => previewRouterTokenSaver({ text: input, mode }),
		[input, mode],
	);
	const savedPct =
		preview.result.bytesBefore > 0
			? Math.round(
					(preview.result.savedBytes / preview.result.bytesBefore) * 100,
				)
			: 0;

	return (
		<section className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
			<div className="rounded-lg border bg-card p-4">
				<h2 className="text-sm font-semibold">Token saver modes</h2>
				<div className="mt-4 flex flex-col gap-2">
					{data.tokenSavers.map((tokenSaver) => (
						<button
							key={tokenSaver.mode}
							type="button"
							onClick={() => setMode(tokenSaver.mode)}
							className={cn(
								"rounded-md border px-3 py-3 text-left transition-colors",
								mode === tokenSaver.mode
									? "border-foreground bg-foreground text-background"
									: "bg-background hover:bg-muted/60",
							)}
						>
							<div className="text-sm font-medium">{tokenSaver.label}</div>
							<div
								className={cn(
									"mt-1 text-xs",
									mode === tokenSaver.mode
										? "text-background/75"
										: "text-muted-foreground",
								)}
							>
								{tokenSaver.description}
							</div>
						</button>
					))}
				</div>
			</div>

			<div className="rounded-lg border bg-card p-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h2 className="text-sm font-semibold">Compression preview</h2>
					<div className="flex gap-2 text-xs">
						<Pill>{preview.result.filter ?? "unchanged"}</Pill>
						<Pill>{savedPct}% saved</Pill>
					</div>
				</div>

				<div className="mt-4 grid gap-3 lg:grid-cols-2">
					<label className="flex flex-col gap-2 text-xs font-medium">
						Input
						<textarea
							value={input}
							onChange={(event) => setInput(event.target.value)}
							className="min-h-72 resize-y rounded-md border bg-background p-3 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
						/>
					</label>
					<label className="flex flex-col gap-2 text-xs font-medium">
						Output
						<textarea
							value={preview.result.text}
							readOnly
							className="min-h-72 resize-y rounded-md border bg-muted/30 p-3 font-mono text-xs outline-none"
						/>
					</label>
				</div>

				<div className="mt-3 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
					{preview.notice ??
						"No compression was needed for this payload and mode."}
				</div>
			</div>
		</section>
	);
}

function UsageTab() {
	const utils = electronTrpc.useUtils();
	const { data, isLoading } = electronTrpc.agentRouter.usageStats.useQuery(
		undefined,
		{ refetchInterval: 15_000 },
	);
	const clearUsage = electronTrpc.agentRouter.clearUsage.useMutation({
		onSuccess: () => utils.agentRouter.usageStats.invalidate(),
	});

	if (isLoading || !data) {
		return (
			<div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
				Loading usage...
			</div>
		);
	}

	return (
		<section className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="grid flex-1 gap-3 md:grid-cols-4">
					<StatCard
						icon={LuActivity}
						label="Requests"
						value={data.totalRequests}
					/>
					<StatCard
						icon={LuBadgeCheck}
						label="Succeeded"
						value={data.successfulRequests}
					/>
					<StatCard
						icon={LuShieldAlert}
						label="Failed"
						value={data.failedRequests}
					/>
					<StatCard icon={LuGauge} label="Tokens" value={data.totalTokens} />
				</div>
				<button
					type="button"
					onClick={() => clearUsage.mutate()}
					disabled={clearUsage.isPending || data.totalRequests === 0}
					className="rounded-md border px-3 py-2 text-sm text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
				>
					Clear usage
				</button>
			</div>

			<div className="rounded-lg border bg-card p-4">
				<div className="flex items-center justify-between gap-3">
					<h2 className="text-sm font-semibold">Provider totals</h2>
					<Pill>${data.estimatedCostUsd.toFixed(4)} estimated</Pill>
				</div>
				<div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
					{data.byProvider.length === 0 ? (
						<p className="text-sm text-muted-foreground">No usage yet.</p>
					) : (
						data.byProvider.map((provider) => (
							<div
								key={provider.provider}
								className="rounded-md border bg-background px-3 py-2"
							>
								<div className="flex items-center justify-between gap-3">
									<span className="text-sm font-medium">
										{provider.provider}
									</span>
									<Pill>{provider.requests} req</Pill>
								</div>
								<div className="mt-2 flex justify-between text-xs text-muted-foreground">
									<span>{provider.totalTokens.toLocaleString()} tokens</span>
									<span>${provider.estimatedCostUsd.toFixed(4)}</span>
								</div>
							</div>
						))
					)}
				</div>
			</div>

			<div className="rounded-lg border bg-card">
				<div className="grid grid-cols-[150px_90px_1fr_90px_90px] gap-3 border-b px-4 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					<span>Time</span>
					<span>Status</span>
					<span>Endpoint</span>
					<span>Model</span>
					<span>Tokens</span>
				</div>
				<div className="divide-y">
					{data.recentRequests.map((request) => (
						<div
							key={request.id}
							className="grid grid-cols-[150px_90px_1fr_90px_90px] gap-3 px-4 py-3 text-xs"
						>
							<span className="text-muted-foreground">
								{new Date(request.timestamp).toLocaleTimeString()}
							</span>
							<span
								className={cn(
									request.success
										? "text-emerald-600 dark:text-emerald-400"
										: "text-amber-600 dark:text-amber-400",
								)}
							>
								{request.status}
							</span>
							<span className="truncate font-mono">{request.endpoint}</span>
							<span className="truncate">{request.model}</span>
							<span>{request.totalTokens.toLocaleString()}</span>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}

function AliasesTab() {
	const utils = electronTrpc.useUtils();
	const aliases = electronTrpc.agentRouter.aliases.useQuery();
	const customCombos = electronTrpc.agentRouter.customCombos.useQuery();
	const [alias, setAlias] = useState("");
	const [targetModel, setTargetModel] = useState("");
	const [comboName, setComboName] = useState("");
	const [comboModels, setComboModels] = useState("");
	const invalidate = () => {
		utils.agentRouter.aliases.invalidate();
		utils.agentRouter.customCombos.invalidate();
		utils.agentRouter.dashboard.invalidate();
	};
	const upsertAlias = electronTrpc.agentRouter.upsertAlias.useMutation({
		onSuccess: invalidate,
	});
	const deleteAlias = electronTrpc.agentRouter.deleteAlias.useMutation({
		onSuccess: invalidate,
	});
	const upsertCustomCombo =
		electronTrpc.agentRouter.upsertCustomCombo.useMutation({
			onSuccess: invalidate,
		});
	const deleteCustomCombo =
		electronTrpc.agentRouter.deleteCustomCombo.useMutation({
			onSuccess: invalidate,
		});

	const saveAlias = async () => {
		if (!alias.trim() || !targetModel.trim()) return;
		await upsertAlias.mutateAsync({
			alias: alias.trim(),
			targetModel: targetModel.trim(),
		});
		setAlias("");
		setTargetModel("");
	};

	const saveCombo = async () => {
		const models = comboModels
			.split(/[\n,]+/)
			.map((model) => model.trim())
			.filter(Boolean);
		if (!comboName.trim() || models.length === 0) return;
		await upsertCustomCombo.mutateAsync({
			name: comboName.trim(),
			models,
		});
		setComboName("");
		setComboModels("");
	};

	return (
		<section className="grid gap-4 lg:grid-cols-2">
			<div className="rounded-lg border bg-card p-4">
				<h2 className="text-sm font-semibold">Model aliases</h2>
				<div className="mt-4 grid gap-2 md:grid-cols-[1fr_1fr_auto]">
					<input
						value={alias}
						onChange={(event) => setAlias(event.target.value)}
						placeholder="alias, e.g. fast-code"
						className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
					/>
					<input
						value={targetModel}
						onChange={(event) => setTargetModel(event.target.value)}
						placeholder="target, e.g. openrouter/z-ai/glm-5.2"
						className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
					/>
					<button
						type="button"
						onClick={saveAlias}
						disabled={
							upsertAlias.isPending || !alias.trim() || !targetModel.trim()
						}
						className="rounded-md border px-3 py-2 text-sm text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
					>
						Save
					</button>
				</div>

				<div className="mt-4 flex flex-col gap-2">
					{(aliases.data ?? []).length === 0 ? (
						<p className="text-sm text-muted-foreground">No aliases yet.</p>
					) : (
						(aliases.data ?? []).map((entry) => (
							<div
								key={entry.alias}
								className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm"
							>
								<span className="min-w-0 truncate">
									<span className="font-mono">{entry.alias}</span>
									<span className="text-muted-foreground"> {"->"} </span>
									<span className="font-mono text-muted-foreground">
										{entry.targetModel}
									</span>
								</span>
								<button
									type="button"
									onClick={() => deleteAlias.mutate({ alias: entry.alias })}
									className="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
								>
									Delete
								</button>
							</div>
						))
					)}
				</div>
			</div>

			<div className="rounded-lg border bg-card p-4">
				<h2 className="text-sm font-semibold">Custom combos</h2>
				<div className="mt-4 grid gap-2">
					<input
						value={comboName}
						onChange={(event) => setComboName(event.target.value)}
						placeholder="combo name, e.g. my-budget-stack"
						className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
					/>
					<textarea
						value={comboModels}
						onChange={(event) => setComboModels(event.target.value)}
						placeholder="models, comma or newline separated"
						className="min-h-24 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
					/>
					<button
						type="button"
						onClick={saveCombo}
						disabled={
							upsertCustomCombo.isPending ||
							!comboName.trim() ||
							!comboModels.trim()
						}
						className="w-fit rounded-md border px-3 py-2 text-sm text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"
					>
						Save combo
					</button>
				</div>

				<div className="mt-4 flex flex-col gap-2">
					{(customCombos.data ?? []).length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No custom combos yet.
						</p>
					) : (
						(customCombos.data ?? []).map((combo) => (
							<div
								key={combo.name}
								className="rounded-md border bg-background px-3 py-2"
							>
								<div className="flex items-center justify-between gap-3">
									<span className="font-mono text-sm">{combo.name}</span>
									<button
										type="button"
										onClick={() =>
											deleteCustomCombo.mutate({ name: combo.name })
										}
										className="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
									>
										Delete
									</button>
								</div>
								<div className="mt-2 flex flex-wrap gap-1.5">
									{combo.models.map((model) => (
										<Pill key={`${combo.name}-${model}`}>{model}</Pill>
									))}
								</div>
							</div>
						))
					)}
				</div>
			</div>
		</section>
	);
}

function FallbackTab({ data }: { data: RouterDashboardSnapshot }) {
	return (
		<section className="grid gap-4 lg:grid-cols-[0.7fr_1.3fr]">
			<div className="rounded-lg border bg-card p-4">
				<h2 className="text-sm font-semibold">Tier order</h2>
				<div className="mt-4 flex flex-col gap-2">
					{data.tierOrder.map((tier, index) => (
						<div
							key={tier}
							className="flex items-center justify-between rounded-md border bg-background px-3 py-2 text-sm"
						>
							<span className="font-medium">{tier}</span>
							<span className="text-xs text-muted-foreground">
								priority {index + 1}
							</span>
						</div>
					))}
				</div>
			</div>

			<div className="rounded-lg border bg-card p-4">
				<h2 className="text-sm font-semibold">Fallback triggers</h2>
				<div className="mt-4 grid gap-2 md:grid-cols-2">
					{data.fallbackRules.map((rule, index) => (
						<div
							key={`${rule.status ?? rule.text}-${index}`}
							className="rounded-md border bg-background px-3 py-2"
						>
							<div className="flex items-center justify-between gap-2">
								<span className="font-mono text-xs">
									{rule.text ?? `HTTP ${rule.status}`}
								</span>
								{rule.backoff && <Pill>backoff</Pill>}
							</div>
							<div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
								<span>{rule.reason}</span>
								<span>{Math.round(rule.cooldownMs / 1000)}s</span>
							</div>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}

function StatCard({
	icon: Icon,
	label,
	value,
}: {
	icon: typeof LuActivity;
	label: string;
	value: number;
}) {
	return (
		<div className="rounded-lg border bg-card p-4">
			<div className="flex items-center justify-between gap-3">
				<span className="text-xs font-medium text-muted-foreground">
					{label}
				</span>
				<Icon className="size-4 text-muted-foreground" />
			</div>
			<div className="mt-3 text-2xl font-semibold tabular-nums">
				{value.toLocaleString()}
			</div>
		</div>
	);
}

function Pill({ children }: { children: ReactNode }) {
	return (
		<span className="inline-flex items-center rounded-md border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
			{children}
		</span>
	);
}

function TierBadge({ tier }: { tier: string }) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center rounded-md px-2 py-1 text-[11px] font-medium",
				tier === "subscription" &&
					"bg-sky-500/10 text-sky-700 dark:text-sky-300",
				tier === "cheap" &&
					"bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
				tier === "free" && "bg-stone-500/10 text-stone-700 dark:text-stone-300",
				tier === "local" && "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
				tier === "search" &&
					"bg-amber-500/10 text-amber-700 dark:text-amber-300",
				tier === "media" && "bg-rose-500/10 text-rose-700 dark:text-rose-300",
			)}
		>
			{tier}
		</span>
	);
}

function StatusBadge({ status }: { status: string }) {
	return (
		<span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
			<LuBadgeCheck className="size-3" />
			{status}
		</span>
	);
}

function EndpointBadge({
	status,
}: {
	status: "native-dashboard" | "gateway-live" | "gateway-catalogued";
}) {
	const Icon =
		status === "native-dashboard" || status === "gateway-live"
			? LuGauge
			: status.includes("image")
				? LuImage
				: status.includes("audio")
					? LuAudioLines
					: status.includes("search")
						? LuSearch
						: LuNetwork;

	return (
		<span
			className={cn(
				"inline-flex w-fit items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium",
				status === "native-dashboard" || status === "gateway-live"
					? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
					: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
			)}
		>
			<Icon className="size-3" />
			{status}
		</span>
	);
}
