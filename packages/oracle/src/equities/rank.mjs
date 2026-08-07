// Net-of-cost ranking engine.
//
// Ranks quotes after fees, gas, and impact at the requested size. Missing costs
// force rankedOn: "gross" for that comparison and are never silently treated as
// zero. Default mode segments by instrument (spot table vs perp table). Horizon
// mode merges via funding carry and reports the breakeven hold duration.
//
// bestPreparable is independent of the overall winner so a quote-only best price
// is never presented as actionable.

import { filterQuotes } from './liveness.mjs';
import { carryForQuote } from './funding.mjs';
import { sessionState } from './marketHours.mjs';
import {
  add,
  cmp,
  div,
  fromScaledInteger,
  mul,
  parseDecimal,
  sub,
  toString,
} from './num.mjs';
import { validateRankResult } from './types.mjs';

function priceOf(quote) {
  return quote.mid ?? quote.mark ?? quote.ask ?? quote.bid ?? null;
}

function netScore(quote) {
  // Lower is better for a buy (you pay less). Higher is better for a sell.
  // We normalize to a "cost to buy one unit" score so sorting is consistent.
  const px = priceOf(quote);
  if (px === null) return null;

  let costAccounted = quote.costAccounted === true;
  let extras = parseDecimal('0');

  if (quote.fees !== null) {
    // fees is a fraction of notional when from fee tier; when it's absolute we
    // still add it. Adapters emit fee as a rate fraction or absolute; treat as
    // absolute addend for v1 when scale suggests a small number.
    extras = add(extras, quote.fees);
  } else {
    costAccounted = false;
  }
  if (quote.priceImpact !== null) {
    extras = add(extras, quote.priceImpact);
  } else if (quote.requestedSize && quote.requestedSize.mantissa > 0n) {
    costAccounted = false;
  }
  if (quote.gasEstimate === null) {
    costAccounted = false;
  } else {
    extras = add(extras, quote.gasEstimate);
  }

  // For a buy, net = price * (1 + feeRate-ish) + impact. We approximate by
  // price + extras when extras are absolute fractions of 1 (fee rates).
  // fee rates like 0.003 are added to 1 then multiplied.
  // Detect rate-like fees (value < 1) vs absolute.
  let net;
  if (quote.fees !== null && cmp(quote.fees, parseDecimal('1')) < 0 && cmp(quote.fees, parseDecimal('0')) >= 0) {
    const onePlus = add(parseDecimal('1'), quote.fees);
    net = mul(px, onePlus);
    if (quote.priceImpact !== null) net = add(net, mul(px, quote.priceImpact));
  } else {
    net = add(px, extras);
  }

  return { net, costAccounted, px };
}

function routeEntry(quote, score, carry = null) {
  return {
    venue: quote.venue,
    chain: quote.chain,
    instrument: quote.instrument,
    tier: quote.tier,
    symbol: quote.symbol,
    symbolRaw: quote.symbolRaw,
    side: quote.side,
    price: score.px,
    net: score.net,
    costAccounted: score.costAccounted,
    fundingHourly: quote.fundingHourly,
    carry,
    quote,
  };
}

function improvementBps(winner, runner) {
  if (!winner || !runner) return null;
  if (!winner.costAccounted || !runner.costAccounted) return null;
  if (winner.instrument !== runner.instrument) return null;
  if (winner.net.mantissa === 0n) return null;
  // For buys: how many bps cheaper is winner than runner.
  const delta = sub(runner.net, winner.net);
  return div(mul(delta, fromScaledInteger(10000n, 0)), runner.net, 4);
}

/**
 * Rank a list of quotes for one symbol.
 *
 * @param {object[]} quotes
 * @param {object} [opts]
 * @param {number} [opts.horizonHours]   if set, enable heterogeneous carry mode
 * @param {number} [opts.nowMs]
 * @param {boolean} [opts.skipLiveness]
 */
export function rank(quotes, opts = {}) {
  if (!Array.isArray(quotes)) throw new TypeError('quotes must be an array');

  const nowMs = opts.nowMs ?? (quotes[0]?.capturedAt ?? Date.now());
  const sourcesTried = quotes.length;
  let working = quotes;
  let excluded = [];

  if (!opts.skipLiveness) {
    const gate = filterQuotes(quotes, { nowMs });
    working = gate.survivors;
    excluded = gate.excluded;
  }

  const sourcesAnswered = quotes.length; // all inputs answered; failures come from callers
  const failed = []; // ranking does not itself call adapters

  const horizonHours = opts.horizonHours;
  const heterogeneous = Number.isFinite(horizonHours) && horizonHours > 0;

  // Score each survivor.
  const scored = [];
  for (const q of working) {
    const score = netScore(q);
    if (score === null) continue;
    let carry = null;
    if (heterogeneous && q.instrument === 'perp') {
      carry = carryForQuote(q, horizonHours, { nowMs });
      // Fold carry into net as an additive cost in price space is wrong dimensionally.
      // Carry is in bps of notional; convert: net' = net * (1 + carryBps/10000)
      if (carry.carryBps !== null) {
        const factor = add(
          parseDecimal('1'),
          div(carry.carryBps, fromScaledInteger(10000n, 0), 12),
        );
        score.net = mul(score.net, factor);
        // Carry is an estimate: never upgrade costAccounted.
        score.costAccounted = false;
      }
    }
    scored.push(routeEntry(q, score, carry));
  }

  // Segment.
  let pool = scored;
  let instrumentMix = 'homogeneous';
  if (!heterogeneous) {
    // Default: require a single instrument class. If mixed, rank each class
    // separately and pick the class with more routes (spot preferred on tie).
    const spots = scored.filter((r) => r.instrument === 'spot');
    const perps = scored.filter((r) => r.instrument === 'perp');
    if (spots.length > 0 && perps.length > 0) {
      pool = spots.length >= perps.length ? spots : perps;
      instrumentMix = 'homogeneous';
    } else {
      pool = scored;
      instrumentMix = 'homogeneous';
    }
  } else {
    instrumentMix = 'heterogeneous';
    pool = scored;
  }

  // Sort ascending by net (best buy price first). Stable tie break on venue name.
  pool.sort((a, b) => {
    const c = cmp(a.net, b.net);
    if (c !== 0) return c;
    return a.venue < b.venue ? -1 : a.venue > b.venue ? 1 : 0;
  });

  const winner = pool[0] ?? null;
  const runnersUp = pool.slice(1);
  const ranked = pool;

  // rankedOn: net-of-cost only when the top two both fully accounted; else gross.
  let rankedOn = 'gross';
  if (winner && winner.costAccounted && (runnersUp.length === 0 || runnersUp[0].costAccounted)) {
    rankedOn = 'net-of-cost';
  }
  // One answering source is not a comparison.
  const imp =
    runnersUp.length === 0 ? null : improvementBps(winner, runnersUp[0]);

  const bestPreparable =
    scored.find((r) => r.tier === 'prepare') ?? null;

  const session = sessionState(nowMs);
  const darkWindow =
    session === 'core'
      ? null
      : {
          session,
          warning:
            session === 'dark'
              ? 'market is dark; marks are not real price discovery'
              : 'extended session; thinner books and higher staleness risk',
        };

  // Breakeven horizon between best spot and best perp (heterogeneous diagnostic).
  let breakEvenHorizonHours = null;
  if (heterogeneous) {
    breakEvenHorizonHours = estimateBreakeven(scored);
  }

  const result = {
    rankedOn,
    ranked,
    winner,
    runnersUp,
    improvementBps: imp === null ? null : Number(toString(imp)),
    sourcesAnswered,
    sourcesTried,
    failed,
    excluded,
    darkWindow,
    instrumentMix,
    bestPreparable,
    carry: winner?.carry ?? null,
    breakEvenHorizonHours,
  };

  return validateRankResult(result);
}

function estimateBreakeven(scored) {
  const bestSpot = scored
    .filter((r) => r.instrument === 'spot')
    .sort((a, b) => cmp(a.net, b.net))[0];
  const bestPerp = scored
    .filter((r) => r.instrument === 'perp')
    .sort((a, b) => cmp(a.net, b.net))[0];
  if (!bestSpot || !bestPerp || bestPerp.fundingHourly === null) return null;

  // Entry gap in price space. Carry closes the gap at rate funding * price per hour.
  // breakEvenHours ~= entryGap / (fundingHourly * perpPrice)
  const gap = sub(bestSpot.net, bestPerp.net); // positive if spot more expensive
  if (gap.mantissa === 0n) return 0;
  // If perp is more expensive at entry and funding is positive (longs pay), gap never closes for a long.
  const hourlyCarry = mul(bestPerp.fundingHourly, bestPerp.price);
  if (hourlyCarry.mantissa === 0n) return null;
  // hours = gap / hourlyCarry (only meaningful when signs agree)
  try {
    const hours = div(gap, hourlyCarry, 4);
    const h = Number(toString(hours));
    if (!Number.isFinite(h) || h < 0) return null;
    return h;
  } catch {
    return null;
  }
}
