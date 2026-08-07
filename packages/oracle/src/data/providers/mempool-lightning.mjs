// Lightning Network topology via mempool.space /api/v1/lightning — keyless.
//
// Verified live:
//   GET /api/v1/lightning/statistics/latest             200
//   GET /api/v1/lightning/nodes/rankings/connectivity   200
//   GET /api/v1/lightning/nodes/countries               200
//
// STALENESS CAVEAT (measured, not hypothetical): mempool.space's Lightning
// crawler runs on its own schedule and the `statistics/latest` snapshot has
// been observed WEEKS behind wall clock. Every op below therefore reports
// `ageDays` / `stale` alongside the data so a caller cannot mistake an old
// snapshot for a live one. Treat these numbers as a trend, not a tick.

import { httpJson } from "../http.mjs";

export const MEMPOOL_API = "https://mempool.space/api";
/** Snapshots older than this are flagged stale in every response. */
export const LN_STALE_AFTER_DAYS = 7;

function baseUrl(opts = {}) {
  return String(opts.baseUrl || process.env.MEMPOOL_API_URL || MEMPOOL_API).replace(/\/$/, "");
}

function get(path, opts = {}) {
  return httpJson(`${baseUrl(opts)}${path.startsWith("/") ? path : `/${path}`}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
}

function ageOf(when) {
  if (!when) return { ageDays: null, stale: null };
  const t = new Date(when).getTime();
  if (!Number.isFinite(t)) return { ageDays: null, stale: null };
  const ageDays = (Date.now() - t) / 86_400_000;
  return { ageDays: Math.round(ageDays * 10) / 10, stale: ageDays > LN_STALE_AFTER_DAYS };
}

export async function lightningHealth(opts = {}) {
  try {
    const res = await get("/v1/lightning/statistics/latest", opts);
    const latest = res?.latest || {};
    const { ageDays, stale } = ageOf(latest.added);
    return {
      // ok = the endpoint answered with a usable snapshot. Staleness is
      // reported, not treated as an outage — the API is up either way.
      ok: Number(latest.node_count || 0) > 0,
      provider: "mempool-lightning",
      baseUrl: baseUrl(opts),
      snapshotAt: latest.added ?? null,
      ageDays,
      stale,
      nodeCount: latest.node_count ?? null,
      exec: false,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "mempool-lightning",
      baseUrl: baseUrl(opts),
      error: String(error?.message || error),
      exec: false,
    };
  }
}

export async function lightningStatistics(_args = {}, opts = {}) {
  const res = await get("/v1/lightning/statistics/latest", opts);
  const s = res?.latest || {};
  const { ageDays, stale } = ageOf(s.added);
  return {
    provider: "mempool-lightning",
    snapshotAt: s.added ?? null,
    ageDays,
    stale,
    staleNote: stale
      ? `mempool.space Lightning snapshot is ${ageDays} days old — trend only, not live state`
      : undefined,
    nodeCount: s.node_count ?? null,
    channelCount: s.channel_count ?? null,
    totalCapacitySats: s.total_capacity == null ? null : String(s.total_capacity),
    totalCapacityBtc: s.total_capacity == null ? null : Number(s.total_capacity) / 1e8,
    avgCapacitySats: s.avg_capacity == null ? null : String(s.avg_capacity),
    avgFeeRatePpm: s.avg_fee_rate ?? null,
    avgBaseFeeMsat: s.avg_base_fee_mtokens ?? null,
    torNodes: s.tor_nodes ?? null,
    clearnetNodes: s.clearnet_nodes ?? null,
    unannouncedNodes: s.unannounced_nodes ?? null,
    raw: s,
  };
}

/**
 * Node rankings. `metric` selects the mempool.space ranking route:
 *   connectivity (default) | liquidity | channels
 */
export async function lightningNodeRankings(args = {}, opts = {}) {
  const metric = String(args.metric || args.ranking || "connectivity").trim().toLowerCase();
  const allowed = new Set(["connectivity", "liquidity", "channels"]);
  if (!allowed.has(metric)) {
    throw new Error(`mempool-lightning: metric must be one of ${[...allowed].join(", ")}`);
  }
  const rows = await get(`/v1/lightning/nodes/rankings/${metric}`, opts);
  const list = Array.isArray(rows) ? rows : [];
  const limit = Math.min(100, Math.max(1, Number(args.limit || list.length || 1)));
  return {
    provider: "mempool-lightning",
    metric,
    count: list.length,
    nodes: list.slice(0, limit).map((n) => ({
      publicKey: n.publicKey ?? null,
      alias: n.alias ?? null,
      channels: n.channels ?? null,
      capacitySats: n.capacity == null ? null : String(n.capacity),
      firstSeen: n.firstSeen ?? null,
      updatedAt: n.updatedAt ?? null,
      city: n.city?.en ?? n.city ?? null,
      country: n.country?.en ?? n.country ?? null,
      iso: n.iso_code ?? null,
    })),
  };
}

/** Node distribution by country — the decentralization read. */
export async function lightningNodeCountries(args = {}, opts = {}) {
  const rows = await get("/v1/lightning/nodes/countries", opts);
  const list = Array.isArray(rows) ? rows : [];
  const limit = Math.min(250, Math.max(1, Number(args.limit || list.length || 1)));
  const totalNodes = list.reduce((n, c) => n + Number(c.count || 0), 0);
  return {
    provider: "mempool-lightning",
    countryCount: list.length,
    totalNodes,
    topCountrySharePct: list[0]?.share ?? null,
    countries: list.slice(0, limit).map((c) => ({
      // Names arrive as a multi-language object; pick English, keep the rest.
      name: c.name?.en ?? c.name ?? null,
      iso: c.iso ?? null,
      count: c.count ?? null,
      sharePct: c.share ?? null,
      capacitySats: c.capacity == null ? null : String(c.capacity),
    })),
  };
}
