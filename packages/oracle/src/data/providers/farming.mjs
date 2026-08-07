// Farming method presets, live candidate scoring, and airdrop EV math.
//
// This is the SHARED implementation. apps/oracle-app's FarmingMethodsPane and
// /api/oracle/farming carried this logic inline, so the CLI had no farming or
// airdrop surface at all. Scoring lives here now so the app, the CLI, and any
// MCP harness produce identical numbers instead of drifting copies.
//
// Read-only and prepare-only: this module ranks opportunities and designs
// prepare plans. It never signs, never broadcasts, and never holds a key.

import { llamaYields } from "./defillama.mjs";

export const FARMING_METHODS = Object.freeze([
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
    targetDelta: "~0.00",
    setup: "Supply a volatile asset as collateral, borrow stables, and short the collateral notional on a liquid perp venue.",
    exposure: "Liquidation risk, funding cost, hedge slippage, borrow APR drift.",
    hedge: "Short collateral notional on a liquid perp venue; rebalance when delta drifts past the band.",
    monitor: "Health factor, funding, mark price, borrow APR, hedge margin.",
    exit: "Cut when funding turns persistently negative against the position or health factor nears the floor.",
  },
  {
    id: "lp-hedge",
    label: "LP incentive hedge",
    risk: "Aggressive",
    targetDelta: "range-dependent",
    setup: "Provide concentrated liquidity for incentives and short the estimated volatile-token delta.",
    exposure: "Impermanent loss, range breaks, reward dilution, exit slippage.",
    hedge: "Short the estimated volatile-token delta and recompute after material price or range moves.",
    monitor: "Position delta, range utilization, fee APR, rewards, funding, exit slippage.",
    exit: "Withdraw when incentives dilute, liquidity caps fill, or expected reward no longer beats IL plus opportunity cost.",
  },
  {
    id: "quest-farming",
    label: "Testnet and quest farming",
    risk: "Conservative",
    targetDelta: "n/a",
    setup: "Complete real protocol tasks with consistent, genuine usage from wallets you actually control.",
    exposure: "Eligibility rules change, sybil filters, unpaid effort, opportunity cost.",
    hedge: "No financial hedge. Diversify across campaigns so no single ruleset dominates the outcome.",
    monitor: "Campaign rules, snapshot windows, task eligibility evidence, wallet hygiene.",
    exit: "Stop once snapshot risk rises, campaign rules change, or the probability-adjusted expected value turns negative.",
  },
  {
    id: "liquidity-usage",
    label: "Liquidity and route usage",
    risk: "Balanced",
    targetDelta: "varies",
    setup: "Route genuine volume and provide liquidity where usage is a stated eligibility signal.",
    exposure: "IL, slippage, gas burn, bridge fees, lockup discount.",
    hedge: "Size positions so IL and fees stay inside the modelled reward, and hedge volatile legs when material.",
    monitor: "Volume attribution, fee drag, reward accrual, lockup terms.",
    exit: "Withdraw when incentives dilute or expected reward no longer beats IL plus opportunity cost.",
  },
  {
    id: "governance-usage",
    label: "Governance and ecosystem usage",
    risk: "Conservative",
    targetDelta: "n/a",
    setup: "Participate in governance and ecosystem surfaces where real contribution is the eligibility signal.",
    exposure: "Vanity activity with no eligibility weight, lock-up of governance assets.",
    hedge: "No financial hedge. Weight effort toward actions with documented eligibility evidence.",
    monitor: "Proposal participation, delegation terms, lock durations, published criteria.",
    exit: "Stop contributing effort once criteria change or the probability-adjusted value turns negative.",
  },
]);

const RECIPE_HEDGE = {
  "stable-loop": "No default perp hedge. Bound leverage and monitor depeg plus borrow APR.",
  "collateral-hedge": "Short the collateral notional on a liquid perp venue and rebalance when delta drifts.",
  "lp-hedge": "Short the estimated volatile-token delta and recompute after material price or range moves.",
};

const RECIPE_MONITOR = {
  "stable-loop": "Borrow APR, utilization, stable peg, reward dilution, health factor.",
  "collateral-hedge": "Health factor, funding, mark price, borrow APR, hedge margin.",
  "lp-hedge": "Position delta, range utilization, fee APR, rewards, funding, exit slippage.",
};

const RECIPE_STEPS = {
  "stable-loop": [
    "Prepare supply for the stable collateral leg.",
    "Prepare borrow only after health factor and borrow APR pass the method limits.",
    "Prepare redeposit or unwind steps as separate wallet-signed actions.",
  ],
  "collateral-hedge": [
    "Prepare collateral supply after sizing liquidation buffer.",
    "Prepare stable borrow if borrow APR remains inside the method limit.",
    "Open or adjust the perp short on the selected hedge venue, then record hedge size.",
  ],
  "lp-hedge": [
    "Prepare LP add only after checking pool depth, range, and expected position delta.",
    "Short the estimated volatile-token delta on the selected hedge venue.",
    "Prepare LP remove if the range breaks or net APR turns negative.",
  ],
};

function num(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeText(value, fallback = "unknown") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed === "" ? fallback : trimmed.slice(0, 96);
}

export function classifyPool(pool) {
  const symbol = safeText(pool.symbol, "").toUpperCase();
  const exposure = safeText(pool.exposure, "").toLowerCase();
  const apy = num(pool.apy) ?? 0;
  const tvl = num(pool.tvlUsd) ?? 0;
  if (apy <= 0 || tvl <= 0) return null;
  if (pool.stablecoin === true) return "stable-loop";
  if (symbol.includes("-") || exposure.includes("multi")) return "lp-hedge";
  if (/ETH|BTC|SOL|HYPE|BNB|AVAX|MATIC|OP|ARB/.test(symbol)) return "collateral-hedge";
  return null;
}

// Thin TVL and adverse predictions widen the haircut; this is the same curve the
// app pane scores against, kept here so both surfaces agree.
export function riskHaircut(pool, recipe) {
  const tvl = num(pool.tvlUsd) ?? 0;
  const il = safeText(pool.ilRisk, "").toLowerCase();
  const prediction = safeText(pool.predictions?.predictedClass, "").toLowerCase();
  let risk = recipe === "stable-loop" ? 3 : recipe === "collateral-hedge" ? 6 : 9;
  if (tvl < 1_000_000) risk += 6;
  else if (tvl < 10_000_000) risk += 3;
  if (il.includes("yes") || il.includes("high")) risk += 3;
  if (prediction.includes("down")) risk += 2;
  return Math.min(35, Math.max(0, risk));
}

export function scorePool(pool) {
  const recipe = classifyPool(pool);
  if (!recipe) return null;
  const apy = num(pool.apy) ?? 0;
  const apyBase = num(pool.apyBase) ?? 0;
  const apyReward = Math.max(0, num(pool.apyReward) ?? Math.max(0, apy - apyBase));
  const tvlUsd = Math.max(0, num(pool.tvlUsd) ?? 0);
  const haircut = riskHaircut(pool, recipe);
  const estimatedBorrowApr = recipe === "stable-loop" ? 4 : recipe === "collateral-hedge" ? 6 : 0;
  const estimatedFundingApr = recipe === "stable-loop" ? 0 : recipe === "collateral-hedge" ? 4 : 5;
  const gasApr = tvlUsd < 5_000_000 ? 1.2 : 0.5;
  const netApr = apy - estimatedBorrowApr - estimatedFundingApr - gasApr - haircut;

  // A high headline APY on a thin pool is a warning, not a green light, so it
  // is capped to Watchlist regardless of how good the net number looks.
  const verdict =
    netApr < 1 ? "Avoid"
      : apy > 80 || tvlUsd < 10_000_000 ? "Watchlist"
        : netApr >= 8 ? "Farmable" : "Watchlist";

  const project = safeText(pool.project);
  const symbol = safeText(pool.symbol);
  const chain = safeText(pool.chain);
  return {
    id: safeText(pool.pool, `${chain}:${project}:${symbol}`),
    recipe,
    label: `${project} ${symbol}`,
    chain,
    project,
    symbol,
    tvlUsd,
    rewardApr: apyReward,
    nativeApr: apyBase,
    estimatedBorrowApr,
    estimatedFundingApr,
    gasApr,
    riskHaircut: haircut,
    netApr,
    verdict,
    exposure: safeText(
      pool.exposure,
      recipe === "stable-loop" ? "stablecoin" : recipe === "lp-hedge" ? "multi-asset LP" : "single-asset collateral",
    ),
    hedge: RECIPE_HEDGE[recipe],
    monitor: RECIPE_MONITOR[recipe],
    prepareSteps: [
      `Verify ${project} contracts and reward terms on ${chain}.`,
      "Set wallet grant with chain, protocol, max value, slippage, and TTL before preparing any transaction.",
      ...RECIPE_STEPS[recipe],
    ],
    source: "DeFiLlama yields",
  };
}

export async function discoverFarms(args = {}, opts = {}) {
  const limit = Math.min(24, Math.max(3, Number(args.limit ?? 12) || 12));
  const minTvl = Number(args.minTvl ?? 2_000_000);
  const generatedAt = new Date().toISOString();
  const posture = "read-only discovery and prepare-plan design; no signing or broadcast";
  try {
    const result = await llamaYields(
      { chain: args.chain && args.chain !== "all" ? args.chain : undefined, limit: 5000 },
      opts,
    );
    const rows = Array.isArray(result?.data) ? result.data : [];
    const candidates = rows
      .map(scorePool)
      .filter((x) => x !== null)
      .filter((x) => x.tvlUsd >= minTvl)
      // Headline APRs above 300% are almost always a stale or broken feed rather
      // than a real opportunity, so they never reach the ranking.
      .filter((x) => x.rewardApr + x.nativeApr <= 300)
      .sort((a, b) => b.netApr - a.netApr || b.tvlUsd - a.tvlUsd)
      .slice(0, limit);
    return {
      configured: true, live: true, source: "DeFiLlama yields",
      generatedAt, chain: args.chain ?? "all",
      considered: rows.length,
      consideredNote: "deepest pools by TVL from the DeFiLlama yields feed",
      candidates, posture,
    };
  } catch (error) {
    return {
      configured: false, live: false, source: "DeFiLlama yields",
      generatedAt, chain: args.chain ?? "all",
      considered: 0,
      consideredNote: "deepest pools by TVL from the DeFiLlama yields feed",
      error: String(error?.message || error), candidates: [], posture,
    };
  }
}

function clampNumber(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Airdrop expected value after real costs and honest haircuts. Every term is a
// user input: this is an estimate of THEIR plan, never a payout prediction.
export function airdropEV(input = {}) {
  const wallets = clampNumber(input.wallets, 5, 1, 500);
  const tasksWeekly = clampNumber(input.tasksWeekly, 6, 0, 500);
  const hoursWeekly = clampNumber(input.hoursWeekly, 4, 0, 168);
  const hourlyCost = clampNumber(input.hourlyCost, 25, 0, 10_000);
  const gasPerTask = clampNumber(input.gasPerTask, 0.4, 0, 10_000);
  const bridgeMonthly = clampNumber(input.bridgeMonthly, 12, 0, 100_000);
  const expectedReward = clampNumber(input.expectedReward, 900, 0, 10_000_000);
  const probability = clampNumber(input.probability, 22, 0, 100) / 100;
  const sybilHaircut = clampNumber(input.sybilHaircut, 25, 0, 100) / 100;
  const lockupMonths = clampNumber(input.lockupMonths, 6, 0, 120);

  const monthlyTasks = tasksWeekly * wallets * 4.33;
  const monthlyGas = monthlyTasks * gasPerTask;
  const laborMonthly = hoursWeekly * 4.33 * hourlyCost;
  const monthlyCost = monthlyGas + laborMonthly + bridgeMonthly;

  // Locked rewards are discounted ~1.5%/month to reflect that a claim you
  // cannot sell for a year is not worth its face value today.
  const lockupDiscount = Math.max(0, 1 - lockupMonths * 0.015);
  const grossExpectedValue = wallets * expectedReward * probability;
  const adjustedExpectedValue = grossExpectedValue * (1 - sybilHaircut) * lockupDiscount;
  const netExpectedValue = adjustedExpectedValue - monthlyCost;
  const roi = monthlyCost > 0 ? (netExpectedValue / monthlyCost) * 100 : null;
  const breakevenProbability = wallets * expectedReward > 0
    ? (monthlyCost / (wallets * expectedReward * (1 - sybilHaircut) * (lockupDiscount || 1))) * 100
    : null;

  return {
    inputs: {
      wallets, tasksWeekly, hoursWeekly, hourlyCost, gasPerTask, bridgeMonthly,
      expectedReward, probabilityPct: probability * 100,
      sybilHaircutPct: sybilHaircut * 100, lockupMonths,
    },
    monthlyTasks, monthlyGas, laborMonthly, monthlyCost,
    lockupDiscount, grossExpectedValue, adjustedExpectedValue,
    netExpectedValue, roiPct: roi, breakevenProbabilityPct: breakevenProbability,
    verdict: netExpectedValue > 0 ? "positive-ev" : "negative-ev",
    posture: "estimate on your own inputs; not a payout promise and not financial advice",
  };
}

export default { FARMING_METHODS, discoverFarms, scorePool, classifyPool, riskHaircut, airdropEV };
