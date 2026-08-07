// Hyperliquid HIP-3 builder-deployed equity perp adapter.
// Tier: quote-only. Adapters report source truth including dormant dexs and
// markets with zero volume. Exclusion of those is liveness.mjs, not this file.
//
// Fixture shape (venues.hyperliquid_hip3.dexs):
//   { abcd: { USA500: { mark, vol24h, oi, fundingHourly, fundingAnnPct, maxLev } }, ... }
// Symbols are namespaced as dex:TICKER so xyz:NVDA never collides with a cash:NVDA
// if one ever appears.
//
// When fixtures/hip3_l2books.json has a book for the coin, size impact is walked
// from the book (measured). Fees and gas are still unknown, so overall
// costAccounted stays false, but priceImpact is no longer null.

import { getHip3L2Books, getVenues } from '../fixtures.mjs';
import { fromSourceNumber, requireSourceNumber } from '../sourceNum.mjs';
import { div, mul, parseDecimal, sub, toString } from '../num.mjs';
import { validateQuote } from '../types.mjs';

export const VENUE = 'hyperliquid_hip3';
export const CHAIN = 'hyperliquid';
export const TIER = 'quote-only';

function hip3() {
  return getVenues().venues.hyperliquid_hip3;
}

export function listDexs() {
  return Object.keys(hip3().dexs).sort();
}

export function listMarkets() {
  const out = [];
  for (const [dex, markets] of Object.entries(hip3().dexs)) {
    for (const ticker of Object.keys(markets)) {
      out.push(`${dex}:${ticker}`);
    }
  }
  return out.sort();
}

export function findMarkets(symbol) {
  if (typeof symbol !== 'string' || symbol.length === 0) return [];
  const colon = symbol.indexOf(':');
  if (colon > 0) {
    const dex = symbol.slice(0, colon);
    const ticker = symbol.slice(colon + 1);
    const market = hip3().dexs[dex]?.[ticker];
    if (!market) return [];
    return [{ dex, ticker, market }];
  }
  const hits = [];
  for (const [dex, markets] of Object.entries(hip3().dexs)) {
    if (Object.hasOwn(markets, symbol)) {
      hits.push({ dex, ticker: symbol, market: markets[symbol] });
    }
  }
  return hits;
}

function bookFor(dex, ticker) {
  try {
    const books = getHip3L2Books().books;
    return books[`${dex}:${ticker}`] ?? null;
  } catch {
    return null;
  }
}

// Walk the ask (buy) or bid (sell) side until notional is filled. Returns
// { vwap, filledUsd, unfilledUsd, levelsUsed } or null if no book.
function walkBook(book, side, sizeUsd) {
  if (!book || sizeUsd === null || sizeUsd.mantissa <= 0n) return null;
  const levels = side === 'buy' ? book.asks : book.bids;
  if (!levels || levels.length === 0) return null;

  let remaining = Number(toString(sizeUsd));
  if (!Number.isFinite(remaining) || remaining <= 0) return null;

  let spent = 0;
  let qty = 0;
  let levelsUsed = 0;
  for (const lvl of levels) {
    const px = Number(lvl.px);
    const sz = Number(lvl.sz);
    if (!(px > 0) || !(sz > 0)) continue;
    const levelNotional = px * sz;
    const take = Math.min(remaining, levelNotional);
    const takeQty = take / px;
    spent += take;
    qty += takeQty;
    remaining -= take;
    levelsUsed += 1;
    if (remaining <= 1e-9) break;
  }
  if (qty <= 0) return null;
  return {
    vwap: spent / qty,
    filledUsd: spent,
    unfilledUsd: Math.max(0, remaining),
    levelsUsed,
  };
}

function impactFromBook(book, side, sizeUsd, mark) {
  const walk = walkBook(book, side, sizeUsd);
  if (!walk) return { impact: null, depth: null };
  const markN = Number(toString(mark));
  if (!(markN > 0)) return { impact: null, depth: walk };
  // Buy impact = (vwap - mark) / mark ; sell impact = (mark - vwap) / mark
  const raw = side === 'buy' ? (walk.vwap - markN) / markN : (markN - walk.vwap) / markN;
  const clamped = Math.max(0, raw);
  // Encode as fixed point via decimal string (source number path).
  const impact = fromSourceNumber(Number(clamped.toPrecision(12)));
  return {
    impact,
    depth: {
      ...walk,
      impactFraction: clamped,
      fullyFilled: walk.unfilledUsd <= 1e-6,
    },
  };
}

function emitQuote({ dex, ticker, market, side, size }) {
  const mark = requireSourceNumber(market.mark, `${dex}:${ticker}.mark`);
  const funding = fromSourceNumber(market.fundingHourly);
  const vol24h = fromSourceNumber(market.vol24h);
  const oi = fromSourceNumber(market.oi);
  const requested = size === null ? parseDecimal('0') : size;

  const book = bookFor(dex, ticker);
  let priceImpact = null;
  let depthMeta = null;
  let reasonCostUnknown = 'fees and gas not captured';

  if (requested.mantissa > 0n) {
    if (book) {
      const walked = impactFromBook(book, side, requested, mark);
      priceImpact = walked.impact;
      depthMeta = walked.depth;
      if (!depthMeta?.fullyFilled) {
        reasonCostUnknown =
          'book walked but size exceeds visible depth; fees and gas not captured';
      } else {
        reasonCostUnknown =
          'impact measured from l2Book; fees and gas still not captured';
      }
    } else {
      reasonCostUnknown = 'no order book depth wired for this coin; fees and gas not captured';
    }
  } else if (!book) {
    reasonCostUnknown = 'no order book depth wired for this coin; fees and gas not captured';
  } else {
    reasonCostUnknown = 'zero size; fees and gas not captured';
  }

  // Fees and gas unknown always => costAccounted false. Depth only fills priceImpact.
  const costAccounted = false;

  const q = {
    venue: VENUE,
    chain: CHAIN,
    instrument: 'perp',
    tier: TIER,
    symbolRaw: `${dex}:${ticker}`,
    symbol: ticker,
    side,
    requestedSize: requested,
    mark,
    fees: null,
    gasEstimate: null,
    priceImpact,
    fundingHourly: funding,
    costAccounted,
    capturedAt: getVenues().capturedAt * 1000,
    blockOrSeq: null,
    raw: {
      fixture: 'fixtures/venues.json#venues.hyperliquid_hip3',
      dex,
      ticker,
      vol24h: market.vol24h,
      oi: market.oi,
      fundingAnnPct: market.fundingAnnPct,
      maxLev: market.maxLev,
      reasonCostUnknown,
      hasL2Book: book !== null,
      l2BookFixture: book ? 'fixtures/hip3_l2books.json' : null,
      depth: depthMeta,
    },
  };

  if (vol24h !== null) q.raw.vol24hFixed = vol24h;
  if (oi !== null) q.raw.oiFixed = oi;

  // Attach top of book when present as evidence, not as repaired mid.
  if (book?.bids?.[0] && book?.asks?.[0]) {
    q.bid = parseDecimal(String(book.bids[0].px));
    q.ask = parseDecimal(String(book.asks[0].px));
  }

  return validateQuote(q);
}

export function quote({ symbol, side = 'buy', sizeUsd = null } = {}) {
  const hits = findMarkets(symbol);
  if (hits.length === 0) return null;
  if (hits.length > 1) return null;
  return emitQuote({ ...hits[0], side, size: sizeUsd });
}

export function quoteAll({ side = 'buy', sizeUsd = null, ticker = null } = {}) {
  const out = [];
  for (const namespaced of listMarkets()) {
    const [dex, t] = namespaced.split(':');
    if (ticker !== null && t !== ticker) continue;
    const market = hip3().dexs[dex][t];
    out.push(emitQuote({ dex, ticker: t, market, side, size: sizeUsd }));
  }
  return out;
}

export function quoteCore(/* ignored */) {
  return [];
}
