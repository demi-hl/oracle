// Braiins mining insights — BTC price stats + pool distribution, keyless.
//
// HOST NOTE (measured): use insights.braiins.com. Two traps:
//   - pool.braiins.com/api/... returns 403 (that host is the pool dashboard,
//     not the public insights API).
//   - insights.braiins.com/api/v1.0/* answers 302 and redirects to
//     learn.braiins.com/api/v1.0/*. Following redirects is required; http.mjs
//     follows same-scheme redirects for GET, so the documented host is kept
//     here as the entry point and the redirect resolves transparently.
//
// Verified live (after redirect):
//   GET /api/v1.0/price-stats  200  { price, percent_change_24h, timestamp }
//   GET /api/v1.0/pool-stats   200  [ { pool_name, blocks_mined{1d,1w,5w}, … } ]
//
// Complements mempool-mining: mempool gives block-count pool share from chain
// data; Braiins publishes miner-economics framing (block value, hashrate share)
// plus a price tick to value it against.
//
// Read-only.

import { httpJson } from "../http.mjs";

export const BRAIINS_INSIGHTS_API = "https://insights.braiins.com/api/v1.0";

function baseUrl(opts = {}) {
  return String(opts.baseUrl || process.env.BRAIINS_INSIGHTS_URL || BRAIINS_INSIGHTS_API).replace(/\/$/, "");
}

function get(path, opts = {}) {
  return httpJson(`${baseUrl(opts)}${path.startsWith("/") ? path : `/${path}`}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
    headers: { Accept: "application/json" },
  });
}

export async function braiinsHealth(opts = {}) {
  try {
    const p = await get("/price-stats", opts);
    const price = Number(p?.price ?? 0);
    return {
      ok: Number.isFinite(price) && price > 0,
      provider: "braiins-insights",
      baseUrl: baseUrl(opts),
      btcUsd: Number.isFinite(price) ? price : null,
      timestamp: p?.timestamp ?? null,
      exec: false,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "braiins-insights",
      baseUrl: baseUrl(opts),
      error: String(error?.message || error),
      exec: false,
    };
  }
}

export async function braiinsPriceStats(_args = {}, opts = {}) {
  const p = await get("/price-stats", opts);
  return {
    provider: "braiins-insights",
    btcUsd: p?.price == null ? null : Number(p.price),
    percentChange24h: p?.percent_change_24h ?? null,
    timestamp: p?.timestamp ?? null,
    raw: p,
  };
}

/**
 * Per-pool mining stats. Braiins nests block counts by window
 * ({ "1d": { absolute, relative_pct }, "1w": …, "5w": … }) — flattened here
 * to the requested window so callers do not have to walk the shape.
 */
export async function braiinsPoolStats(args = {}, opts = {}) {
  const res = await get("/pool-stats", opts);
  const list = Array.isArray(res) ? res : Array.isArray(res?.pools) ? res.pools : [];
  const win = String(args.window || "1w").trim().toLowerCase();
  const pick = (row) => row?.blocks_mined?.[win] || null;
  const rows = [...list].sort((a, b) => Number(pick(b)?.absolute || 0) - Number(pick(a)?.absolute || 0));
  const limit = Math.min(200, Math.max(1, Number(args.limit || rows.length || 1)));
  const windows = list.length ? Object.keys(list[0]?.blocks_mined || {}) : [];
  if (windows.length && !windows.includes(win)) {
    throw new Error(`braiins-insights: window must be one of ${windows.join(", ")}`);
  }
  return {
    provider: "braiins-insights",
    window: win,
    availableWindows: windows,
    count: rows.length,
    pools: rows.slice(0, limit).map((r) => ({
      name: r.pool_name ?? r.name ?? null,
      blocksMined: pick(r)?.absolute ?? null,
      sharePct: pick(r)?.relative_pct ?? null,
      blockValueAvg: r.block_value_avg ?? null,
      hashrate: r.hashrate ?? null,
      luck: r.luck ?? null,
      blocksMinedAllWindows: r.blocks_mined ?? null,
    })),
    raw: rows.slice(0, limit),
  };
}
