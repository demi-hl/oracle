// Public API for cross-chain on-chain equities best execution.
// Prepare-only. Fixtures-backed offline by default; live probes are separate.

import { parseDecimal } from './num.mjs';
import { rank as rankQuotes } from './rank.mjs';
import { prepare as prepareRh } from './prepare.mjs';
import { filterQuotes } from './liveness.mjs';
import { quoteAll as hip3All, quote as hip3Quote, listDexs } from './venues/hyperliquid-hip3.mjs';
import { quoteAll as spotAll } from './venues/arcus-spot.mjs';
import { quoteAll as perpAll } from './venues/arcus-perp.mjs';
import { quoteAll as rhAll, quote as rhQuote, listPools } from './venues/rh-uniswap.mjs';
import { quoteAll as solAll, quote as solQuote, listTokens as solTokens } from './venues/solana-xstocks.mjs';
import { quoteAll as tonAll, quote as tonQuote, listTokens as tonTokens } from './venues/ton-stonfi.mjs';
import { getVenues } from './fixtures.mjs';

export { rank as rankEquityQuotes } from './rank.mjs';
export { prepare as prepareEquity } from './prepare.mjs';
export { validateQuote, validateRankResult } from './types.mjs';
export { loadFixtures, getVenues, getUniverse } from './fixtures.mjs';

function sizeArg(sizeUsd) {
  if (sizeUsd == null || sizeUsd === '') return null;
  if (typeof sizeUsd === 'object' && sizeUsd && typeof sizeUsd.mantissa === 'bigint') return sizeUsd;
  return parseDecimal(String(sizeUsd));
}

/**
 * Collect fixture-backed quotes for one equity ticker across all venues.
 */
export function collectEquityQuotes(ticker, { sizeUsd = null } = {}) {
  if (typeof ticker !== 'string' || !ticker.trim()) {
    throw new TypeError('ticker is required');
  }
  const t = ticker.trim().toUpperCase();
  const size = sizeArg(sizeUsd);
  const out = [];

  const xyz = hip3Quote({ symbol: `xyz:${t}`, sizeUsd: size });
  if (xyz) out.push(xyz);
  else {
    for (const q of hip3All({ ticker: t, sizeUsd: size })) out.push(q);
  }
  for (const q of perpAll({ sizeUsd: size })) if (q.symbol === t) out.push(q);
  for (const q of spotAll({ sizeUsd: size })) if (q.symbol === t) out.push(q);
  const rh = rhQuote({ symbol: t, sizeUsd: size });
  if (rh) out.push(rh);
  const sol = solQuote({ symbol: t, sizeUsd: size });
  if (sol) out.push(sol);
  const ton = tonQuote({ symbol: t, sizeUsd: size });
  if (ton) out.push(ton);
  return out;
}

/**
 * Rank equities venues for a ticker. Offline/fixtures by default.
 *
 * @param {object} p
 * @param {string} p.ticker  e.g. NVDA, SPY, TSLA
 * @param {string|number} [p.sizeUsd]
 * @param {number} [p.horizonHours]  funding-adjusted heterogeneous ranking
 */
export function bestEquityRoute(p = {}) {
  const ticker = String(p.ticker || p.symbol || '').trim().toUpperCase();
  if (!ticker) throw new Error('bestEquityRoute requires ticker');
  const sizeUsd = sizeArg(p.sizeUsd ?? p.size ?? null);
  const quotes = collectEquityQuotes(ticker, { sizeUsd });
  if (quotes.length === 0) {
    return {
      ticker,
      rankedOn: 'gross',
      ranked: [],
      winner: null,
      runnersUp: [],
      improvementBps: null,
      sourcesAnswered: 0,
      sourcesTried: 0,
      failed: [],
      excluded: [],
      bestPreparable: null,
      instrumentMix: 'homogeneous',
      note: 'no venue answered for this ticker in the pinned fixture capture',
    };
  }
  // Offline fixtures use their own capturedAt. Advance 1s so freshness passes.
  const nowMs = p.nowMs ?? (quotes[0].capturedAt + 1000);
  const result = rankQuotes(quotes, {
    nowMs,
    horizonHours: p.horizonHours != null ? Number(p.horizonHours) : undefined,
    skipLiveness: p.skipLiveness === true,
  });
  return { ticker, ...result };
}

/**
 * Inventory + liveness snapshot for equities venues (fixtures).
 */
export function equityVenues() {
  const inventory = [
    { venue: 'hyperliquid_hip3', tier: 'quote-only', chain: 'hyperliquid', n: hip3All().length },
    { venue: 'arcus_perp', tier: 'quote-only', chain: 'robinhood-4663', n: perpAll().length },
    { venue: 'arcus_spot', tier: 'quote-only', chain: 'robinhood-4663', n: spotAll().length },
    { venue: 'rh_uniswap', tier: 'prepare', chain: 4663, n: listPools().length },
    { venue: 'solana_xstocks', tier: 'quote-only', chain: 'solana', n: solTokens().length },
    { venue: 'ton_stonfi', tier: 'quote-only', chain: 'ton', n: tonTokens().length },
  ];
  const all = [...hip3All(), ...perpAll(), ...spotAll(), ...rhAll(), ...solAll(), ...tonAll()];
  const nowMs = (all[0]?.capturedAt ?? Date.now()) + 1000;
  const { survivors, excluded } = filterQuotes(all, { nowMs });
  return {
    inventory,
    hip3Dexs: listDexs(),
    liveness: {
      survivors: survivors.length,
      excluded: excluded.length,
      byReason: excluded.reduce((acc, e) => {
        acc[e.reason] = (acc[e.reason] ?? 0) + 1;
        return acc;
      }, {}),
    },
    capturedAt: getVenues().capturedAt,
    custody: 'prepare-only',
    note: 'quote-only venues are ranked for discovery; only rh_uniswap is preparable in v1',
  };
}

/**
 * Prepare unsigned RH Uniswap artifact for an equity ticker.
 * Requires a real recipient wallet. Never signs.
 */
export function prepareEquityRoute(p = {}) {
  const ticker = String(p.ticker || p.symbol || '').trim().toUpperCase();
  const recipient = p.recipient || p.taker;
  if (!ticker) throw new Error('prepareEquityRoute requires ticker');
  if (!recipient) throw new Error('prepareEquityRoute requires recipient (signing wallet)');
  const sizeUsd = sizeArg(p.sizeUsd ?? p.size ?? null);
  const q = rhQuote({ symbol: ticker, sizeUsd });
  if (!q) {
    return {
      ok: false,
      failureKind: 'no-prepare-path',
      ticker,
      note: 'no RH Uniswap prepare-tier route for this ticker in fixtures',
    };
  }
  try {
    const artifact = prepareRh({
      symbol: ticker,
      sizeUsd,
      recipient,
      nowMs: p.nowMs ?? q.capturedAt + 1000,
    });
    return { ok: true, ticker, artifact, bestPreparableVenue: 'rh_uniswap' };
  } catch (err) {
    return {
      ok: false,
      failureKind: 'prepare-refused',
      ticker,
      error: String(err.message || err),
    };
  }
}

/** JSON-safe clone (bigint -> string). */
export function toJsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
