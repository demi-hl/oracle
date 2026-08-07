// Funding and carry cost over a holding period.
//
// carryBps(hourlyFundingRate, horizonHours) uses simple hourly summation.
// Compounding is ignored at these magnitudes; the error bound is documented in
// the returned carry block. Funding held constant is a FORECAST and is always
// labelled confidence: "estimate". It never silently flips a route to
// costAccounted: true.
//
// Arcus dark windows use the locked SOFR + 0.5% hourly constant for dark hours
// inside the horizon. That requires marketHours to count dark hours.

import { div, fromScaledInteger, mul, parseDecimal, toString } from './num.mjs';
import { DARK_WINDOW_FUNDING_HOURLY } from './venues/arcus-perp.mjs';
import { isDark } from './marketHours.mjs';

const MS_PER_HOUR = 3_600_000;
const HOURS_PER_YEAR = 24 * 365;

/**
 * Simple (non compounding) carry in basis points over a horizon.
 * carryBps = hourlyRate * horizonHours * 10000
 *
 * Truncation is toward zero via BigInt division. At a 30 day horizon and a
 * 1e-5 hourly rate the ignored compounding error is under 0.5bp, documented
 * in the returned block.
 */
export function carryBps(hourlyFundingRate, horizonHours, resultScale = 8) {
  if (hourlyFundingRate === null || hourlyFundingRate === undefined) {
    throw new TypeError('hourlyFundingRate is required');
  }
  if (!Number.isFinite(horizonHours) || horizonHours < 0) {
    throw new RangeError('horizonHours must be a nonnegative finite number');
  }
  if (horizonHours === 0) {
    return parseDecimal('0');
  }
  const hours = parseDecimal(String(horizonHours));
  const tenThousand = fromScaledInteger(10000n, 0);
  return mul(mul(hourlyFundingRate, hours), tenThousand);
}

/**
 * Build a visible carry block for a quote over a horizon.
 *
 * @param {object} quote          a validating Quote (perp expected)
 * @param {number} horizonHours
 * @param {object} [opts]
 * @param {number} [opts.nowMs]   start of the horizon for dark-window counting
 * @param {boolean} [opts.applyDarkWindowLock]  when true, dark hours use SOFR lock
 */
export function carryForQuote(quote, horizonHours, opts = {}) {
  if (quote.instrument !== 'perp') {
    return {
      model: 'current-funding-held-constant',
      horizonHours,
      carryBps: parseDecimal('0'),
      carryBpsDisplay: '0',
      confidence: 'estimate',
      note: 'spot has no funding carry',
    };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const applyDark = opts.applyDarkWindowLock === true;
  let rate = quote.fundingHourly;

  if (applyDark && rate !== null) {
    // Split the horizon into core/extended hours at the live rate and dark hours
    // at the SOFR lock. Count dark hours by sampling each hour boundary.
    const darkHours = countDarkHours(nowMs, horizonHours);
    const litHours = horizonHours - darkHours;
    const darkRate = parseDecimal(DARK_WINDOW_FUNDING_HOURLY);
    const litCarry = carryBps(rate, litHours);
    const darkCarry = carryBps(darkRate, darkHours);
    // Sum the two carry components.
    const scale = Math.max(litCarry.scale, darkCarry.scale);
    const total = {
      mantissa:
        litCarry.mantissa * 10n ** BigInt(scale - litCarry.scale) +
        darkCarry.mantissa * 10n ** BigInt(scale - darkCarry.scale),
      scale,
    };
    return {
      model: 'current-funding-held-constant',
      horizonHours,
      carryBps: total,
      carryBpsDisplay: toString(total),
      confidence: 'estimate',
      darkHours,
      litHours,
      darkWindowRate: DARK_WINDOW_FUNDING_HOURLY,
      compounding: 'ignored',
      compoundingErrorBoundNote:
        'simple sum; at 30d and 1e-5/h the ignored compound is under 0.5bp',
    };
  }

  if (rate === null) {
    return {
      model: 'current-funding-held-constant',
      horizonHours,
      carryBps: null,
      carryBpsDisplay: null,
      confidence: 'estimate',
      note: 'funding rate unknown',
    };
  }

  const c = carryBps(rate, horizonHours);
  return {
    model: 'current-funding-held-constant',
    horizonHours,
    carryBps: c,
    carryBpsDisplay: toString(c),
    confidence: 'estimate',
    compounding: 'ignored',
    compoundingErrorBoundNote:
      'simple sum; at 30d and 1e-5/h the ignored compound is under 0.5bp',
  };
}

function countDarkHours(startMs, horizonHours) {
  if (horizonHours <= 0) return 0;
  let dark = 0;
  const steps = Math.floor(horizonHours);
  for (let i = 0; i < steps; i += 1) {
    if (isDark(startMs + i * MS_PER_HOUR)) dark += 1;
  }
  // Fractional last hour: count it dark if the start of that hour is dark.
  if (horizonHours > steps) {
    if (isDark(startMs + steps * MS_PER_HOUR)) dark += horizonHours - steps;
  }
  return dark;
}

// Annualize an hourly rate for display.  rate * hoursPerYear * 100 for percent.
export function annualizeHourly(hourlyRate, resultScale = 4) {
  if (hourlyRate === null) return null;
  const hours = fromScaledInteger(BigInt(HOURS_PER_YEAR), 0);
  const hundred = fromScaledInteger(100n, 0);
  return mul(mul(hourlyRate, hours), hundred);
}
