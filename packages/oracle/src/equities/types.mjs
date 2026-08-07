const INSTRUMENTS = new Set(['spot', 'perp']);
const TIERS = new Set(['read-only', 'quote-only', 'prepare', 'intent']);
const SIDES = new Set(['buy', 'sell']);
const RANKED_ON = new Set(['net-of-cost', 'gross']);
const INSTRUMENT_MIXES = new Set(['homogeneous', 'heterogeneous']);
const PRICE_FIELDS = ['bid', 'ask', 'mid', 'mark'];
const COST_FIELDS = ['fees', 'gasEstimate', 'priceImpact', 'fundingHourly'];
const MACHINE_REASON = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function fail(path, message) {
  throw new TypeError(`${path} ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, path) {
  if (!isRecord(value)) fail(path, 'must be an object');
}

function requireOwn(value, key, path) {
  if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required');
}

function requireString(value, path) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(path, 'must be a nonempty string');
  }
}

function requireEnum(value, allowed, path) {
  if (!allowed.has(value)) {
    fail(path, `must be one of ${[...allowed].join(', ')}`);
  }
}

function requireCount(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(path, 'must be a nonnegative safe integer');
  }
}

function requireFixed(value, path, nullable = false) {
  if (value === null && nullable) return;
  if (!isRecord(value)) fail(path, 'must be a fixed point value');
  if (typeof value.mantissa !== 'bigint') fail(`${path}.mantissa`, 'must be a bigint');
  if (!Number.isSafeInteger(value.scale) || value.scale < 0) {
    fail(`${path}.scale`, 'must be a nonnegative safe integer');
  }
}

function requireRoute(value, path, nullable = false) {
  if (value === null && nullable) return;
  requireRecord(value, path);
}

function validateOutcomeEntry(entry, path) {
  requireRecord(entry, path);
  requireString(entry.venue, `${path}.venue`);
  requireString(entry.reason, `${path}.reason`);
  if (!MACHINE_REASON.test(entry.reason)) {
    fail(`${path}.reason`, 'must be a machine readable lower case code');
  }
  if (Object.hasOwn(entry, 'symbol') && entry.symbol !== null) {
    requireString(entry.symbol, `${path}.symbol`);
  }
}

export function validateQuote(quote) {
  requireRecord(quote, 'quote');

  for (const key of [
    'venue',
    'chain',
    'instrument',
    'tier',
    'symbolRaw',
    'symbol',
    'side',
    'requestedSize',
    ...COST_FIELDS,
    'costAccounted',
    'capturedAt',
    'blockOrSeq',
    'raw',
  ]) {
    requireOwn(quote, key, 'quote');
  }

  requireString(quote.venue, 'quote.venue');
  if (
    !(typeof quote.chain === 'string' && quote.chain.length > 0) &&
    !(Number.isSafeInteger(quote.chain) && quote.chain >= 0)
  ) {
    fail('quote.chain', 'must be a nonempty string or nonnegative chain id');
  }
  requireEnum(quote.instrument, INSTRUMENTS, 'quote.instrument');
  requireEnum(quote.tier, TIERS, 'quote.tier');
  requireString(quote.symbolRaw, 'quote.symbolRaw');
  requireString(quote.symbol, 'quote.symbol');
  requireEnum(quote.side, SIDES, 'quote.side');
  requireFixed(quote.requestedSize, 'quote.requestedSize');
  if (quote.requestedSize.mantissa < 0n) {
    fail('quote.requestedSize', 'must not be negative');
  }

  let pricesFound = 0;
  for (const field of PRICE_FIELDS) {
    if (Object.hasOwn(quote, field)) {
      requireFixed(quote[field], `quote.${field}`);
      pricesFound += 1;
    }
  }
  if (pricesFound === 0) {
    fail('quote', 'must contain at least one of bid, ask, mid, mark');
  }

  for (const field of COST_FIELDS) {
    requireFixed(quote[field], `quote.${field}`, true);
  }
  if (typeof quote.costAccounted !== 'boolean') {
    fail('quote.costAccounted', 'must be a boolean');
  }

  if (quote.costAccounted) {
    for (const field of ['fees', 'gasEstimate', 'priceImpact']) {
      if (quote[field] === null) {
        fail(`quote.${field}`, 'cannot be unknown when costAccounted is true');
      }
    }
    if (quote.instrument === 'perp' && quote.fundingHourly === null) {
      fail('quote.fundingHourly', 'cannot be unknown when costAccounted is true for a perp');
    }
  }
  if (quote.instrument === 'spot' && quote.fundingHourly !== null) {
    fail('quote.fundingHourly', 'must be null for a spot quote');
  }

  requireCount(quote.capturedAt, 'quote.capturedAt');
  if (
    quote.blockOrSeq !== null &&
    !(typeof quote.blockOrSeq === 'string' && quote.blockOrSeq.length > 0) &&
    !(Number.isSafeInteger(quote.blockOrSeq) && quote.blockOrSeq >= 0)
  ) {
    fail('quote.blockOrSeq', 'must be null, a nonempty string, or a nonnegative safe integer');
  }
  requireRecord(quote.raw, 'quote.raw');

  return quote;
}

export function validateRankResult(result) {
  requireRecord(result, 'rankResult');

  for (const key of [
    'rankedOn',
    'ranked',
    'winner',
    'runnersUp',
    'improvementBps',
    'sourcesAnswered',
    'sourcesTried',
    'failed',
    'excluded',
    'darkWindow',
    'instrumentMix',
    'bestPreparable',
  ]) {
    requireOwn(result, key, 'rankResult');
  }

  requireEnum(result.rankedOn, RANKED_ON, 'rankResult.rankedOn');
  if (!Array.isArray(result.ranked)) fail('rankResult.ranked', 'must be an array');
  result.ranked.forEach((route, index) => requireRoute(route, `rankResult.ranked[${index}]`));

  requireRoute(result.winner, 'rankResult.winner', true);
  if (result.ranked.length === 0 && result.winner !== null) {
    fail('rankResult.winner', 'must be null when ranked is empty');
  }
  if (result.ranked.length > 0 && result.winner === null) {
    fail('rankResult.winner', 'must be present when ranked is not empty');
  }

  if (!Array.isArray(result.runnersUp)) fail('rankResult.runnersUp', 'must be an array');
  result.runnersUp.forEach((route, index) =>
    requireRoute(route, `rankResult.runnersUp[${index}]`),
  );

  if (
    result.improvementBps !== null &&
    !(typeof result.improvementBps === 'number' && Number.isFinite(result.improvementBps))
  ) {
    fail('rankResult.improvementBps', 'must be a finite number or null');
  }

  requireCount(result.sourcesAnswered, 'rankResult.sourcesAnswered');
  requireCount(result.sourcesTried, 'rankResult.sourcesTried');
  if (result.sourcesAnswered > result.sourcesTried) {
    fail('rankResult.sourcesAnswered', 'must not exceed sourcesTried');
  }

  if (!Array.isArray(result.failed)) fail('rankResult.failed', 'must be an array');
  result.failed.forEach((entry, index) => validateOutcomeEntry(entry, `failed[${index}]`));

  if (!Array.isArray(result.excluded)) fail('rankResult.excluded', 'must be an array');
  result.excluded.forEach((entry, index) => validateOutcomeEntry(entry, `excluded[${index}]`));

  if (result.darkWindow !== null) {
    requireRecord(result.darkWindow, 'rankResult.darkWindow');
  }
  requireEnum(result.instrumentMix, INSTRUMENT_MIXES, 'rankResult.instrumentMix');
  requireRoute(result.bestPreparable, 'rankResult.bestPreparable', true);

  if (Object.hasOwn(result, 'carry') && result.carry !== null) {
    requireRecord(result.carry, 'rankResult.carry');
  }

  return result;
}
