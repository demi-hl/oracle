// Jito MEV — recent bundles and the live tip floor on Solana.
//
// The tip floor is the number that matters operationally: it is what a
// transaction must pay a Jito validator to be included in a bundle right now.
// Read-only — Oracle never submits a bundle.

import { httpJson } from "../http.mjs";

export const JITO_BUNDLES_API = "https://bundles.jito.wtf";
export const LAMPORTS_PER_SOL = 1_000_000_000;

function base(opts = {}) {
  return String(opts.baseUrl || process.env.JITO_BUNDLES_URL || JITO_BUNDLES_API).replace(/\/$/, "");
}

function intInRange(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.floor(n), max));
}

function solToLamports(sol) {
  const n = Number(sol);
  return Number.isFinite(n) ? Math.round(n * LAMPORTS_PER_SOL) : null;
}

function normalizeBundle(bundle = {}) {
  const lamports = Number(bundle.landedTipLamports);
  return {
    bundleId: bundle.bundleId || null,
    timestamp: bundle.timestamp || null,
    validator: bundle.validator || null,
    tippers: bundle.tippers || [],
    transactions: bundle.transactions || [],
    transactionCount: Array.isArray(bundle.transactions) ? bundle.transactions.length : 0,
    landedTipLamports: Number.isFinite(lamports) ? lamports : null,
    landedTipSol: Number.isFinite(lamports) ? lamports / LAMPORTS_PER_SOL : null,
    raw: bundle,
  };
}

export async function jitoHealth(opts = {}) {
  try {
    const data = await httpJson(`${base(opts)}/api/v1/bundles/tip_floor`, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 12_000,
    });
    const row = Array.isArray(data) ? data[0] : data;
    const p50 = Number(row?.landed_tips_50th_percentile);
    return {
      ok: Number.isFinite(p50),
      provider: "jito-mev",
      tipFloorP50Sol: Number.isFinite(p50) ? p50 : null,
      asOf: row?.time || null,
      exec: false,
    };
  } catch (error) {
    return { ok: false, provider: "jito-mev", error: String(error?.message || error), exec: false };
  }
}

/**
 * Most recent landed bundles. Jito serves this at /bundles/recent — the bare
 * /bundles path 404s, so callers must not "simplify" the URL.
 */
export async function jitoRecentBundles(args = {}, opts = {}) {
  const limit = intInRange(args.limit, 5, 100);
  const url = new URL(`${base(opts)}/api/v1/bundles/recent`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sort", String(args.sort || "Time"));
  url.searchParams.set("asc", String(Boolean(args.asc)));
  const data = await httpJson(url.toString(), {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
  const list = Array.isArray(data) ? data : Array.isArray(data?.bundles) ? data.bundles : [];
  const bundles = list.map(normalizeBundle);
  const tips = bundles.map((b) => b.landedTipLamports).filter((n) => Number.isFinite(n));
  return {
    provider: "jito-mev",
    chain: "solana-mainnet-beta",
    count: bundles.length,
    totalTipLamports: tips.reduce((a, b) => a + b, 0),
    maxTipLamports: tips.length ? Math.max(...tips) : null,
    bundles,
  };
}

/**
 * Current tip floor percentiles, in SOL as published plus lamports for the
 * caller who has to actually set a tip instruction amount.
 */
export async function jitoTipFloor(opts = {}) {
  const data = await httpJson(`${base(opts)}/api/v1/bundles/tip_floor`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 12_000,
  });
  const row = (Array.isArray(data) ? data[0] : data) || {};
  const percentiles = {
    p25: Number(row.landed_tips_25th_percentile) || 0,
    p50: Number(row.landed_tips_50th_percentile) || 0,
    p75: Number(row.landed_tips_75th_percentile) || 0,
    p95: Number(row.landed_tips_95th_percentile) || 0,
    p99: Number(row.landed_tips_99th_percentile) || 0,
    ema50: Number(row.ema_landed_tips_50th_percentile) || 0,
  };
  return {
    provider: "jito-mev",
    chain: "solana-mainnet-beta",
    asOf: row.time || null,
    tipFloorSol: percentiles,
    tipFloorLamports: Object.fromEntries(Object.entries(percentiles).map(([k, v]) => [k, solToLamports(v)])),
    // A pragmatic default for landing a bundle without overpaying the tail.
    suggestedTipLamports: solToLamports(percentiles.p75 || percentiles.p50),
    raw: row,
  };
}
