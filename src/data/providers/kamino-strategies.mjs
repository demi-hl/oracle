// Kamino Finance — Solana concentrated-liquidity vault strategies and APY.
//
// One upstream call returns metrics for every live strategy (500+), so this
// module fetches once and filters/sorts locally rather than issuing a request
// per strategy. Read-only: no deposit or withdraw preparation.

import { httpJson } from "../http.mjs";

export const KAMINO_API = "https://api.kamino.finance";

function base(opts = {}) {
  return String(opts.baseUrl || process.env.KAMINO_API_URL || KAMINO_API).replace(/\/$/, "");
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeStrategy(entry = {}) {
  const tvl = num(entry.totalValueLocked) ?? 0;
  // Kamino splits yield: `apy` is trading fees + pool rewards, `kaminoApy` is
  // the kToken incentive layer. Neither alone is the number a depositor earns.
  const feeApy = num(entry.apy?.totalApy) ?? 0;
  const rewardApy = num(entry.kaminoApy?.totalApy) ?? 0;
  return {
    strategy: entry.strategy || null,
    pair: entry.tokenA && entry.tokenB ? `${entry.tokenA}-${entry.tokenB}` : null,
    tokenA: entry.tokenA || null,
    tokenB: entry.tokenB || null,
    tokenAMint: entry.tokenAMint || null,
    tokenBMint: entry.tokenBMint || null,
    tvlUsd: tvl,
    sharePrice: num(entry.sharePrice),
    sharesIssued: num(entry.sharesIssued),
    profitAndLoss: num(entry.profitAndLoss),
    feeApy,
    feeApyPct: feeApy * 100,
    rewardApy,
    rewardApyPct: rewardApy * 100,
    totalApy: feeApy + rewardApy,
    totalApyPct: (feeApy + rewardApy) * 100,
    apr24h: num(entry.apy?.vault?.totalApr),
    apy24h: num(entry.kaminoApy?.vault?.apy24h),
    apy7d: num(entry.kaminoApy?.vault?.apy7d),
    apy30d: num(entry.kaminoApy?.vault?.apy30d),
    poolPrice: num(entry.apy?.vault?.poolPrice),
    priceLower: num(entry.apy?.vault?.priceLower),
    priceUpper: num(entry.apy?.vault?.priceUpper),
    // A range-exited strategy has stopped earning fees — surface it loudly.
    outOfRange: Boolean(entry.apy?.vault?.strategyOutOfRange),
    rewardMints: entry.rewardMints || [],
    balances: entry.vaultBalances || null,
    lastCalculated: entry.kaminoApy?.vault?.lastCalculated || null,
  };
}

async function fetchMetrics(args = {}, opts = {}) {
  const url = new URL(`${base(opts)}/strategies/metrics`);
  url.searchParams.set("env", String(args.env || "mainnet-beta"));
  url.searchParams.set("status", String(args.status || "LIVE"));
  const data = await httpJson(url.toString(), {
    fetchImpl: opts.fetchImpl,
    // 500+ strategies with nested APY blocks — this is a large, slow payload.
    timeoutMs: opts.timeoutMs ?? 45_000,
  });
  return Array.isArray(data) ? data : [];
}

export async function kaminoHealth(opts = {}) {
  try {
    const raw = await fetchMetrics({}, opts);
    const funded = raw.filter((s) => (Number(s.totalValueLocked) || 0) > 0).length;
    return {
      ok: raw.length > 0,
      provider: "kamino-strategies",
      strategies: raw.length,
      funded,
      exec: false,
    };
  } catch (error) {
    return { ok: false, provider: "kamino-strategies", error: String(error?.message || error), exec: false };
  }
}

/**
 * Live strategies, filterable and ranked. Defaults hide the long tail of
 * empty/dust vaults, which are the bulk of the 500+ raw rows and are not
 * actionable yield.
 */
export async function kaminoStrategies(args = {}, opts = {}) {
  const raw = await fetchMetrics(args, opts);
  let strategies = raw.map(normalizeStrategy);
  const total = strategies.length;

  const minTvl = Number.isFinite(Number(args.minTvlUsd)) ? Number(args.minTvlUsd) : 10_000;
  strategies = strategies.filter((s) => s.tvlUsd >= minTvl);

  if (args.token) {
    const want = String(args.token).toLowerCase();
    strategies = strategies.filter(
      (s) =>
        String(s.tokenA || "").toLowerCase() === want ||
        String(s.tokenB || "").toLowerCase() === want ||
        s.tokenAMint === args.token ||
        s.tokenBMint === args.token
    );
  }
  if (args.pair) {
    const want = String(args.pair).toLowerCase().replace(/[/_]/g, "-");
    strategies = strategies.filter((s) => String(s.pair || "").toLowerCase() === want);
  }
  if (args.inRangeOnly === true) strategies = strategies.filter((s) => !s.outOfRange);

  const sortBy = String(args.sortBy || "apy");
  strategies.sort((a, b) => (sortBy === "tvl" ? b.tvlUsd - a.tvlUsd : b.totalApy - a.totalApy));

  const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : 25;
  const page = strategies.slice(0, limit);

  return {
    provider: "kamino-strategies",
    chain: "solana-mainnet-beta",
    env: args.env || "mainnet-beta",
    status: args.status || "LIVE",
    totalStrategies: total,
    matched: strategies.length,
    count: page.length,
    minTvlUsd: minTvl,
    tvlUsdMatched: strategies.reduce((a, s) => a + s.tvlUsd, 0),
    strategies: page,
  };
}

/** Metrics for one strategy address. */
export async function kaminoStrategyMetrics(args = {}, opts = {}) {
  const address = String(args.strategy || args.address || "").trim();
  if (!address) throw new Error("kamino-strategies: strategy address required");
  const raw = await fetchMetrics({ ...args, status: args.status || "ALL" }, opts);
  const found = raw.find((s) => s.strategy === address);
  if (!found) throw new Error(`kamino-strategies: strategy ${address} not found`);
  return { provider: "kamino-strategies", chain: "solana-mainnet-beta", ...normalizeStrategy(found), raw: found };
}
