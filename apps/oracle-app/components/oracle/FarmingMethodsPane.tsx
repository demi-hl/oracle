"use client";

import { useEffect, useMemo, useState } from "react";

const ORACLE_BLUE = "#7CC4FF";
const HAIRLINE = "rgba(124,196,255,.14)";

type RiskLevel = "Conservative" | "Balanced" | "Aggressive";
type FarmType = "stable-loop" | "collateral-hedge" | "lp-hedge";
type SurfaceMode = "delta-neutral" | "airdrop";
type AirdropStrategyId = "testnet-quests" | "liquidity-route" | "governance-usage";

interface MethodPreset {
  id: FarmType;
  label: string;
  risk: RiskLevel;
  targetDelta: string;
  setup: string;
  exposure: string;
  hedge: string;
  monitor: string;
  exit: string;
}

interface AirdropStrategy {
  id: AirdropStrategyId;
  label: string;
  risk: RiskLevel;
  setup: string;
  signal: string;
  costControl: string;
  antiSybil: string;
  exit: string;
}

interface FarmCandidate {
  id: string;
  recipe: FarmType;
  label: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  rewardApr: number;
  nativeApr: number;
  estimatedBorrowApr: number;
  estimatedFundingApr: number;
  riskHaircut: number;
  netApr: number;
  verdict: "Farmable" | "Watchlist" | "Avoid";
  exposure: string;
  hedge: string;
  monitor: string;
  prepareSteps: string[];
  source: string;
}

interface FarmingDiscovery {
  live: boolean;
  source: string;
  generatedAt: string;
  candidates: FarmCandidate[];
  error?: string;
  posture: string;
}

const PRESETS: MethodPreset[] = [
  {
    id: "stable-loop",
    label: "Stablecoin loop",
    risk: "Conservative",
    targetDelta: "0.00",
    setup: "Supply USDC, borrow a second major stable, redeposit inside the same protocol or campaign.",
    exposure: "Borrow APR spike, depeg, collateral-factor change, protocol cap change.",
    hedge: "No perp hedge by default. Cap leverage, diversify stables, and keep unwind triggers explicit.",
    monitor: "Borrow APR, utilization, oracle health, depeg distance, reward dilution.",
    exit: "Unwind if borrow APR exceeds reward-adjusted APR or any stable trades outside the defined band.",
  },
  {
    id: "collateral-hedge",
    label: "Collateral plus perp hedge",
    risk: "Balanced",
    targetDelta: "-0.05 to +0.05",
    setup: "Deposit ETH or BTC collateral into the target protocol, borrow stables, and farm points or incentives.",
    exposure: "Long collateral beta plus liquidation risk if the collateral falls faster than the hedge is maintained.",
    hedge: "Short the same notional on a liquid perp venue. Rebalance when collateral delta drifts past threshold.",
    monitor: "Health factor, perp funding, mark price, borrow APR, hedge venue margin.",
    exit: "Close if health factor is near the safety floor, funding turns punitive, or points value no longer covers cost.",
  },
  {
    id: "lp-hedge",
    label: "LP incentive hedge",
    risk: "Aggressive",
    targetDelta: "0.00 to +0.10",
    setup: "Provide liquidity to an incentivized pool or range while tracking the position's live token delta.",
    exposure: "Pool inventory drift, impermanent loss, range exits, reward volatility, and hedge mismatch.",
    hedge: "Short the estimated volatile-token delta. Recompute after material price moves or range changes.",
    monitor: "Position delta, range utilization, fee APR, reward APR, funding, slippage to exit.",
    exit: "Remove liquidity if the range breaks, net APR turns negative, or hedge size exceeds the risk budget.",
  },
];

const AIRDROP_STRATEGIES: AirdropStrategy[] = [
  {
    id: "testnet-quests",
    label: "Testnet and quest farming",
    risk: "Conservative",
    setup: "Run bounded weekly actions across official quests, testnet faucets, app check-ins, and proof-of-use tasks.",
    signal: "Strong when the protocol has confirmed points, visible funding, repeated campaign updates, or a public eligibility trail.",
    costControl: "Cap gas and bridge spend per wallet; stop when expected value no longer clears the monthly cost envelope.",
    antiSybil: "Use real wallets, real activity, no wash spam, no farm clusters, no fake volume, and no terms-bypassing automation.",
    exit: "Stop once snapshot risk rises, campaign rules change, or the probability-adjusted expected value turns negative.",
  },
  {
    id: "liquidity-route",
    label: "Liquidity and route usage",
    risk: "Balanced",
    setup: "Provide small bounded liquidity or route volume through official app paths where campaign rules reward real economic use.",
    signal: "Strong when rewards favor TVL, volume, route diversity, and long-lived non-dust balances rather than raw transaction count.",
    costControl: "Model IL, slippage, gas, bridge fees, and lockup discount before sizing. Never farm volume at a loss without a hard EV reason.",
    antiSybil: "Prefer fewer high-quality wallets with consistent history; avoid circular routes, self-trades, and obvious farm signatures.",
    exit: "Withdraw when incentives dilute, liquidity caps fill, or expected reward no longer beats IL plus opportunity cost.",
  },
  {
    id: "governance-usage",
    label: "Governance and ecosystem usage",
    risk: "Aggressive",
    setup: "Combine governance, NFT badges, integrations, referrals, bridges, and app-specific actions into one campaign map.",
    signal: "Strong when points are hidden but ecosystem teams repeatedly reward early real users across multiple product surfaces.",
    costControl: "Assign a probability haircut to every task class and cut actions that only add vanity count with no eligibility evidence.",
    antiSybil: "Keep identity and wallet behavior coherent. Do not simulate fake users, bot social tasks, or bypass invite/eligibility rules.",
    exit: "Freeze new spend after likely snapshot windows and keep only cheap maintenance until claim terms are published.",
  },
];

const RISK_COPY: Record<RiskLevel, string> = {
  Conservative: "stable-heavy, low leverage, fewer rebalance events",
  Balanced: "hedged majors, moderate ops load, strict liquidation buffer",
  Aggressive: "active LP/perp management, higher reward target, tighter controls",
};

function clampNumber(value: string, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function fmtUsd(value: number) {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function fmtCompactUsd(value: number) {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
}

function pct(value: number) {
  return `${value.toFixed(2)}%`;
}

function ModePill({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border px-3 py-2 text-left transition-colors"
      style={{ borderColor: active ? ORACLE_BLUE : HAIRLINE, background: active ? "rgba(124,196,255,.08)" : "transparent" }}
    >
      <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.14em]" style={{ color: active ? ORACLE_BLUE : "#9FB8D2" }}>
        {children}
      </span>
    </button>
  );
}

export function FarmingMethodsPane() {
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>("delta-neutral");
  const [presetId, setPresetId] = useState<FarmType>("stable-loop");
  const [capital, setCapital] = useState("10000");
  const [rewardApr, setRewardApr] = useState("18");
  const [nativeApr, setNativeApr] = useState("3");
  const [borrowApr, setBorrowApr] = useState("7");
  const [fundingApr, setFundingApr] = useState("4");
  const [gasMonthly, setGasMonthly] = useState("35");
  const [riskHaircut, setRiskHaircut] = useState("6");
  const [rebalanceBand, setRebalanceBand] = useState("15");
  const [airdropStrategyId, setAirdropStrategyId] = useState<AirdropStrategyId>("testnet-quests");
  const [airdropWallets, setAirdropWallets] = useState("3");
  const [airdropTasksWeekly, setAirdropTasksWeekly] = useState("12");
  const [airdropHoursWeekly, setAirdropHoursWeekly] = useState("4");
  const [airdropHourlyCost, setAirdropHourlyCost] = useState("75");
  const [airdropGasPerTask, setAirdropGasPerTask] = useState("1.25");
  const [airdropBridgeMonthly, setAirdropBridgeMonthly] = useState("80");
  const [airdropExpectedReward, setAirdropExpectedReward] = useState("2500");
  const [airdropProbability, setAirdropProbability] = useState("22");
  const [airdropSybilHaircut, setAirdropSybilHaircut] = useState("18");
  const [airdropLockupMonths, setAirdropLockupMonths] = useState("6");
  const [chainFilter, setChainFilter] = useState("all");
  const [discovery, setDiscovery] = useState<FarmingDiscovery | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(true);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setDiscoveryLoading(true);
      try {
        const res = await fetch(`/api/oracle/farming?chain=${encodeURIComponent(chainFilter)}&limit=12`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await res.json()) as FarmingDiscovery;
        setDiscovery(payload);
        setSelectedCandidateId((current) => current ?? payload.candidates?.[0]?.id ?? null);
      } catch (error) {
        if (controller.signal.aborted) return;
        setDiscovery({
          live: false,
          source: "DeFiLlama yields",
          generatedAt: new Date().toISOString(),
          candidates: [],
          error: error instanceof Error ? error.message : "farming discovery unavailable",
          posture: "read-only discovery and prepare-plan design; no signing or broadcast",
        });
      } finally {
        if (!controller.signal.aborted) setDiscoveryLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [chainFilter]);

  const candidates = discovery?.candidates ?? [];
  const selectedCandidate = candidates.find((item) => item.id === selectedCandidateId) ?? candidates[0] ?? null;

  const applyCandidate = (candidate: FarmCandidate) => {
    setSelectedCandidateId(candidate.id);
    setSurfaceMode("delta-neutral");
    setPresetId(candidate.recipe);
    setRewardApr(candidate.rewardApr.toFixed(2));
    setNativeApr(candidate.nativeApr.toFixed(2));
    setBorrowApr(candidate.estimatedBorrowApr.toFixed(2));
    setFundingApr(candidate.estimatedFundingApr.toFixed(2));
    setRiskHaircut(candidate.riskHaircut.toFixed(2));
  };

  const preset = PRESETS.find((item) => item.id === presetId) ?? PRESETS[0];
  const airdropStrategy = AIRDROP_STRATEGIES.find((item) => item.id === airdropStrategyId) ?? AIRDROP_STRATEGIES[0];
  const calc = useMemo(() => {
    const cap = clampNumber(capital, 10_000, 100, 100_000_000);
    const rewards = clampNumber(rewardApr, 0, 0, 500);
    const nativeYield = clampNumber(nativeApr, 0, -100, 500);
    const borrow = clampNumber(borrowApr, 0, 0, 500);
    const funding = clampNumber(fundingApr, 0, -200, 500);
    const gas = clampNumber(gasMonthly, 0, 0, 1_000_000);
    const haircut = clampNumber(riskHaircut, 0, 0, 100);
    const band = clampNumber(rebalanceBand, 15, 1, 100);
    const grossApr = rewards + nativeYield;
    const costApr = borrow + funding + (gas * 12 / cap * 100);
    const netBeforeRisk = grossApr - costApr;
    const netAfterRisk = netBeforeRisk - haircut;
    const monthlyNet = cap * netAfterRisk / 100 / 12;
    return { cap, rewards, nativeYield, borrow, funding, gas, haircut, band, grossApr, costApr, netBeforeRisk, netAfterRisk, monthlyNet };
  }, [borrowApr, capital, fundingApr, gasMonthly, nativeApr, rebalanceBand, rewardApr, riskHaircut]);

  const airdropCalc = useMemo(() => {
    const wallets = Math.floor(clampNumber(airdropWallets, 3, 1, 250));
    const tasksWeekly = clampNumber(airdropTasksWeekly, 12, 0, 10_000);
    const hoursWeekly = clampNumber(airdropHoursWeekly, 4, 0, 1_000);
    const hourlyCost = clampNumber(airdropHourlyCost, 75, 0, 10_000);
    const gasPerTask = clampNumber(airdropGasPerTask, 1.25, 0, 10_000);
    const bridgeMonthly = clampNumber(airdropBridgeMonthly, 80, 0, 1_000_000);
    const expectedReward = clampNumber(airdropExpectedReward, 2_500, 0, 100_000_000);
    const probability = clampNumber(airdropProbability, 22, 0, 100) / 100;
    const sybilHaircut = clampNumber(airdropSybilHaircut, 18, 0, 95) / 100;
    const lockupMonths = clampNumber(airdropLockupMonths, 6, 0, 60);
    const monthlyTasks = wallets * tasksWeekly * 4.345;
    const monthlyGas = monthlyTasks * gasPerTask;
    const laborMonthly = hoursWeekly * 4.345 * hourlyCost;
    const monthlyCost = monthlyGas + bridgeMonthly + laborMonthly;
    const lockupDiscount = Math.min(0.6, lockupMonths * 0.015);
    const grossExpectedValue = wallets * expectedReward * probability;
    const adjustedExpectedValue = grossExpectedValue * (1 - sybilHaircut) * (1 - lockupDiscount);
    const netExpectedValue = adjustedExpectedValue - monthlyCost;
    const roi = monthlyCost > 0 ? netExpectedValue / monthlyCost * 100 : 0;
    const breakevenProbability = wallets * expectedReward > 0
      ? Math.min(100, monthlyCost / (wallets * expectedReward * (1 - sybilHaircut) * (1 - lockupDiscount)) * 100)
      : 100;
    return { wallets, tasksWeekly, hoursWeekly, hourlyCost, gasPerTask, bridgeMonthly, expectedReward, probability, sybilHaircut, lockupMonths, monthlyTasks, monthlyGas, laborMonthly, monthlyCost, lockupDiscount, adjustedExpectedValue, netExpectedValue, roi, breakevenProbability };
  }, [airdropBridgeMonthly, airdropExpectedReward, airdropGasPerTask, airdropHourlyCost, airdropHoursWeekly, airdropLockupMonths, airdropProbability, airdropSybilHaircut, airdropTasksWeekly, airdropWallets]);

  const verdict = calc.netAfterRisk >= 8 ? "Farmable" : calc.netAfterRisk >= 1 ? "Watchlist" : "Avoid";
  const airdropVerdict = airdropCalc.netExpectedValue >= airdropCalc.monthlyCost ? "Farmable" : airdropCalc.netExpectedValue > 0 ? "Watchlist" : "Avoid";
  const activeVerdict = surfaceMode === "airdrop" ? airdropVerdict : verdict;
  const activeMetric = surfaceMode === "airdrop" ? fmtUsd(airdropCalc.netExpectedValue) : pct(calc.netAfterRisk);
  const activeMonthly = surfaceMode === "airdrop" ? fmtUsd(airdropCalc.monthlyCost) : fmtUsd(calc.monthlyNet);
  const verdictColor = activeVerdict === "Farmable" ? ORACLE_BLUE : activeVerdict === "Watchlist" ? "#F3C879" : "#E98791";

  return (
    <section className="mx-auto flex h-full w-full max-w-6xl flex-col gap-5 overflow-y-auto p-4 text-[#DDF1FF] sm:p-6">
      <header className="grid gap-4 border-b border-[#7CC4FF]/10 pb-5 lg:grid-cols-[1fr_auto]">
        <div>
          <p className="font-mono-ui text-[0.56rem] uppercase tracking-[0.2em] text-[#7CC4FF]/58">Farming Methods</p>
          <h1 className="mt-2 font-display-ui text-[2.15rem] leading-none tracking-[-0.05em] text-[#EEF8FF] sm:text-[3rem]">
            {surfaceMode === "airdrop" ? "airdrop farming calculator" : "delta-neutral farming recipes"}
          </h1>
          <p className="mt-3 max-w-2xl text-[0.78rem] leading-relaxed text-[#DDF1FF]/56">
            {surfaceMode === "airdrop"
              ? "Estimate campaign expected value after gas, bridge cost, labor, probability, lockup, and sybil haircuts. This designs compliant real-user farming plans only."
              : "Build a protocol farming method around incentives, hidden exposure, hedge cost, monitoring, and exit rules. This is method design only. It does not sign, broadcast, or promise yield."}
          </p>
        </div>
        <section className="grid min-w-[280px] grid-cols-3 gap-px overflow-hidden border border-[#7CC4FF]/12 bg-[#7CC4FF]/10" aria-label="Method verdict">
          {[
            ["verdict", activeVerdict],
            [surfaceMode === "airdrop" ? "net EV" : "net APR", activeMetric],
            [surfaceMode === "airdrop" ? "monthly cost" : "monthly", activeMonthly],
          ].map(([name, value]) => (
            <div key={name} className="bg-[#0B1018] p-3 text-center">
              <div className="font-mono-ui text-[0.86rem] text-[#EEF8FF]" style={name === "verdict" ? { color: verdictColor } : undefined}>{value}</div>
              <div className="mt-1 font-mono-ui text-[0.48rem] uppercase tracking-[0.13em] text-[#7CC4FF]/42">{name}</div>
            </div>
          ))}
        </section>
      </header>

      <div className="grid gap-2 sm:grid-cols-2">
        <button type="button" onClick={() => setSurfaceMode("delta-neutral")} className="border p-4 text-left" style={{ borderColor: surfaceMode === "delta-neutral" ? ORACLE_BLUE : HAIRLINE, background: surfaceMode === "delta-neutral" ? "rgba(124,196,255,.08)" : "rgba(11,16,24,.72)" }}>
          <p className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em] text-[#7CC4FF]/55">Delta-neutral</p>
          <p className="mt-2 text-[0.76rem] text-[#DDF1FF]/58">Protocol yield, hedge cost, borrow cost, risk haircut, and prepare-plan design.</p>
        </button>
        <button type="button" onClick={() => setSurfaceMode("airdrop")} className="border p-4 text-left" style={{ borderColor: surfaceMode === "airdrop" ? ORACLE_BLUE : HAIRLINE, background: surfaceMode === "airdrop" ? "rgba(124,196,255,.08)" : "rgba(11,16,24,.72)" }}>
          <p className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em] text-[#7CC4FF]/55">Airdrop farming</p>
          <p className="mt-2 text-[0.76rem] text-[#DDF1FF]/58">Wallet count, task cadence, gas, bridges, labor, eligibility odds, sybil haircut, and claim lockup.</p>
        </button>
      </div>

      {surfaceMode === "delta-neutral" ? (
        <>
          <section className="grid gap-4 border border-[#7CC4FF]/12 bg-[#0B1018]/72 p-4" aria-labelledby="live-farm-heading">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p id="live-farm-heading" className="font-mono-ui text-[0.56rem] uppercase tracking-[0.18em] text-[#7CC4FF]/50">Live farm discovery</p>
                <p className="mt-2 max-w-2xl text-[0.72rem] leading-relaxed text-[#DDF1FF]/50">
                  Pulls public yield pools, classifies them into farming methods, estimates hedge and borrow cost, then loads the calculator from the selected candidate.
                </p>
              </div>
              <label className="grid min-w-[180px] gap-1.5">
                <span className="font-mono-ui text-[0.52rem] uppercase tracking-[0.14em] text-[#9FB8D2]">Chain</span>
                <select value={chainFilter} onChange={(event) => { setChainFilter(event.target.value); setSelectedCandidateId(null); }} className="h-10 border border-[#7CC4FF]/16 bg-[#080D13] px-3 font-mono-ui text-[0.66rem] text-[#DDF1FF] outline-none focus:border-[#7CC4FF]/50">
                  {["all", "Ethereum", "Arbitrum", "Base", "Optimism", "Solana", "Avalanche", "Polygon"].map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
            </div>

            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {discoveryLoading ? (
                  [0, 1, 2].map((item) => <div key={item} className="h-[138px] animate-pulse border border-[#7CC4FF]/10 bg-[#7CC4FF]/[0.035]" />)
                ) : candidates.length === 0 ? (
                  <div className="border border-[#7CC4FF]/10 p-4 text-[0.76rem] text-[#DDF1FF]/54 sm:col-span-2 xl:col-span-3">
                    {discovery?.error ? `Discovery unavailable: ${discovery.error}` : "No public farm candidates matched this chain."}
                  </div>
                ) : candidates.slice(0, 6).map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => applyCandidate(candidate)}
                    className="border p-3 text-left transition-colors"
                    style={{
                      borderColor: candidate.id === selectedCandidate?.id ? ORACLE_BLUE : HAIRLINE,
                      background: candidate.id === selectedCandidate?.id ? "rgba(124,196,255,.08)" : "rgba(11,16,24,.72)",
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[0.82rem] text-[#EEF8FF]">{candidate.label}</p>
                        <p className="mt-1 font-mono-ui text-[0.5rem] uppercase tracking-[0.13em] text-[#7CC4FF]/48">{candidate.chain} / {candidate.recipe}</p>
                      </div>
                      <span className="font-mono-ui text-[0.58rem]" style={{ color: candidate.verdict === "Farmable" ? ORACLE_BLUE : candidate.verdict === "Watchlist" ? "#F3C879" : "#E98791" }}>
                        {pct(candidate.netApr)}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-px overflow-hidden border border-[#7CC4FF]/10 bg-[#7CC4FF]/10">
                      <div className="bg-[#080D13] p-2"><div className="font-mono-ui text-[0.46rem] uppercase tracking-[0.12em] text-[#7CC4FF]/36">TVL</div><div className="mt-1 text-[0.66rem] text-[#DDF1FF]/72">{fmtCompactUsd(candidate.tvlUsd)}</div></div>
                      <div className="bg-[#080D13] p-2"><div className="font-mono-ui text-[0.46rem] uppercase tracking-[0.12em] text-[#7CC4FF]/36">base</div><div className="mt-1 text-[0.66rem] text-[#DDF1FF]/72">{pct(candidate.nativeApr)}</div></div>
                      <div className="bg-[#080D13] p-2"><div className="font-mono-ui text-[0.46rem] uppercase tracking-[0.12em] text-[#7CC4FF]/36">reward</div><div className="mt-1 text-[0.66rem] text-[#DDF1FF]/72">{pct(candidate.rewardApr)}</div></div>
                    </div>
                  </button>
                ))}
              </div>

              <aside className="border border-[#7CC4FF]/10 bg-[#080D13]/70 p-4">
                <p className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em] text-[#7CC4FF]/48">Prepare plan</p>
                {selectedCandidate ? (
                  <div className="mt-3 grid gap-3">
                    <div>
                      <h2 className="text-[0.95rem] text-[#EEF8FF]">{selectedCandidate.project} on {selectedCandidate.chain}</h2>
                      <p className="mt-1 text-[0.66rem] leading-relaxed text-[#DDF1FF]/48">{selectedCandidate.exposure}</p>
                    </div>
                    <div className="grid gap-2">
                      {selectedCandidate.prepareSteps.map((step, index) => (
                        <div key={step} className="flex gap-2 text-[0.66rem] leading-relaxed text-[#DDF1FF]/58">
                          <span className="font-mono-ui text-[#7CC4FF]/48">{index + 1}</span>
                          <span>{step}</span>
                        </div>
                      ))}
                    </div>
                    <p className="border-t border-[#7CC4FF]/10 pt-3 text-[0.62rem] leading-relaxed text-[#DDF1FF]/42">
                      Source: {selectedCandidate.source}. Live discovery is read-only; exact deposits, borrows, LP adds, and hedge orders still require wallet-signed prepare paths.
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 text-[0.72rem] text-[#DDF1FF]/46">Select a live candidate to generate a prepare plan.</p>
                )}
              </aside>
            </div>
          </section>

          <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
            <section className="border border-[#7CC4FF]/12 bg-[#0B1018]/82 p-4" aria-labelledby="method-builder-heading">
              <p id="method-builder-heading" className="font-mono-ui text-[0.56rem] uppercase tracking-[0.18em] text-[#7CC4FF]/50">Method builder</p>
              <div className="mt-4 grid gap-3">
                <div className="grid gap-2">
                  <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.14em] text-[#9FB8D2]">Recipe</span>
                  {PRESETS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setPresetId(item.id)}
                      className="border p-3 text-left transition-colors"
                      style={{ borderColor: item.id === presetId ? ORACLE_BLUE : HAIRLINE, background: item.id === presetId ? "rgba(124,196,255,.08)" : "transparent" }}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[0.84rem] text-[#EEF8FF]">{item.label}</span>
                        <span className="font-mono-ui text-[0.5rem] uppercase tracking-[0.14em] text-[#7CC4FF]/55">{item.risk}</span>
                      </div>
                      <p className="mt-1.5 text-[0.64rem] leading-relaxed text-[#DDF1FF]/44">{RISK_COPY[item.risk]}</p>
                    </button>
                  ))}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    ["Capital USD", capital, setCapital],
                    ["Reward APR", rewardApr, setRewardApr],
                    ["Native APR", nativeApr, setNativeApr],
                    ["Borrow APR", borrowApr, setBorrowApr],
                    ["Funding APR", fundingApr, setFundingApr],
                    ["Gas monthly", gasMonthly, setGasMonthly],
                  ].map(([label, value, setter]) => (
                    <label key={label as string} className="grid gap-1.5">
                      <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.14em] text-[#9FB8D2]">{label as string}</span>
                      <input value={value as string} onChange={(event) => (setter as (next: string) => void)(event.target.value)} inputMode="decimal" className="h-11 border border-[#7CC4FF]/16 bg-[#080D13] px-3 font-mono-ui text-[0.68rem] text-[#DDF1FF] outline-none focus:border-[#7CC4FF]/50" />
                    </label>
                  ))}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1.5">
                    <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.14em] text-[#9FB8D2]">Risk haircut</span>
                    <input value={riskHaircut} onChange={(event) => setRiskHaircut(event.target.value)} inputMode="decimal" className="h-11 border border-[#7CC4FF]/16 bg-[#080D13] px-3 font-mono-ui text-[0.68rem] text-[#DDF1FF] outline-none focus:border-[#7CC4FF]/50" />
                  </label>
                  <label className="grid gap-1.5">
                    <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.14em] text-[#9FB8D2]">Rebalance band</span>
                    <input value={rebalanceBand} onChange={(event) => setRebalanceBand(event.target.value)} inputMode="decimal" className="h-11 border border-[#7CC4FF]/16 bg-[#080D13] px-3 font-mono-ui text-[0.68rem] text-[#DDF1FF] outline-none focus:border-[#7CC4FF]/50" />
                  </label>
                </div>
              </div>
            </section>

            <main className="grid gap-5">
              <section className="border border-[#7CC4FF]/12 bg-[#0B1018]/82 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em] text-[#7CC4FF]/48">Selected method</p>
                    <h2 className="mt-2 font-display-ui text-[1.9rem] leading-none tracking-[-0.04em] text-[#EEF8FF]">{preset.label}</h2>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <ModePill active onClick={() => undefined}>Delta {preset.targetDelta}</ModePill>
                    <ModePill active onClick={() => undefined}>{preset.risk}</ModePill>
                  </div>
                </div>

                <div className="mt-5 grid gap-px overflow-hidden border border-[#7CC4FF]/10 bg-[#7CC4FF]/10 sm:grid-cols-4">
                  {[
                    ["gross APR", pct(calc.grossApr)],
                    ["cost APR", pct(calc.costApr)],
                    ["risk haircut", pct(calc.haircut)],
                    ["rebalance", `${calc.band.toFixed(0)}% drift`],
                  ].map(([name, value]) => (
                    <div key={name} className="bg-[#0B1018] p-3">
                      <div className="font-mono-ui text-[0.5rem] uppercase tracking-[0.16em] text-[#7CC4FF]/42">{name}</div>
                      <div className="mt-1 text-[0.82rem] text-[#DDF1FF]">{value}</div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="grid gap-3 sm:grid-cols-2">
                {[
                  ["Setup", preset.setup],
                  ["Hidden exposure", preset.exposure],
                  ["Hedge", preset.hedge],
                  ["Monitor", preset.monitor],
                  ["Exit rule", preset.exit],
                  ["Net formula", "rewards plus native yield minus borrow, funding, gas, rebalance cost, and risk haircut"],
                ].map(([title, detail]) => (
                  <article key={title} className="border border-[#7CC4FF]/12 bg-[#0B1018]/72 p-4">
                    <p className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em] text-[#7CC4FF]/48">{title}</p>
                    <p className="mt-3 text-[0.78rem] leading-relaxed text-[#DDF1FF]/62">{detail}</p>
                  </article>
                ))}
              </section>
            </main>
          </div>
        </>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
          <section className="border border-[#7CC4FF]/12 bg-[#0B1018]/82 p-4" aria-labelledby="airdrop-builder-heading">
            <p id="airdrop-builder-heading" className="font-mono-ui text-[0.56rem] uppercase tracking-[0.18em] text-[#7CC4FF]/50">Airdrop EV builder</p>
            <div className="mt-4 grid gap-3">
              <div className="grid gap-2">
                <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.14em] text-[#9FB8D2]">Campaign style</span>
                {AIRDROP_STRATEGIES.map((item) => (
                  <button key={item.id} type="button" onClick={() => setAirdropStrategyId(item.id)} className="border p-3 text-left transition-colors" style={{ borderColor: item.id === airdropStrategyId ? ORACLE_BLUE : HAIRLINE, background: item.id === airdropStrategyId ? "rgba(124,196,255,.08)" : "transparent" }}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[0.84rem] text-[#EEF8FF]">{item.label}</span>
                      <span className="font-mono-ui text-[0.5rem] uppercase tracking-[0.14em] text-[#7CC4FF]/55">{item.risk}</span>
                    </div>
                    <p className="mt-1.5 text-[0.64rem] leading-relaxed text-[#DDF1FF]/44">{item.signal}</p>
                  </button>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  ["Wallets", airdropWallets, setAirdropWallets],
                  ["Tasks / week", airdropTasksWeekly, setAirdropTasksWeekly],
                  ["Hours / week", airdropHoursWeekly, setAirdropHoursWeekly],
                  ["Hourly cost", airdropHourlyCost, setAirdropHourlyCost],
                  ["Gas / task", airdropGasPerTask, setAirdropGasPerTask],
                  ["Bridge monthly", airdropBridgeMonthly, setAirdropBridgeMonthly],
                  ["Reward / wallet", airdropExpectedReward, setAirdropExpectedReward],
                  ["Eligibility %", airdropProbability, setAirdropProbability],
                  ["Sybil haircut %", airdropSybilHaircut, setAirdropSybilHaircut],
                  ["Lockup months", airdropLockupMonths, setAirdropLockupMonths],
                ].map(([label, value, setter]) => (
                  <label key={label as string} className="grid gap-1.5">
                    <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.14em] text-[#9FB8D2]">{label as string}</span>
                    <input value={value as string} onChange={(event) => (setter as (next: string) => void)(event.target.value)} inputMode="decimal" className="h-11 border border-[#7CC4FF]/16 bg-[#080D13] px-3 font-mono-ui text-[0.68rem] text-[#DDF1FF] outline-none focus:border-[#7CC4FF]/50" />
                  </label>
                ))}
              </div>
            </div>
          </section>

          <main className="grid gap-5">
            <section className="border border-[#7CC4FF]/12 bg-[#0B1018]/82 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em] text-[#7CC4FF]/48">Selected campaign</p>
                  <h2 className="mt-2 font-display-ui text-[1.9rem] leading-none tracking-[-0.04em] text-[#EEF8FF]">{airdropStrategy.label}</h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  <ModePill active onClick={() => undefined}>{airdropStrategy.risk}</ModePill>
                  <ModePill active onClick={() => undefined}>{airdropCalc.wallets} wallets</ModePill>
                </div>
              </div>

              <div className="mt-5 grid gap-px overflow-hidden border border-[#7CC4FF]/10 bg-[#7CC4FF]/10 sm:grid-cols-4">
                {[
                  ["adjusted EV", fmtUsd(airdropCalc.adjustedExpectedValue)],
                  ["monthly cost", fmtUsd(airdropCalc.monthlyCost)],
                  ["breakeven odds", pct(airdropCalc.breakevenProbability)],
                  ["ROI", pct(airdropCalc.roi)],
                ].map(([name, value]) => (
                  <div key={name} className="bg-[#0B1018] p-3">
                    <div className="font-mono-ui text-[0.5rem] uppercase tracking-[0.16em] text-[#7CC4FF]/42">{name}</div>
                    <div className="mt-1 text-[0.82rem] text-[#DDF1FF]">{value}</div>
                  </div>
                ))}
              </div>
            </section>

            <section className="grid gap-3 sm:grid-cols-2">
              {[
                ["Setup", airdropStrategy.setup],
                ["Eligibility signal", airdropStrategy.signal],
                ["Cost control", airdropStrategy.costControl],
                ["Anti-sybil rule", airdropStrategy.antiSybil],
                ["Exit rule", airdropStrategy.exit],
                ["EV formula", "wallets times reward times probability minus sybil and lockup haircuts, gas, bridge, and labor cost"],
              ].map(([title, detail]) => (
                <article key={title} className="border border-[#7CC4FF]/12 bg-[#0B1018]/72 p-4">
                  <p className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em] text-[#7CC4FF]/48">{title}</p>
                  <p className="mt-3 text-[0.78rem] leading-relaxed text-[#DDF1FF]/62">{detail}</p>
                </article>
              ))}
            </section>

            <section className="border border-[#7CC4FF]/12 bg-[#080D13]/72 p-4">
              <p className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em] text-[#7CC4FF]/48">Prepare plan</p>
              <div className="mt-3 grid gap-2 text-[0.72rem] leading-relaxed text-[#DDF1FF]/58">
                <p>1. Verify official campaign rules, snapshots, prohibited automation, and eligibility criteria.</p>
                <p>2. Generate a wallet and task budget with max monthly cost {fmtUsd(airdropCalc.monthlyCost)} and breakeven odds {pct(airdropCalc.breakevenProbability)}.</p>
                <p>3. Prepare wallet-signed swaps, bridges, mints, or deposits only when the chain, protocol, target, and spend cap are inside the grant.</p>
                <p>4. Log receipts per wallet and stop tasks that do not increase real eligibility evidence.</p>
              </div>
            </section>
          </main>
        </div>
      )}

      <section className="border border-[#7CC4FF]/12 bg-[#7CC4FF]/[0.035] p-4">
        <p className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em] text-[#7CC4FF]/48">Public posture</p>
        <p className="mt-3 text-[0.72rem] leading-relaxed text-[#DDF1FF]/54">
          Oracle designs, compares, and prepares supported wallet actions for user review. Farming methods are not autonomous trading. Delta-neutral means reduced directional exposure, not risk-free yield. Airdrop farming plans must follow official campaign rules and never bypass sybil, identity, or anti-bot policies.
        </p>
      </section>
    </section>
  );
}

export default FarmingMethodsPane;
