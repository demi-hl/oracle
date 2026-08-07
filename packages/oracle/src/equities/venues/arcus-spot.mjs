// Arcus spot pairs on Robinhood Chain 4663.
// Tier: quote-only. CRITICAL: bid and ask are passed through UNTOUCHED, including
// crossed books where bid > ask. Repairing a crossed book here would hide a real
// data integrity failure from liveness.mjs and let a garbage mid rank as real.
//
// Fees are explicitly zero in the fixture capture. A known zero is a fixed point
// zero with costAccounted true for the fee component alone. Gas and impact are
// still unknown, so the overall costAccounted claim stays false.

import { getVenues } from '../fixtures.mjs';
import { fromSourceNumber, requireSourceNumber } from '../sourceNum.mjs';
import { parseDecimal } from '../num.mjs';
import { validateQuote } from '../types.mjs';

export const VENUE = 'arcus_spot';
export const CHAIN = 'robinhood-4663';
export const TIER = 'quote-only';

function spot() {
  return getVenues().venues.arcus_spot;
}

export function listPairs() {
  return Object.keys(spot().pairs).sort();
}

export function quote({ symbol, side = 'buy', sizeUsd = null } = {}) {
  if (typeof symbol !== 'string' || symbol.length === 0) return null;
  const pair = spot().pairs[symbol];
  if (!pair) return null;

  // Pass bid and ask through exactly as captured. Do not swap, average, or clamp.
  const bid = pair.bid === undefined || pair.bid === null ? null : requireSourceNumber(pair.bid, `${symbol}.bid`);
  const ask = pair.ask === undefined || pair.ask === null ? null : requireSourceNumber(pair.ask, `${symbol}.ask`);
  const last = fromSourceNumber(pair.last);

  // Mid is only computed when both sides exist. A crossed book still gets a mid
  // (the arithmetic average of the bad numbers) because mid is evidence, not a
  // filter. Liveness will exclude the whole quote for crossed-book.
  let mid = null;
  if (bid !== null && ask !== null) {
    mid = {
      mantissa: bid.mantissa + ask.mantissa,
      scale: bid.scale === ask.scale ? bid.scale + 1 : Math.max(bid.scale, ask.scale) + 1,
    };
    // Align to a common scale before averaging.
    const scale = Math.max(bid.scale, ask.scale);
    const b = bid.scale === scale ? bid.mantissa : bid.mantissa * 10n ** BigInt(scale - bid.scale);
    const a = ask.scale === scale ? ask.mantissa : ask.mantissa * 10n ** BigInt(scale - ask.scale);
    mid = { mantissa: b + a, scale: scale + 1 };
    // (b+a) at scale+1 is the average at scale, which is what we want.
    // Actually: average = (b+a)/2. With mantissa b+a and scale scale+1 that is
    // (b+a) * 10^-(scale+1) = ((b+a)/10) * 10^-scale, not /2.
    // Correct: mid = (b+a) / 2 at the same scale.
    mid = { mantissa: (b + a) / 2n, scale };
  } else if (last !== null) {
    mid = last;
  }

  if (bid === null && ask === null && mid === null) return null;

  const requested = sizeUsd === null ? parseDecimal('0') : sizeUsd;
  // Explicit zero fee. Known measured zero, not unknown.
  const fees = parseDecimal('0');

  const q = {
    venue: VENUE,
    chain: CHAIN,
    instrument: 'spot',
    tier: TIER,
    symbolRaw: symbol,
    symbol,
    side,
    requestedSize: requested,
    fees,
    gasEstimate: null,
    priceImpact: null,
    fundingHourly: null,
    // Fees known as zero, but gas and impact unknown, so overall claim is false.
    costAccounted: false,
    capturedAt: getVenues().capturedAt * 1000,
    blockOrSeq: null,
    raw: {
      fixture: 'fixtures/venues.json#venues.arcus_spot',
      last: pair.last,
      bid: pair.bid,
      ask: pair.ask,
      vol24h: pair.vol24h,
      feeKnownZero: true,
      reasonCostUnknown: 'gas and impact at size not captured; fee is a known zero',
    },
  };

  if (bid !== null) q.bid = bid;
  if (ask !== null) q.ask = ask;
  if (mid !== null) q.mid = mid;

  return validateQuote(q);
}

export function quoteAll({ side = 'buy', sizeUsd = null } = {}) {
  return listPairs()
    .map((symbol) => quote({ symbol, side, sizeUsd }))
    .filter((q) => q !== null);
}
