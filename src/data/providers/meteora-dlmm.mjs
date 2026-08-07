// Meteora — Solana AMM pool discovery (dynamic AMM, DLMM-adjacent, LST, farms).
//
// This is a POOL INVENTORY surface, not a router: it answers "where is the
// liquidity and what does it yield", which Jupiter's quote endpoint does not.
// Read-only — no position or swap preparation.
//
// Upstream query-string quirks that are easy to get wrong:
//   - text search is `filter=`, NOT `search_term=`/`q=`/`name=` (those are
//     accepted and then silently IGNORED, returning the unfiltered top pools)
//   - sort_key is an enum: tvl | volume | fee_tvl_ratio | l_m
//   - pool_type is an enum: dynamic | multitoken | lst | farms
//   Anything outside those enums 400s.

import { httpJson } from "../http.mjs";

export const METEORA_AMM_API = "https://amm-v2.meteora.ag";

const SORT_KEYS = new Set(["tvl", "volume", "fee_tvl_ratio", "l_m"]);
const POOL_TYPES = new Set(["dynamic", "multitoken", "lst", "farms"]);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function base(opts = {}) {
  return String(opts.baseUrl || process.env.METEORA_API_URL || METEORA_AMM_API).replace(/\/$/, "");
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizePool(pool = {}) {
  return {
    address: pool.pool_address || null,
    name: pool.pool_name || null,
    type: pool.pool_type || null,
    version: pool.pool_version ?? null,
    mints: pool.pool_token_mints || [],
    tokenAmounts: pool.pool_token_amounts || [],
    tokenUsdAmounts: pool.pool_token_usd_amounts || [],
    lpMint: pool.lp_mint || null,
    lpDecimals: pool.lp_decimal ?? null,
    lpPriceUsd: num(pool.pool_lp_price_in_usd),
    tvlUsd: num(pool.pool_tvl),
    farmTvlUsd: num(pool.farm_tvl),
    volume24hUsd: num(pool.trading_volume),
    volume7dUsd: num(pool.weekly_trading_volume),
    fee24hUsd: num(pool.fee_volume),
    fee7dUsd: num(pool.weekly_fee_volume),
    // trade_apy is fee yield; farming_apy is emissions. They are additive.
    tradeApyPct: num(pool.trade_apy),
    weeklyTradeApyPct: num(pool.weekly_trade_apy),
    baseApyPct: num(pool.daily_base_apy),
    farmingApyPct: num(pool.farming_apy),
    totalApyPct: (num(pool.trade_apy) ?? 0) + (num(pool.farming_apy) ?? 0),
    aprPct: num(pool.apr),
    feePct: num(pool.total_fee_pct),
    farmingPool: pool.farming_pool || null,
    isLst: Boolean(pool.is_lst),
    isMeme: Boolean(pool.is_meme),
    permissioned: Boolean(pool.permissioned),
    // Meteora's own "we don't recognise these tokens" flag — treat as risk.
    unknownTokens: Boolean(pool.unknown),
    createdAt: pool.created_at ?? null,
  };
}

function buildSearchUrl(args = {}, opts = {}) {
  const url = new URL(`${base(opts)}/pools/search`);
  const page = Math.max(0, Number(args.page) || 0);
  const size = Math.max(1, Math.min(Number(args.size ?? args.limit) || 20, 100));
  url.searchParams.set("page", String(page));
  url.searchParams.set("size", String(size));

  if (args.sortKey != null) {
    const key = String(args.sortKey);
    if (!SORT_KEYS.has(key)) {
      throw new Error(`meteora-dlmm: sortKey must be one of ${[...SORT_KEYS].join(", ")}`);
    }
    url.searchParams.set("sort_key", key);
    url.searchParams.set("order_by", args.orderBy === "asc" ? "asc" : "desc");
  }
  if (args.poolType != null) {
    const type = String(args.poolType);
    if (!POOL_TYPES.has(type)) {
      throw new Error(`meteora-dlmm: poolType must be one of ${[...POOL_TYPES].join(", ")}`);
    }
    url.searchParams.set("pool_type", type);
  }
  const filter = args.filter ?? args.query ?? args.search;
  if (filter != null && String(filter).trim()) url.searchParams.set("filter", String(filter).trim());
  const mints = args.mints || args.includeTokenMints;
  if (mints) {
    const list = (Array.isArray(mints) ? mints : [mints]).map((m) => String(m).trim());
    for (const mint of list) {
      if (!BASE58.test(mint)) throw new Error(`meteora-dlmm: mint ${mint} is not a base58 public key`);
    }
    url.searchParams.set("include_token_mints", list.join(","));
  }
  return { url, page, size };
}

async function search(args = {}, opts = {}) {
  const { url, page, size } = buildSearchUrl(args, opts);
  const data = await httpJson(url.toString(), {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
  const pools = (Array.isArray(data?.data) ? data.data : []).map(normalizePool);
  return { pools, totalCount: data?.total_count ?? null, page, size };
}

export async function meteoraHealth(opts = {}) {
  try {
    const { pools, totalCount } = await search({ size: 3 }, opts);
    return {
      ok: pools.length > 0,
      provider: "meteora-dlmm",
      poolsIndexed: totalCount,
      sample: pools.length,
      exec: false,
    };
  } catch (error) {
    return { ok: false, provider: "meteora-dlmm", error: String(error?.message || error), exec: false };
  }
}

/** Top pools, ranked. Defaults to highest TVL. */
export async function meteoraPools(args = {}, opts = {}) {
  const result = await search({ sortKey: args.sortKey || "tvl", orderBy: args.orderBy || "desc", ...args }, opts);
  let pools = result.pools;
  const minTvl = Number(args.minTvlUsd);
  if (Number.isFinite(minTvl)) pools = pools.filter((p) => (p.tvlUsd ?? 0) >= minTvl);
  if (args.excludeUnknown === true) pools = pools.filter((p) => !p.unknownTokens);
  return {
    provider: "meteora-dlmm",
    chain: "solana-mainnet-beta",
    page: result.page,
    size: result.size,
    totalCount: result.totalCount,
    count: pools.length,
    tvlUsd: pools.reduce((a, p) => a + (p.tvlUsd ?? 0), 0),
    pools,
  };
}

/**
 * Search pools by token symbol/name text or by exact mint.
 * Prefer `mints` — text search matches pool names, which meme tokens spoof.
 */
export async function meteoraPoolSearch(args = {}, opts = {}) {
  const filter = args.filter ?? args.query ?? args.search;
  const mints = args.mints || args.includeTokenMints;
  if ((filter == null || !String(filter).trim()) && !mints) {
    throw new Error("meteora-dlmm: poolSearch requires filter text or mints[]");
  }
  const result = await search({ sortKey: args.sortKey || "tvl", orderBy: "desc", ...args }, opts);
  return {
    provider: "meteora-dlmm",
    chain: "solana-mainnet-beta",
    filter: filter ?? null,
    mints: mints ? (Array.isArray(mints) ? mints : [mints]) : [],
    page: result.page,
    size: result.size,
    totalCount: result.totalCount,
    count: result.pools.length,
    pools: result.pools,
  };
}
