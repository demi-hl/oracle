import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Path join (not new URL('./fixtures/')) so bundlers that cannot resolve bare
// directory URLs (Next/Turbopack) still find the JSON fixtures next to this module.
const DEFAULT_FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FILES = Object.freeze({
  venues: 'venues.json',
  universe: 'universe.json',
  oracles: 'oracles.json',
  nyseHolidays: 'nyse_holidays.json',
  dstTransitions: 'dst_transitions.json',
  equityDexPools: 'equity_dex_pools.json',
  rhPoolState: 'rh_pool_state.json',
  solanaXstocks: 'solana_xstocks.json',
  tonXstocks: 'ton_xstocks.json',
  hip3L2Books: 'hip3_l2books.json',
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fixtureError(filename, message) {
  throw new TypeError(`Fixture fixtures/${filename}: ${message}`);
}

function requireRecord(value, filename, path) {
  if (!isRecord(value)) fixtureError(filename, `${path} must be an object`);
}

function requireString(value, filename, path) {
  if (typeof value !== 'string' || value.length === 0) {
    fixtureError(filename, `${path} must be a nonempty string`);
  }
}

function requireSafeInteger(value, filename, path) {
  if (!Number.isSafeInteger(value)) fixtureError(filename, `${path} must be a safe integer`);
}

function requireMapOfRecords(value, filename, path) {
  requireRecord(value, filename, path);
  for (const [key, entry] of Object.entries(value)) {
    requireString(key, filename, `${path} key`);
    requireRecord(entry, filename, `${path}.${key}`);
  }
}

function validateVenues(data, filename) {
  requireRecord(data, filename, 'root');
  requireSafeInteger(data.capturedAt, filename, 'capturedAt');
  requireRecord(data.venues, filename, 'venues');

  const required = [
    ['hyperliquid_hip3', 'dexs'],
    ['arcus', 'markets'],
    ['arcus_spot', 'pairs'],
    ['rh_uniswap', 'pools'],
    ['rh_chainlink_oracles', 'assets'],
  ];
  for (const [venueName, collection] of required) {
    const venue = data.venues[venueName];
    requireRecord(venue, filename, `venues.${venueName}`);
    requireString(venue.type, filename, `venues.${venueName}.type`);
    requireString(venue.chain, filename, `venues.${venueName}.chain`);
    requireString(venue.tier, filename, `venues.${venueName}.tier`);
    requireMapOfRecords(
      venue[collection],
      filename,
      `venues.${venueName}.${collection}`,
    );
  }

  for (const [dex, markets] of Object.entries(data.venues.hyperliquid_hip3.dexs)) {
    requireMapOfRecords(markets, filename, `venues.hyperliquid_hip3.dexs.${dex}`);
  }
}

function validateUniverse(data, filename) {
  requireMapOfRecords(data, filename, 'root');
  if (Object.keys(data).length === 0) fixtureError(filename, 'root must not be empty');

  for (const [symbol, entry] of Object.entries(data)) {
    if (!Array.isArray(entry.venues)) {
      fixtureError(filename, `${symbol}.venues must be an array`);
    }
    entry.venues.forEach((venue, index) =>
      requireString(venue, filename, `${symbol}.venues[${index}]`),
    );
  }
}

function validateOracles(data, filename) {
  requireRecord(data, filename, 'root');
  for (const key of [
    'chainId',
    'block',
    'oracleScaleExp',
    'usdgDecimals',
    'equityDecimals',
  ]) {
    requireSafeInteger(data[key], filename, key);
  }
  requireString(data.usdg, filename, 'usdg');
  requireMapOfRecords(data.assets, filename, 'assets');

  for (const [symbol, asset] of Object.entries(data.assets)) {
    requireString(asset.oracle, filename, `assets.${symbol}.oracle`);
    requireString(asset.token, filename, `assets.${symbol}.token`);
    if (typeof asset.rawPrice !== 'string' || !/^\d+$/.test(asset.rawPrice)) {
      fixtureError(filename, `assets.${symbol}.rawPrice must be an integer string`);
    }
    if (typeof asset.usd !== 'number' || !Number.isFinite(asset.usd) || asset.usd < 0) {
      fixtureError(filename, `assets.${symbol}.usd must be a nonnegative finite source number`);
    }
  }
}

function validateNyseHolidays(data, filename) {
  requireRecord(data, filename, 'root');
  for (const key of ['holidayDayIndex', 'names', 'dates']) {
    if (!Array.isArray(data[key])) fixtureError(filename, `${key} must be an array`);
  }
  const count = data.holidayDayIndex.length;
  if (data.names.length !== count || data.dates.length !== count) {
    fixtureError(filename, 'holidayDayIndex, names, and dates must have equal lengths');
  }
  data.holidayDayIndex.forEach((value, index) =>
    requireSafeInteger(value, filename, `holidayDayIndex[${index}]`),
  );
  data.names.forEach((value, index) => requireString(value, filename, `names[${index}]`));
  data.dates.forEach((value, index) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      fixtureError(filename, `dates[${index}] must use YYYY-MM-DD`);
    }
  });
}

function validateDstTransitions(data, filename) {
  requireRecord(data, filename, 'root');
  if (!Array.isArray(data.dstTransitions) || data.dstTransitions.length === 0) {
    fixtureError(filename, 'dstTransitions must be a nonempty array');
  }
  const years = new Set();
  data.dstTransitions.forEach((entry, index) => {
    requireRecord(entry, filename, `dstTransitions[${index}]`);
    for (const key of ['year', 'startUtc', 'endUtc']) {
      requireSafeInteger(entry[key], filename, `dstTransitions[${index}].${key}`);
    }
    if (entry.startUtc >= entry.endUtc) {
      fixtureError(filename, `dstTransitions[${index}] startUtc must be before endUtc`);
    }
    if (years.has(entry.year)) {
      fixtureError(filename, `dstTransitions contains duplicate year ${entry.year}`);
    }
    years.add(entry.year);
  });
}

function validateEquityDexPools(data, filename) {
  requireMapOfRecords(data, filename, 'root');
  if (Object.keys(data).length === 0) fixtureError(filename, 'root must not be empty');

  for (const [symbol, pool] of Object.entries(data)) {
    for (const key of ['addr', 'quote', 'quoteAddr', 'dex', 'pair']) {
      requireString(pool[key], filename, `${symbol}.${key}`);
    }
    if (typeof pool.liq !== 'number' || !Number.isFinite(pool.liq) || pool.liq < 0) {
      fixtureError(filename, `${symbol}.liq must be a nonnegative finite source number`);
    }
  }
}

// The original capture recorded pool ADDRESSES and USD liquidity but NO price field,
// so a pool price could not be derived from it at all. This state file closes that gap:
// sqrtPriceX96 read live from chain 4663 via pair.slot0() for V3 and
// StateView.getSlot0(poolId) for V4. quoteIsToken0 records currency orientation, which
// for V4 is derived from the currency0 < currency1 address ordering invariant rather
// than guessed, because four pools (GOOGL, AMZN, SPY, TSLA) sort the equity below USDG
// and would otherwise price inverted by a factor of ~1e19.
function validateRhPoolState(data, filename) {
  requireRecord(data, filename, 'root');
  requireSafeInteger(data.capturedAt, filename, 'capturedAt');
  requireSafeInteger(data.block, filename, 'block');
  requireSafeInteger(data.chainId, filename, 'chainId');
  requireString(data.gasPriceWei, filename, 'gasPriceWei');
  requireString(data.stateView, filename, 'stateView');
  requireMapOfRecords(data.pools, filename, 'pools');
  if (Object.keys(data.pools).length === 0) fixtureError(filename, 'pools must not be empty');

  for (const [symbol, pool] of Object.entries(data.pools)) {
    for (const key of ['pair', 'version', 'quote', 'token', 'sqrtPriceX96']) {
      requireString(pool[key], filename, `pools.${symbol}.${key}`);
    }
    if (pool.version !== 'v3' && pool.version !== 'v4') {
      fixtureError(filename, `pools.${symbol}.version must be v3 or v4`);
    }
    if (typeof pool.quoteIsToken0 !== 'boolean') {
      fixtureError(filename, `pools.${symbol}.quoteIsToken0 must be a boolean`);
    }
    if (!/^[0-9]+$/.test(pool.sqrtPriceX96) || BigInt(pool.sqrtPriceX96) <= 0n) {
      fixtureError(filename, `pools.${symbol}.sqrtPriceX96 must be a positive integer string`);
    }
  }
}

// Live HIP-3 l2Book snapshots. Unlocks size-aware impact for coins that have a book.
function validateHip3L2Books(data, filename) {
  requireRecord(data, filename, 'root');
  requireSafeInteger(data.capturedAt, filename, 'capturedAt');
  requireString(data.source, filename, 'source');
  requireRecord(data.books, filename, 'books');
  if (Object.keys(data.books).length === 0) fixtureError(filename, 'books must not be empty');
  for (const [coin, book] of Object.entries(data.books)) {
    requireRecord(book, filename, `books.${coin}`);
    if (!Array.isArray(book.bids) || !Array.isArray(book.asks)) {
      fixtureError(filename, `books.${coin} must have bids and asks arrays`);
    }
    for (const [i, lvl] of book.bids.entries()) {
      requireRecord(lvl, filename, `books.${coin}.bids[${i}]`);
      requireString(lvl.px, filename, `books.${coin}.bids[${i}].px`);
      requireString(lvl.sz, filename, `books.${coin}.bids[${i}].sz`);
    }
    for (const [i, lvl] of book.asks.entries()) {
      requireRecord(lvl, filename, `books.${coin}.asks[${i}]`);
      requireString(lvl.px, filename, `books.${coin}.asks[${i}].px`);
      requireString(lvl.sz, filename, `books.${coin}.asks[${i}].sz`);
    }
  }
}

// Solana xStocks capture from DexScreener. liquidity.usd and priceUsd are
// third party floats: converting them to fixed point does not make them exact.
// Impact at size is modeled, never measured from these fields alone.
function validateSolanaXstocks(data, filename) {
  requireRecord(data, filename, 'root');
  requireSafeInteger(data.capturedAt, filename, 'capturedAt');
  requireString(data.source, filename, 'source');
  requireString(data.chain, filename, 'chain');
  requireMapOfRecords(data.tokens, filename, 'tokens');
  requireRecord(data.pairs, filename, 'pairs');
  if (Object.keys(data.tokens).length === 0) fixtureError(filename, 'tokens must not be empty');

  for (const [symbol, token] of Object.entries(data.tokens)) {
    requireString(token.symbolRaw, filename, `tokens.${symbol}.symbolRaw`);
    requireString(token.mint, filename, `tokens.${symbol}.mint`);
    if (!Object.hasOwn(data.pairs, symbol)) {
      fixtureError(filename, `pairs.${symbol} is required for token ${symbol}`);
    }
    if (!Array.isArray(data.pairs[symbol]) || data.pairs[symbol].length === 0) {
      fixtureError(filename, `pairs.${symbol} must be a nonempty array`);
    }
    for (const [i, pair] of data.pairs[symbol].entries()) {
      requireRecord(pair, filename, `pairs.${symbol}[${i}]`);
      requireString(pair.pairAddress, filename, `pairs.${symbol}[${i}].pairAddress`);
      requireString(pair.dexId, filename, `pairs.${symbol}[${i}].dexId`);
      if (typeof pair.priceUsd !== 'number' || !Number.isFinite(pair.priceUsd) || pair.priceUsd <= 0) {
        fixtureError(filename, `pairs.${symbol}[${i}].priceUsd must be a positive finite number`);
      }
      if (typeof pair.liquidityUsd !== 'number' || !Number.isFinite(pair.liquidityUsd) || pair.liquidityUsd < 0) {
        fixtureError(filename, `pairs.${symbol}[${i}].liquidityUsd must be a nonnegative finite number`);
      }
    }
  }
}

// TON xStocks (ston.fi and other TON dexs) via DexScreener. Same float caveats
// as Solana. Live capture may be thin (SPY-only is a valid snapshot).
function validateTonXstocks(data, filename) {
  requireRecord(data, filename, 'root');
  requireSafeInteger(data.capturedAt, filename, 'capturedAt');
  requireString(data.source, filename, 'source');
  requireString(data.chain, filename, 'chain');
  if (data.chain !== 'ton') fixtureError(filename, 'chain must be "ton"');
  requireMapOfRecords(data.tokens, filename, 'tokens');
  requireRecord(data.pairs, filename, 'pairs');
  if (Object.keys(data.tokens).length === 0) fixtureError(filename, 'tokens must not be empty');

  for (const [symbol, token] of Object.entries(data.tokens)) {
    requireString(token.symbolRaw, filename, `tokens.${symbol}.symbolRaw`);
    requireString(token.mint, filename, `tokens.${symbol}.mint`);
    if (!Object.hasOwn(data.pairs, symbol)) {
      fixtureError(filename, `pairs.${symbol} is required for token ${symbol}`);
    }
    if (!Array.isArray(data.pairs[symbol]) || data.pairs[symbol].length === 0) {
      fixtureError(filename, `pairs.${symbol} must be a nonempty array`);
    }
    for (const [i, pair] of data.pairs[symbol].entries()) {
      requireRecord(pair, filename, `pairs.${symbol}[${i}]`);
      requireString(pair.pairAddress, filename, `pairs.${symbol}[${i}].pairAddress`);
      requireString(pair.dexId, filename, `pairs.${symbol}[${i}].dexId`);
      if (typeof pair.priceUsd !== 'number' || !Number.isFinite(pair.priceUsd) || pair.priceUsd <= 0) {
        fixtureError(filename, `pairs.${symbol}[${i}].priceUsd must be a positive finite number`);
      }
      if (typeof pair.liquidityUsd !== 'number' || !Number.isFinite(pair.liquidityUsd) || pair.liquidityUsd < 0) {
        fixtureError(filename, `pairs.${symbol}[${i}].liquidityUsd must be a nonnegative finite number`);
      }
    }
  }
}

const VALIDATORS = Object.freeze({
  venues: validateVenues,
  universe: validateUniverse,
  oracles: validateOracles,
  nyseHolidays: validateNyseHolidays,
  dstTransitions: validateDstTransitions,
  equityDexPools: validateEquityDexPools,
  rhPoolState: validateRhPoolState,
  solanaXstocks: validateSolanaXstocks,
  tonXstocks: validateTonXstocks,
  hip3L2Books: validateHip3L2Books,
});

function readFixture(fixtureDir, key) {
  const filename = FILES[key];
  const path = join(fixtureDir, filename);
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Fixture fixtures/${filename} is missing at ${path}`);
    }
    throw new Error(`Fixture fixtures/${filename} could not be read: ${error.message}`);
  }

  let data;
  try {
    data = JSON.parse(source);
  } catch (error) {
    throw new SyntaxError(`Fixture fixtures/${filename} contains invalid JSON: ${error.message}`);
  }
  VALIDATORS[key](data, filename);
  return data;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function loadFixtures({ fixtureDir = DEFAULT_FIXTURE_DIR } = {}) {
  if (typeof fixtureDir !== 'string' || fixtureDir.length === 0) {
    throw new TypeError('fixtureDir must be a nonempty path string');
  }

  const fixtures = {};
  for (const key of Object.keys(FILES)) {
    fixtures[key] = readFixture(fixtureDir, key);
  }
  return deepFreeze(fixtures);
}

let defaultFixtures;

function defaults() {
  defaultFixtures ??= loadFixtures();
  return defaultFixtures;
}

export function getVenues() {
  return defaults().venues;
}

export function getUniverse() {
  return defaults().universe;
}

export function getOracles() {
  return defaults().oracles;
}

export function getNyseHolidays() {
  return defaults().nyseHolidays;
}

export function getDstTransitions() {
  return defaults().dstTransitions;
}

export function getEquityDexPools() {
  return defaults().equityDexPools;
}

export function getRhPoolState() {
  return defaults().rhPoolState;
}

export function getSolanaXstocks() {
  return defaults().solanaXstocks;
}

export function getTonXstocks() {
  return defaults().tonXstocks;
}

export function getHip3L2Books() {
  return defaults().hip3L2Books;
}
