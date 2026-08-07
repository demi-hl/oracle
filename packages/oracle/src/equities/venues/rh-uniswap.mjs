// Robinhood Chain Uniswap adapter. This is the ONLY prepare tier venue on the desk.
// Everything else can quote, but this is the one place a user can actually act, which
// is why bestPreparable exists as a separate pointer from the overall ranking winner.
//
// Pricing comes from fixtures/rh_pool_state.json, captured live from chain 4663 via
// pair.slot0() for Uniswap V3 pools and StateView.getSlot0(poolId) for V4 pools. The
// original fixture capture recorded only USD liquidity with NO price field, so pool
// price could not be derived from it at all. That gap is why the state file exists.
//
// Chainlink oracle reads are REFERENCE ONLY. They are emitted as referencePrice and
// are never a rankable route, because nobody can trade at the oracle print.

import { getOracles, getRhPoolState } from '../fixtures.mjs';
import { fromSourceNumber } from '../sourceNum.mjs';
import {
  div,
  fromScaledInteger,
  mul,
  parseDecimal,
  rescale,
  sub,
  toString as numToString,
} from '../num.mjs';
import { validateQuote } from '../types.mjs';

export const VENUE = 'rh_uniswap';
export const CHAIN = 4663;
export const TIER = 'prepare';

// Q96 is the Uniswap fixed point base. sqrtPriceX96 is sqrt(price) * 2^96, so price
// is (sqrtPriceX96^2) / 2^192. Squaring first in BigInt keeps this exact.
const Q192 = 1n << 192n;

// Working precision for the price ratio. High enough that a sub cent equity price is
// not truncated away, bounded so the mantissa stays sane.
const PRICE_SCALE = 18;

// Gas units per route shape. These are estimates for a single swap on this chain and
// are labelled as estimates everywhere they surface. A V4 swap routes through the
// PoolManager unlock/settle flow and costs materially more than a V3 exactInputSingle.
const GAS_UNITS = Object.freeze({ v3: 180000n, v4: 240000n });

function poolStateFile() {
  return getRhPoolState();
}

// price = sqrtPriceX96^2 / 2^192, expressed as token1 per token0 in RAW base units.
function rawRatio(sqrtPriceX96) {
  const sq = sqrtPriceX96 * sqrtPriceX96;
  // Scale up before dividing so BigInt truncation does not eat the whole fraction.
  const scaled = (sq * 10n ** BigInt(PRICE_SCALE)) / Q192;
  return { mantissa: scaled, scale: PRICE_SCALE };
}

// Convert the raw token1-per-token0 ratio into quote units per ONE equity token.
// Decimal correction and orientation are separate concerns and both must be applied.
function poolPrice(state) {
  const ratio = rawRatio(BigInt(state.sqrtPriceX96));
  const quoteDecimals = state.quote === 'USDG' ? 6 : 18;
  const equityDecimals = 18;

  if (state.quoteIsToken0) {
    // ratio is equity-per-quote in raw units. Human equity per quote is
    // ratio * 10^quoteDecimals / 10^equityDecimals, and price is its reciprocal.
    const humanEquityPerQuote = div(
      mul(ratio, fromScaledInteger(10n ** BigInt(quoteDecimals), 0)),
      fromScaledInteger(10n ** BigInt(equityDecimals), 0),
      PRICE_SCALE,
    );
    if (humanEquityPerQuote.mantissa === 0n) return null;
    return div(parseDecimal('1'), humanEquityPerQuote, PRICE_SCALE);
  }

  // ratio is quote-per-equity in raw units, so only the decimal correction applies.
  return div(
    mul(ratio, fromScaledInteger(10n ** BigInt(equityDecimals), 0)),
    fromScaledInteger(10n ** BigInt(quoteDecimals), 0),
    PRICE_SCALE,
  );
}

// Chainlink price() is a scaled integer. The live feed composition on this chain is
// 36 oracle decimals plus 6 USDG decimals minus 18 equity decimals, giving scale 24.
export function referencePrice(symbol) {
  const oracles = getOracles();
  const asset = oracles.assets[symbol];
  if (!asset) return null;
  return fromScaledInteger(asset.rawPrice, oracles.oracleScaleExp);
}

// Constant product price impact at a requested notional. A V3 or V4 pool concentrates
// liquidity, so this xy=k estimate is a MODEL, not a measurement: real impact depends
// on tick distribution we have not captured. It is therefore reported with
// costAccounted false so it can never masquerade as a measured cost.
function modelImpact(liqUsd, notionalUsd) {
  if (liqUsd === null || notionalUsd === null) return null;
  if (liqUsd.mantissa <= 0n || notionalUsd.mantissa <= 0n) return null;
  // impact fraction ~ notional / (liquidity + notional)
  const denom = { ...liqUsd };
  const sum = div(notionalUsd, addFixed(denom, notionalUsd), PRICE_SCALE);
  return sum;
}

function addFixed(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return {
    mantissa: rescale(left, scale).mantissa + rescale(right, scale).mantissa,
    scale,
  };
}

// Gas cost in QUOTE units. gasPriceWei * gasUnits gives wei of native token. This
// chain's native token is ETH, so converting that to USDG needs an ETH price we did
// NOT capture. Rather than invent one, gas is returned in native wei alongside an
// explicit null for its quote denomination, and callers must treat it as unknown.
export function gasEstimate(version) {
  const state = poolStateFile();
  const units = GAS_UNITS[version];
  if (!units) return null;
  const wei = BigInt(state.gasPriceWei) * units;
  return { wei, units, native: 'ETH' };
}

export function listPools() {
  return Object.keys(poolStateFile().pools).sort();
}

export function quote({ symbol, side = 'buy', sizeUsd = null } = {}) {
  if (typeof symbol !== 'string' || symbol.length === 0) {
    throw new TypeError('symbol must be a nonempty string');
  }
  const state = poolStateFile();
  const pool = state.pools[symbol];
  if (!pool) return null;

  const price = poolPrice(pool);
  if (price === null) return null;

  const liqUsd = fromSourceNumber(pool.liqUsd);
  const requested = sizeUsd === null ? parseDecimal('0') : sizeUsd;

  // Fees: a V3 pool reports its fee tier in ppm and that is a real measured number.
  // A V4 pool's fee can be dynamic via its hook and we did not capture it, so it
  // stays null and forces costAccounted false rather than defaulting to zero.
  const fees =
    pool.feePpm === null || pool.feePpm === undefined
      ? null
      : div(fromScaledInteger(BigInt(pool.feePpm), 0), fromScaledInteger(1000000n, 0), 8);

  const impact = requested.mantissa === 0n ? parseDecimal('0') : modelImpact(liqUsd, requested);

  const gas = gasEstimate(pool.version);
  // Gas is known in native wei but NOT convertible to the quote asset without an ETH
  // price we never captured. Unknown is not zero, so this stays null.
  const gasInQuote = null;

  // costAccounted is a claim that every applicable cost is known. Gas is not
  // denominated, V4 fees are undiscovered, and impact at size is modelled rather than
  // measured. Any one of those is enough to make the claim false.
  const costAccounted = false;

  const q = {
    venue: VENUE,
    chain: CHAIN,
    instrument: 'spot',
    tier: TIER,
    symbolRaw: symbol,
    symbol,
    side,
    requestedSize: requested,
    mid: price,
    fees,
    gasEstimate: gasInQuote,
    priceImpact: impact,
    fundingHourly: null,
    costAccounted,
    capturedAt: state.capturedAt * 1000,
    blockOrSeq: state.block,
    raw: {
      fixture: 'fixtures/rh_pool_state.json',
      pair: pool.pair,
      version: pool.version,
      sqrtPriceX96: pool.sqrtPriceX96,
      quote: pool.quote,
      quoteIsToken0: pool.quoteIsToken0,
      liqUsd: pool.liqUsd,
      gasNativeWei: gas === null ? null : gas.wei.toString(),
      gasUnits: gas === null ? null : gas.units.toString(),
      impactModel: 'constant-product-estimate',
      notes: [
        'price read live from chain 4663',
        pool.version === 'v4'
          ? 'v4 fee may be dynamic via hook and was not captured'
          : 'v3 fee tier is the pool static fee',
        'gas known in native wei only, no ETH price captured to denominate it',
      ],
    },
  };

  const reference = referencePrice(symbol);
  if (reference !== null) {
    q.referencePrice = reference;
    // Basis versus the oracle print. Useful evidence, never a tradeable route.
    q.referenceBasisBps = numToString(
      div(mul(sub(price, reference), fromScaledInteger(10000n, 0)), reference, 4),
    );
  }

  return validateQuote(q);
}

export function quoteAll({ side = 'buy', sizeUsd = null } = {}) {
  return listPools()
    .map((symbol) => quote({ symbol, side, sizeUsd }))
    .filter((q) => q !== null);
}
