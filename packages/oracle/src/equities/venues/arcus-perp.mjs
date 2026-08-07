// Arcus perpetual markets on Robinhood Chain 4663.
// Tier: quote-only. Reports mark, oracle, funding, RTH flags, and margin fractions
// exactly as the fixture captured them. Dark-window funding is locked to the SOFR
// + 0.5% hourly constant; that constant is surfaceable from the fixture so
// funding.mjs can apply it without re-deriving SOFR.

import { getVenues } from '../fixtures.mjs';
import { fromSourceNumber, requireSourceNumber } from '../sourceNum.mjs';
import { parseDecimal } from '../num.mjs';
import { validateQuote } from '../types.mjs';

export const VENUE = 'arcus_perp';
export const CHAIN = 'robinhood-4663';
export const TIER = 'quote-only';

// Locked dark-window hourly funding: SOFR + 0.5% annualized, held constant.
// Verified exact string round trip through the fixed point core.
export const DARK_WINDOW_FUNDING_HOURLY = '0.00000480324074074';

function arcus() {
  return getVenues().venues.arcus;
}

export function listMarkets() {
  return Object.keys(arcus().markets).sort();
}

export function quote({ symbol, side = 'buy', sizeUsd = null } = {}) {
  if (typeof symbol !== 'string' || symbol.length === 0) return null;
  // Accept both NVDA and NVDA-USD forms.
  const bare = symbol.endsWith('-USD') ? symbol.slice(0, -4) : symbol;
  const market = arcus().markets[bare];
  if (!market) return null;

  const mark = requireSourceNumber(market.mark, `${bare}.mark`);
  const oracle = fromSourceNumber(market.oracle);
  const funding = fromSourceNumber(market.fundingHourly);
  const requested = sizeUsd === null ? parseDecimal('0') : sizeUsd;

  const q = {
    venue: VENUE,
    chain: CHAIN,
    instrument: 'perp',
    tier: TIER,
    symbolRaw: symbol,
    symbol: bare,
    side,
    requestedSize: requested,
    mark,
    fees: null,
    gasEstimate: null,
    priceImpact: null,
    fundingHourly: funding,
    costAccounted: false,
    capturedAt: getVenues().capturedAt * 1000,
    blockOrSeq: null,
    raw: {
      fixture: 'fixtures/venues.json#venues.arcus',
      oraclePrice: market.oracle,
      vol24h: market.vol24h,
      oi: market.oi,
      fundingAnnPct: market.fundingAnnPct,
      category: market.category,
      isOutsideRth: market.isOutsideRth === true,
      rth: market.rth,
      // Surface the locked dark-window constant so funding.mjs does not re-derive it.
      darkWindowFundingHourly: DARK_WINDOW_FUNDING_HOURLY,
      // Margin fractions are not always in the fixture. Surface when present.
      initialMarginFraction: market.initialMarginFraction ?? null,
      offHoursInitialMarginFraction: market.offHoursInitialMarginFraction ?? null,
      reasonCostUnknown: 'fees, gas, and impact at size not captured for Arcus perps',
    },
  };

  if (oracle !== null) q.raw.oracleFixed = oracle;

  return validateQuote(q);
}

export function quoteAll({ side = 'buy', sizeUsd = null } = {}) {
  return listMarkets()
    .map((symbol) => quote({ symbol, side, sizeUsd }))
    .filter((q) => q !== null);
}
