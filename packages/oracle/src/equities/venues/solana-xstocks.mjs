// Solana xStocks adapter (Backed / xStocks SPL tokens).
// Tier: quote-only. Source is DexScreener-shaped fixture data: priceUsd and
// liquidityUsd are third-party floats. Converting them to fixed point does NOT
// make them exact. Impact at size is a model estimate, so any non-trivial size
// forces costAccounted: false.
//
// symbolRaw keeps the x suffix (NVDAx). symbol is the canonical Oracle ticker
// (NVDA). normalize.mjs already understands the x-suffix rule.

import { getSolanaXstocks } from '../fixtures.mjs';
import { fromSourceNumber, requireSourceNumber } from '../sourceNum.mjs';
import { div, parseDecimal } from '../num.mjs';
import { validateQuote } from '../types.mjs';

export const VENUE = 'solana_xstocks';
export const CHAIN = 'solana';
export const TIER = 'quote-only';

// Below this USD liquidity, treat the market as too thin to rank at any size.
const THIN_LIQ_USD = 25_000;
// Size above this fraction of reported liq is never cost-accounted.
const IMPACT_SIZE_FRACTION = 0.02;

function data() {
  return getSolanaXstocks();
}

export function listTokens() {
  return Object.keys(data().tokens).sort();
}

function bestPair(symbol) {
  const pairs = data().pairs[symbol];
  if (!pairs || pairs.length === 0) return null;
  // Already sorted by liq desc at capture time; re-sort defensively.
  return [...pairs].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];
}

function modelImpact(liqUsd, sizeUsd) {
  if (liqUsd === null || sizeUsd === null) return null;
  if (liqUsd.mantissa <= 0n || sizeUsd.mantissa <= 0n) return parseDecimal('0');
  // Constant-product-ish: impact fraction ~= size / (liq + size)
  const scale = Math.max(liqUsd.scale, sizeUsd.scale);
  const l =
    liqUsd.scale === scale
      ? liqUsd.mantissa
      : liqUsd.mantissa * 10n ** BigInt(scale - liqUsd.scale);
  const s =
    sizeUsd.scale === scale
      ? sizeUsd.mantissa
      : sizeUsd.mantissa * 10n ** BigInt(scale - sizeUsd.scale);
  // (s / (l+s)) at scale+6 for a bit of room
  const num = s * 10n ** 6n;
  const den = l + s;
  return { mantissa: num / den, scale: 6 };
}

export function quote({ symbol, side = 'buy', sizeUsd = null } = {}) {
  if (typeof symbol !== 'string' || symbol.length === 0) return null;

  // Accept NVDAx or NVDA.
  let bare = symbol;
  let symbolRaw = symbol;
  const tokens = data().tokens;
  if (Object.hasOwn(tokens, symbol)) {
    bare = symbol;
    symbolRaw = tokens[symbol].symbolRaw;
  } else if (symbol.endsWith('x') || symbol.endsWith('X')) {
    const candidate = symbol.slice(0, -1).toUpperCase();
    if (Object.hasOwn(tokens, candidate)) {
      bare = candidate;
      symbolRaw = tokens[candidate].symbolRaw;
    } else {
      return null;
    }
  } else {
    return null;
  }

  const token = tokens[bare];
  const pair = bestPair(bare);
  if (!token || !pair) return null;

  const mid = requireSourceNumber(pair.priceUsd, `${bare}.priceUsd`);
  const liq = fromSourceNumber(pair.liquidityUsd);
  const requested = sizeUsd === null ? parseDecimal('0') : sizeUsd;

  const impact =
    requested.mantissa === 0n ? parseDecimal('0') : modelImpact(liq, requested);

  // DexScreener liq is approximate. Any real size is unaccounted for impact quality.
  let costAccounted = false;
  if (requested.mantissa === 0n && (pair.liquidityUsd ?? 0) >= THIN_LIQ_USD) {
    // Even at zero size we do not claim full cost accounting: fees and gas unknown.
    costAccounted = false;
  }

  const q = {
    venue: VENUE,
    chain: CHAIN,
    instrument: 'spot',
    tier: TIER,
    symbolRaw,
    symbol: bare,
    side,
    requestedSize: requested,
    mid,
    fees: null,
    gasEstimate: null,
    priceImpact: impact,
    fundingHourly: null,
    costAccounted,
    capturedAt: data().capturedAt * 1000,
    blockOrSeq: null,
    raw: {
      fixture: 'fixtures/solana_xstocks.json',
      mint: token.mint,
      pairAddress: pair.pairAddress,
      dexId: pair.dexId,
      quote: pair.quote,
      liquidityUsd: pair.liquidityUsd,
      volume24h: pair.volume24h,
      priceUsd: pair.priceUsd,
      source: 'dexscreener',
      approximate: true,
      reasonCostUnknown:
        'DexScreener liquidity.usd is a third-party float; fees and SOL gas not captured; impact is modeled',
      thin: (pair.liquidityUsd ?? 0) < THIN_LIQ_USD,
    },
  };

  return validateQuote(q);
}

export function quoteAll({ side = 'buy', sizeUsd = null } = {}) {
  return listTokens()
    .map((symbol) => quote({ symbol, side, sizeUsd }))
    .filter((q) => q !== null);
}
