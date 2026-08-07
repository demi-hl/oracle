// Hyperliquid market datapoints for the Hyperliquid agent.
//
// The raw /info endpoints return parallel arrays and stringly-typed numbers
// that every consumer ends up re-deriving: universe[i] pairs with assetCtxs[i],
// funding is an 8-hour decimal that people want annualized, open interest is
// denominated in the coin rather than USD. Doing that join once, here, keeps
// every chart and card consistent instead of each one inventing its own math.
//
// Reads only. No keys, no signing.

import { hlMetaAndAssetCtxs, hlAllMids, hlCandleSnapshot, hlL2Book, hlSpotMeta } from "./hl-info.mjs";

/** Liveness: the media lane is healthy when the underlying info plane answers. */
export async function hlMarketsHealth(opts = {}) {
  const t0 = Date.now();
  try {
    const mids = await hlAllMids(opts);
    return {
      provider: "hl-markets",
      ok: true,
      venue: "hyperliquid",
      symbols: Object.keys(mids || {}).length,
      latencyMs: Date.now() - t0,
    };
  } catch (e) {
    return { provider: "hl-markets", ok: false, error: String(e?.message || e), latencyMs: Date.now() - t0 };
  }
}

const HOURS_PER_YEAR = 24 * 365;
const FUNDING_INTERVAL_HOURS = 8;

function num(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pct(a, b) {
  if (a == null || b == null || b === 0) return null;
  return ((a - b) / b) * 100;
}

/**
 * Join the perp universe with its asset contexts into one flat row per market.
 *
 * This is THE datapoint set for an Hyperliquid agent board: price, 24h change, volume,
 * open interest in both coin and USD, funding (interval + annualized), and the
 * leverage/decimals metadata needed to render or size an order.
 */
export async function hlMarketDatapoints(args = {}, opts = {}) {
  const [meta, mids] = await Promise.all([
    hlMetaAndAssetCtxs(opts),
    hlAllMids(opts).catch(() => ({})),
  ]);

  // metaAndAssetCtxs returns [ { universe: [...] }, [ ctx, ... ] ]
  const universe = meta?.[0]?.universe ?? meta?.universe ?? [];
  const ctxs = Array.isArray(meta?.[1]) ? meta[1] : [];

  const rows = universe.map((asset, i) => {
    const ctx = ctxs[i] || {};
    const mark = num(ctx.markPx);
    const prev = num(ctx.prevDayPx);
    const oiCoin = num(ctx.openInterest);
    const funding = num(ctx.funding);

    return {
      coin: asset.name,
      index: i,
      markPx: mark,
      oraclePx: num(ctx.oraclePx),
      midPx: num(ctx.midPx) ?? num(mids?.[asset.name]),
      prevDayPx: prev,
      change24hPct: pct(mark, prev),
      dayNtlVolumeUsd: num(ctx.dayNtlVlm),
      premium: num(ctx.premium),
      // funding is the per-8h rate as a decimal; both forms are useful and
      // people get the conversion wrong constantly.
      fundingRate: funding,
      fundingRateAprPct: funding == null ? null : funding * (HOURS_PER_YEAR / FUNDING_INTERVAL_HOURS) * 100,
      openInterestCoin: oiCoin,
      openInterestUsd: oiCoin == null || mark == null ? null : oiCoin * mark,
      maxLeverage: asset.maxLeverage ?? null,
      szDecimals: asset.szDecimals ?? null,
      isDelisted: Boolean(asset.isDelisted),
    };
  });

  const live = rows.filter((r) => !r.isDelisted);
  return {
    provider: "hl-info",
    venue: "hyperliquid",
    kind: "market-datapoints",
    asOfMs: Date.now(),
    count: live.length,
    markets: live,
    totals: {
      openInterestUsd: live.reduce((a, r) => a + (r.openInterestUsd || 0), 0),
      dayNtlVolumeUsd: live.reduce((a, r) => a + (r.dayNtlVolumeUsd || 0), 0),
    },
  };
}

/** Top movers / volume / OI / funding leaders — the standard board cuts. */
export async function hlLeaderboards(args = {}, opts = {}) {
  const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
  const { markets, asOfMs, totals } = await hlMarketDatapoints(args, opts);

  const by = (key, dir = -1) =>
    markets
      .filter((m) => m[key] != null)
      .sort((a, b) => (a[key] - b[key]) * dir)
      .slice(0, limit);

  return {
    provider: "hl-info",
    venue: "hyperliquid",
    kind: "leaderboards",
    asOfMs,
    totals,
    gainers: by("change24hPct"),
    losers: by("change24hPct", 1),
    byVolume: by("dayNtlVolumeUsd"),
    byOpenInterest: by("openInterestUsd"),
    fundingHighest: by("fundingRateAprPct"),
    fundingLowest: by("fundingRateAprPct", 1),
  };
}

/**
 * One coin, everything a segment or card needs: current state, the recent
 * candle series, and top-of-book depth.
 */
export async function hlCoinDatapoints(args = {}, opts = {}) {
  const coin = String(args.coin || args.symbol || "").trim().toUpperCase();
  if (!coin) throw new Error("hl-markets: coin required");
  const interval = String(args.interval || "1h");
  const lookbackMs = Number(args.lookbackMs) || 24 * 60 * 60 * 1000;
  const endTime = Date.now();
  const startTime = endTime - lookbackMs;

  const [board, candles, book] = await Promise.all([
    hlMarketDatapoints({}, opts),
    hlCandleSnapshot({ coin, interval, startTime, endTime }, opts).catch(() => []),
    // hlL2Book takes a bare coin string, not an args object.
    hlL2Book(coin, opts).catch(() => null),
  ]);

  const market = board.markets.find((m) => m.coin === coin) || null;
  if (!market) throw new Error(`hl-markets: ${coin} is not a listed perp`);

  const series = (Array.isArray(candles) ? candles : []).map((c) => ({
    t: Number(c.t),
    open: num(c.o),
    high: num(c.h),
    low: num(c.l),
    close: num(c.c),
    volume: num(c.v),
  }));

  const levels = book?.levels ?? [];
  const bestBid = num(levels?.[0]?.[0]?.px);
  const bestAsk = num(levels?.[1]?.[0]?.px);

  return {
    provider: "hl-info",
    venue: "hyperliquid",
    kind: "coin-datapoints",
    asOfMs: Date.now(),
    coin,
    market,
    book: {
      bestBid,
      bestAsk,
      spread: bestBid == null || bestAsk == null ? null : bestAsk - bestBid,
      spreadBps: bestBid == null || bestAsk == null || bestAsk === 0 ? null : ((bestAsk - bestBid) / bestAsk) * 10_000,
    },
    candles: { interval, count: series.length, series },
  };
}

/** Spot pairs, joined the same way. */
export async function hlSpotDatapoints(args = {}, opts = {}) {
  const spot = await hlSpotMeta(opts);
  const tokens = spot?.tokens ?? [];
  const pairs = spot?.universe ?? [];
  return {
    provider: "hl-info",
    venue: "hyperliquid",
    kind: "spot-datapoints",
    asOfMs: Date.now(),
    tokenCount: tokens.length,
    pairCount: pairs.length,
    tokens: tokens.map((t) => ({
      name: t.name,
      index: t.index,
      szDecimals: t.szDecimals ?? null,
      weiDecimals: t.weiDecimals ?? null,
      tokenId: t.tokenId ?? null,
      isCanonical: Boolean(t.isCanonical),
    })),
    pairs: pairs.map((p) => ({
      name: p.name,
      index: p.index,
      tokens: p.tokens,
      isCanonical: Boolean(p.isCanonical),
    })),
  };
}
