// Relayscan (Flashbots) — Ethereum MEV-Boost relay + builder monitoring, no key.
//
// Read-only mainnet MEV data: relay payload share, builder block counts and
// measured builder profit, and per-day aggregates.
//
// Endpoint reality, probed live 2026-08-06:
//   GET /overview/json?t=24h            -> 200
//   GET /builder-profit/json?t=24h      -> 200
//   GET /stats/day/{YYYY-MM-DD}/json    -> 200   (there is NO /stats/day/json)
// Supported `t` windows mirror the site nav: 1h, 12h, 24h, 7d.

import { httpJson } from "../http.mjs";

export const RELAYSCAN_API = "https://relayscan.io";

const TIMESPANS = new Set(["1h", "12h", "24h", "7d"]);

function base(opts = {}) {
  return (opts.baseUrl || process.env.RELAYSCAN_API_URL || RELAYSCAN_API).replace(/\/$/, "");
}

function timespan(args = {}) {
  const t = String(args.timespan || args.t || "24h").toLowerCase();
  if (!TIMESPANS.has(t)) throw new Error(`relayscan-mev: timespan must be one of ${[...TIMESPANS].join(", ")}`);
  return t;
}

function isoDate(args = {}) {
  // Default to yesterday: today's bucket is incomplete until UTC midnight.
  const raw = args.date || args.day;
  if (raw == null) {
    const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }
  const text = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("relayscan-mev: date must be YYYY-MM-DD");
  return text;
}

/** Relay payload share over a window (which relays delivered blocks). */
export async function relayscanOverview(args = {}, opts = {}) {
  return httpJson(`${base(opts)}/overview/json?t=${timespan(args)}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
}

/** Per-builder block counts and measured profit (coinbase balance delta). */
export async function relayscanBuilderProfit(args = {}, opts = {}) {
  return httpJson(`${base(opts)}/builder-profit/json?t=${timespan(args)}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
}

/** One UTC day of relay + builder aggregates. */
export async function relayscanDailyStats(args = {}, opts = {}) {
  const date = isoDate(args);
  return httpJson(`${base(opts)}/stats/day/${date}/json`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 25_000,
  });
}

export async function relayscanHealth(opts = {}) {
  const data = await relayscanOverview({ timespan: "1h" }, opts);
  return {
    ok: Array.isArray(data?.relays) && data.relays.length > 0,
    provider: "relayscan-mev",
    relays: Array.isArray(data?.relays) ? data.relays.length : 0,
  };
}
