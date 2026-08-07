// Bisq — non-KYC peer-to-peer BTC market data (markets.bisq.network) — keyless.
//
// Why this matters as a distinct price source: every other venue Oracle reads
// is a KYC'd exchange or an on-chain DEX. Bisq is neither — it is decentralized
// P2P trading settled by bank transfer and similar rails, so its print carries
// a non-KYC premium/discount relative to centralized spot. That basis is the
// signal; the absolute price is not meant to be a reference rate.
//
// Verified live:
//   GET /api/markets                  200  map keyed by pair (bsq_btc, btc_usd…)
//   GET /api/ticker?market=btc_usd    200  { last, high, low, volume_left, … }
//   GET /api/trades?market=btc_usd    200  array, newest first
//
// LIQUIDITY CAVEAT: Bisq volume is thin and trades are sparse. A single print
// can move `last` by percent, and the most recent trade may be hours or days
// old, so every response carries the trade timestamp/age for judgement.
//
// Read-only. Bisq trades are executed in the Bisq desktop client, not here.

import { httpJson } from "../http.mjs";

export const BISQ_MARKETS_API = "https://markets.bisq.network";

function baseUrl(opts = {}) {
  return String(opts.baseUrl || process.env.BISQ_MARKETS_URL || BISQ_MARKETS_API).replace(/\/$/, "");
}

/** Bisq pairs are lowercase `left_right`, e.g. btc_usd, bsq_btc, xmr_btc. */
export function bisqMarket(value, label = "market") {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[/\-\s]/g, "_");
  if (!/^[a-z0-9]{2,12}_[a-z0-9]{2,12}$/.test(text)) {
    throw new Error(`bisq-markets: ${label} must look like btc_usd (got "${value}")`);
  }
  return text;
}

function get(path, opts = {}) {
  return httpJson(`${baseUrl(opts)}${path.startsWith("/") ? path : `/${path}`}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
}

export async function bisqHealth(opts = {}) {
  try {
    const markets = await get("/api/markets", opts);
    const count = markets && typeof markets === "object" ? Object.keys(markets).length : 0;
    return {
      ok: count > 0,
      provider: "bisq-markets",
      baseUrl: baseUrl(opts),
      marketCount: count,
      exec: false,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "bisq-markets",
      baseUrl: baseUrl(opts),
      error: String(error?.message || error),
      exec: false,
    };
  }
}

/** Tradable pairs. Optional `quote`/`base` filter, e.g. quote: "btc". */
export async function bisqMarkets(args = {}, opts = {}) {
  const res = await get("/api/markets", opts);
  let rows = Object.values(res && typeof res === "object" ? res : {});
  if (args.base) {
    const b = String(args.base).trim().toLowerCase();
    rows = rows.filter((m) => String(m.lsymbol || "").toLowerCase() === b);
  }
  if (args.quote) {
    const q = String(args.quote).trim().toLowerCase();
    rows = rows.filter((m) => String(m.rsymbol || "").toLowerCase() === q);
  }
  return {
    provider: "bisq-markets",
    count: rows.length,
    markets: rows.map((m) => ({
      pair: m.pair ?? null,
      name: m.name ?? null,
      base: m.lsymbol ?? null,
      baseName: m.lname ?? null,
      quote: m.rsymbol ?? null,
      quoteName: m.rname ?? null,
      baseType: m.ltype ?? null,
      quoteType: m.rtype ?? null,
    })),
  };
}

/** Ticker for one pair. `buy`/`sell` are frequently null — Bisq offers are sparse. */
export async function bisqTicker(args = {}, opts = {}) {
  const market = bisqMarket(args.market || args.pair || "btc_usd", "market");
  const t = await get(`/api/ticker?market=${encodeURIComponent(market)}`, opts);
  const row = Array.isArray(t) ? t[0] || {} : t || {};
  return {
    provider: "bisq-markets",
    market,
    last: row.last == null ? null : Number(row.last),
    high: row.high == null ? null : Number(row.high),
    low: row.low == null ? null : Number(row.low),
    bid: row.buy == null ? null : Number(row.buy),
    ask: row.sell == null ? null : Number(row.sell),
    volumeBase: row.volume_left == null ? null : Number(row.volume_left),
    volumeQuote: row.volume_right == null ? null : Number(row.volume_right),
    note: "Bisq is thin, non-KYC P2P — treat as a basis signal against centralized spot, not a reference rate",
    raw: row,
  };
}

/** Recent trades, newest first. Reports the age of the latest print. */
export async function bisqTrades(args = {}, opts = {}) {
  const market = bisqMarket(args.market || args.pair || "btc_usd", "market");
  const limit = Math.min(2000, Math.max(1, Number(args.limit || 50)));
  const params = new URLSearchParams({ market, limit: String(limit) });
  if (args.timestampFrom) params.set("timestamp_from", String(args.timestampFrom));
  if (args.timestampTo) params.set("timestamp_to", String(args.timestampTo));
  const res = await get(`/api/trades?${params}`, opts);
  const rows = Array.isArray(res) ? res : [];
  // trade_date is epoch MILLISECONDS on this API.
  const latestMs = rows.length ? Number(rows[0].trade_date || 0) : null;
  const volumeBase = rows.reduce((n, r) => n + Number(r.amount || 0), 0);
  return {
    provider: "bisq-markets",
    market,
    count: rows.length,
    latestTradeAt: latestMs ? new Date(latestMs).toISOString() : null,
    latestTradeAgeHours: latestMs ? Math.round(((Date.now() - latestMs) / 3_600_000) * 10) / 10 : null,
    volumeBase,
    trades: rows.slice(0, limit).map((r) => ({
      price: r.price == null ? null : Number(r.price),
      amount: r.amount == null ? null : Number(r.amount),
      volume: r.volume == null ? null : Number(r.volume),
      paymentMethod: r.payment_method ?? null,
      tradeDate: r.trade_date ?? null,
      tradeAt: r.trade_date ? new Date(Number(r.trade_date)).toISOString() : null,
    })),
  };
}
