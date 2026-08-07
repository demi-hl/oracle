// Bitcoin mining telemetry via mempool.space /api/v1/mining — keyless.
//
// Distinct from bitcoin-esplora (which is the Esplora address/tx/UTXO surface):
// this module answers network-security and miner-economics questions —
// difficulty retarget, pool concentration, hashrate trend, subsidy vs fee split.
//
// Verified live:
//   GET /api/v1/difficulty-adjustment    200
//   GET /api/v1/mining/pools/1w          200
//   GET /api/v1/mining/hashrate/3d       200
//   GET /api/v1/mining/reward-stats/144  200

import { httpJson } from "../http.mjs";

export const MEMPOOL_API = "https://mempool.space/api";

// mempool.space only serves these window tokens; anything else 400s.
const VALID_WINDOWS = new Set(["24h", "3d", "1w", "1m", "3m", "6m", "1y", "2y", "3y", "all"]);

function baseUrl(opts = {}) {
  return String(opts.baseUrl || process.env.MEMPOOL_API_URL || MEMPOOL_API).replace(/\/$/, "");
}

function window_(value, fallback) {
  const w = String(value || fallback).trim().toLowerCase();
  if (!VALID_WINDOWS.has(w)) {
    throw new Error(`mempool-mining: window must be one of ${[...VALID_WINDOWS].join(", ")}`);
  }
  return w;
}

function get(path, opts = {}) {
  return httpJson(`${baseUrl(opts)}${path.startsWith("/") ? path : `/${path}`}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
}

export async function miningHealth(opts = {}) {
  try {
    const d = await get("/v1/difficulty-adjustment", opts);
    return {
      ok: Number.isFinite(Number(d?.nextRetargetHeight)) && Number(d.nextRetargetHeight) > 0,
      provider: "mempool-mining",
      baseUrl: baseUrl(opts),
      nextRetargetHeight: d?.nextRetargetHeight ?? null,
      exec: false,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "mempool-mining",
      baseUrl: baseUrl(opts),
      error: String(error?.message || error),
      exec: false,
    };
  }
}

export async function miningDifficulty(_args = {}, opts = {}) {
  const d = await get("/v1/difficulty-adjustment", opts);
  return {
    provider: "mempool-mining",
    progressPercent: d.progressPercent ?? null,
    difficultyChangePct: d.difficultyChange ?? null,
    estimatedRetargetDate: d.estimatedRetargetDate ?? null,
    remainingBlocks: d.remainingBlocks ?? null,
    remainingTimeMs: d.remainingTime ?? null,
    previousRetargetPct: d.previousRetarget ?? null,
    nextRetargetHeight: d.nextRetargetHeight ?? null,
    timeAvgMs: d.timeAvg ?? null,
    raw: d,
  };
}

/**
 * Pool share over a window. Emits an explicit concentration read (top-1 and
 * top-3 share) because "is any pool near 51%?" is the reason to ask at all.
 */
export async function miningPoolShare(args = {}, opts = {}) {
  const w = window_(args.window || args.timeframe, "1w");
  const res = await get(`/v1/mining/pools/${w}`, opts);
  const pools = Array.isArray(res?.pools) ? res.pools : [];
  const totalBlocks = pools.reduce((n, p) => n + Number(p.blockCount || 0), 0);
  const share = (p) => (totalBlocks > 0 ? (Number(p.blockCount || 0) / totalBlocks) * 100 : null);
  const ranked = [...pools].sort((a, b) => Number(b.blockCount || 0) - Number(a.blockCount || 0));
  const limit = Math.min(200, Math.max(1, Number(args.limit || ranked.length || 1)));
  return {
    provider: "mempool-mining",
    window: w,
    totalBlocks,
    blockCount: res?.blockCount ?? null,
    lastEstimatedHashrate: res?.lastEstimatedHashrate ?? null,
    topPoolSharePct: ranked[0] ? share(ranked[0]) : null,
    top3SharePct: ranked.slice(0, 3).reduce((n, p) => n + (share(p) || 0), 0) || null,
    pools: ranked.slice(0, limit).map((p) => ({
      name: p.name ?? null,
      slug: p.slug ?? null,
      blockCount: p.blockCount ?? null,
      rank: p.rank ?? null,
      sharePct: share(p),
      emptyBlocks: p.emptyBlocks ?? null,
      avgMatchRate: p.avgMatchRate ?? null,
    })),
  };
}

export async function miningHashrate(args = {}, opts = {}) {
  const w = window_(args.window || args.timeframe, "3d");
  const res = await get(`/v1/mining/hashrate/${w}`, opts);
  const series = Array.isArray(res?.hashrates) ? res.hashrates : [];
  return {
    provider: "mempool-mining",
    window: w,
    currentHashrate: res?.currentHashrate ?? null,
    currentHashrateEhs: res?.currentHashrate == null ? null : Number(res.currentHashrate) / 1e18,
    currentDifficulty: res?.currentDifficulty ?? null,
    points: series.length,
    hashrates: series,
    difficulty: Array.isArray(res?.difficulty) ? res.difficulty : [],
  };
}

/** Subsidy vs fee split over the last N blocks (default 144 ≈ one day). */
export async function miningRewardStats(args = {}, opts = {}) {
  const n = Math.min(10_000, Math.max(1, Number(args.blockCount || args.blocks || 144)));
  const r = await get(`/v1/mining/reward-stats/${n}`, opts);
  const totalReward = Number(r.totalReward || 0);
  const totalFee = Number(r.totalFee || 0);
  return {
    provider: "mempool-mining",
    blockCount: n,
    startBlock: r.startBlock ?? null,
    endBlock: r.endBlock ?? null,
    totalRewardSats: String(r.totalReward ?? ""),
    totalFeeSats: String(r.totalFee ?? ""),
    totalSubsidySats: String(totalReward - totalFee),
    feeSharePct: totalReward > 0 ? (totalFee / totalReward) * 100 : null,
    totalTx: r.totalTx ?? null,
    raw: r,
  };
}
