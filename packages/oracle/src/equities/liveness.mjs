// Liveness gate. This is the data integrity layer that adapters deliberately
// do not implement. Adapters report source truth, including dormant venues and
// crossed books. This module decides what is trustworthy enough to rank.
//
// Three outcome buckets (never collapse them):
//   ranked-eligible quotes  -> survive
//   excluded[]              -> answered, but untrustworthy (dormant, crossed, stale)
//   failed[]                -> reserved for sources that did not answer (not used here)
//
// Every exclusion carries a machine readable reason and evidence.

import { cmp } from './num.mjs';
import { sessionState } from './marketHours.mjs';

export const REASONS = Object.freeze({
  DORMANT_VENUE: 'dormant-venue',
  CROSSED_BOOK: 'crossed-book',
  STALE_QUOTE: 'stale-quote',
  STALE_ORACLE: 'stale-oracle',
});

// Defaults. Live quotes older than this are excluded. Fixtures carry a pinned
// capturedAt so offline tests are deterministic against a frozen "now".
export const DEFAULT_QUOTE_FRESHNESS_MS = 120_000;
// Oracle maxStaleness on chain is 86400s (lending grade). Far too loose for
// ranking. We apply our own bound during core session.
export const DEFAULT_ORACLE_FRESHNESS_MS = 600_000;

function exclude(list, entry) {
  list.push(Object.freeze({
    venue: entry.venue,
    symbol: entry.symbol ?? null,
    reason: entry.reason,
    evidence: entry.evidence ?? null,
  }));
}

function isDormantQuote(quote) {
  // HIP-3: vol24h in raw. Arcus: vol24h in raw. Spot: vol24h in raw.
  // A missing volume is treated as unknown, not dormant. Only an explicit zero
  // (or sub-epsilon) volume marks the venue/market dormant.
  const vol = quote.raw?.vol24h;
  if (vol === 0 || vol === 0.0) return true;
  if (typeof vol === 'number' && Number.isFinite(vol) && vol <= 0) return true;
  return false;
}

function isCrossed(quote) {
  if (!quote.bid || !quote.ask) return false;
  return cmp(quote.bid, quote.ask) > 0;
}

function isStale(quote, nowMs, freshnessMs) {
  if (!Number.isSafeInteger(quote.capturedAt)) return false;
  return nowMs - quote.capturedAt > freshnessMs;
}

/**
 * Filter a list of validating Quotes into survivors and exclusions.
 *
 * @param {object[]} quotes
 * @param {object} [opts]
 * @param {number} [opts.nowMs]               clock, defaults to Date.now(); tests inject
 * @param {number} [opts.quoteFreshnessMs]
 * @param {number} [opts.oracleFreshnessMs]
 * @param {boolean} [opts.includeDormant]     if true, dormant markets pass with a tag
 * @returns {{ survivors: object[], excluded: object[] }}
 */
export function filterQuotes(quotes, opts = {}) {
  if (!Array.isArray(quotes)) throw new TypeError('quotes must be an array');

  const nowMs = opts.nowMs ?? Date.now();
  const quoteFreshnessMs = opts.quoteFreshnessMs ?? DEFAULT_QUOTE_FRESHNESS_MS;
  const oracleFreshnessMs = opts.oracleFreshnessMs ?? DEFAULT_ORACLE_FRESHNESS_MS;
  const includeDormant = opts.includeDormant === true;

  const survivors = [];
  const excluded = [];

  for (const quote of quotes) {
    // Dormant venue / market.
    if (isDormantQuote(quote)) {
      if (includeDormant) {
        survivors.push(Object.freeze({ ...quote, staleData: true }));
      } else {
        exclude(excluded, {
          venue: quote.venue,
          symbol: quote.symbolRaw ?? quote.symbol,
          reason: REASONS.DORMANT_VENUE,
          evidence: { vol24h: quote.raw?.vol24h ?? null },
        });
      }
      continue;
    }

    // Crossed book.
    if (isCrossed(quote)) {
      exclude(excluded, {
        venue: quote.venue,
        symbol: quote.symbolRaw ?? quote.symbol,
        reason: REASONS.CROSSED_BOOK,
        evidence: {
          bid: quote.bid ? String(quote.bid.mantissa) + 'e-' + quote.bid.scale : null,
          ask: quote.ask ? String(quote.ask.mantissa) + 'e-' + quote.ask.scale : null,
        },
      });
      continue;
    }

    // Stale quote.
    if (isStale(quote, nowMs, quoteFreshnessMs)) {
      exclude(excluded, {
        venue: quote.venue,
        symbol: quote.symbolRaw ?? quote.symbol,
        reason: REASONS.STALE_QUOTE,
        evidence: {
          capturedAt: quote.capturedAt,
          nowMs,
          ageMs: nowMs - quote.capturedAt,
          freshnessMs: quoteFreshnessMs,
        },
      });
      continue;
    }

    // Stale oracle reference (only when the quote carries one as its mid/mark source
    // identity is the oracle itself). RH oracle-only reads are reference tier and
    // ranked separately; when a quote's only price is an oracle print past our
    // bound during core session, exclude it.
    if (quote.tier === 'read-only' && quote.raw?.oracleRaw !== undefined) {
      const session = sessionState(nowMs);
      const bound = session === 'core' ? oracleFreshnessMs : oracleFreshnessMs * 2;
      if (isStale(quote, nowMs, bound)) {
        exclude(excluded, {
          venue: quote.venue,
          symbol: quote.symbolRaw ?? quote.symbol,
          reason: REASONS.STALE_ORACLE,
          evidence: { capturedAt: quote.capturedAt, nowMs, session },
        });
        continue;
      }
    }

    survivors.push(quote);
  }

  return { survivors, excluded };
}
