// Symbol normalization for Oracle Equities.
//
// Every venue names the same underlying differently. This module resolves all of
// those forms to ONE canonical Oracle symbol so the ranking engine compares like
// with like.
//
// The governing rule is FAIL CLOSED. A wrong symbol match does not produce a
// missing row, it produces a FABRICATED one: two different assets get differenced
// and printed as an arbitrage that does not exist. Concretely, in the captured
// fixtures the ticker "LIT" appears on hyperliquid_hip3 (dex hyna, mark 3.37) and
// on arcus perps (mark 2.0379). A naive canonicalization merges them and prints a
// ~6536bp spread. Those are two different underlyings sharing three letters. The
// same trap exists for SKHX (1169.2) versus SKHY (153.61), both live on dex xyz.
//
// So: we never guess. Unknown or contested input returns
// { ambiguous: true, candidates: [...] } and the caller must either supply an
// explicit assetClass assertion or drop the row.
//
// Zero runtime dependencies. Node builtins only, via src/fixtures.mjs.

import { getUniverse, getVenues } from './fixtures.mjs';

// ---------------------------------------------------------------------------
// canonical universe, sourced from fixtures/universe.json (the authority)
// ---------------------------------------------------------------------------

let canonicalSet;
function canonical() {
  canonicalSet ??= new Set(Object.keys(getUniverse()));
  return canonicalSet;
}

let dexSet;
function knownDexs() {
  dexSet ??= new Set(Object.keys(getVenues().venues.hyperliquid_hip3.dexs));
  return dexSet;
}

/**
 * Symbols that mean genuinely DIFFERENT underlyings on different venues.
 * Listed explicitly. Each entry must be disambiguated by the caller with an
 * assetClass assertion, and even then the result is never cross venue comparable.
 */
export const CONTESTED_SYMBOLS = Object.freeze({
  LIT: Object.freeze([
    Object.freeze({
      assetClass: 'etf',
      description: 'Global X Lithium and Battery Tech ETF, an equity basket',
      venues: Object.freeze(['hyperliquid_hip3']),
    }),
    Object.freeze({
      assetClass: 'crypto',
      description: 'a crypto perp listed under the same three letters',
      venues: Object.freeze(['arcus']),
    }),
  ]),
});

/**
 * Venue unique names: pre IPO markets and synthetic baskets that exist on exactly
 * ONE venue in the captured fixtures. They map to themselves. They can never be
 * cross venue ranked because there is no second venue to compare against.
 *
 * Derived from fixtures/venues.json: symbols on dex vntl that appear nowhere else.
 * NOTE: WHEAT is on vntl AND xyz, so it is deliberately excluded here.
 */
export const VENUE_UNIQUE_SYMBOLS = Object.freeze([
  'SPACEX',
  'OPENAI',
  'ANTHROPIC',
  'MAG7',
  'SEMIS',
  'ROBOT',
  'INFOTECH',
  'NUCLEAR',
  'DEFENSE',
  'ENERGY',
  'BIOTECH',
  'GOLDJM',
  'SILVERJM',
  'SOY',
]);

const VENUE_UNIQUE_SET = new Set(VENUE_UNIQUE_SYMBOLS);

/**
 * Allowlist for the lowercase x suffix (Solana xStocks style: NVDAx -> NVDA).
 * The suffix is stripped ONLY for these bases, so a genuine ticker ending in a
 * lowercase x is never mangled. No fixture currently exercises this with real
 * data (no Solana or TON venue was captured), but the rule is cheap and correct
 * and a future adapter needs it.
 */
export const XSTOCK_BASE_ALLOWLIST = Object.freeze([
  'NVDA',
  'TSLA',
  'SPY',
  'AAPL',
  'COIN',
  'AMZN',
  'GOOGL',
  'MSFT',
]);

const XSTOCK_BASE_SET = new Set(XSTOCK_BASE_ALLOWLIST);

const QUOTE_SUFFIXES = Object.freeze(['-USD', '-USDC', '-USDT', '-PERP']);

// ---------------------------------------------------------------------------
// result shape
// ---------------------------------------------------------------------------

function resolved(symbolRaw, symbol, extra = {}) {
  return Object.freeze({
    ok: true,
    ambiguous: false,
    symbol,
    symbolRaw,
    dex: extra.dex ?? null,
    applied: Object.freeze(extra.applied ?? []),
    venueUnique: extra.venueUnique ?? false,
    contested: extra.contested ?? false,
    crossVenueComparable: extra.crossVenueComparable ?? true,
    candidates: Object.freeze([]),
    reason: null,
  });
}

function unresolved(symbolRaw, reason, candidates = []) {
  return Object.freeze({
    ok: false,
    ambiguous: true,
    symbol: null,
    symbolRaw: typeof symbolRaw === 'string' ? symbolRaw : null,
    dex: null,
    applied: Object.freeze([]),
    venueUnique: false,
    contested: false,
    crossVenueComparable: false,
    candidates: Object.freeze(candidates.map((c) => Object.freeze({ ...c }))),
    reason,
  });
}

// ---------------------------------------------------------------------------
// public helpers
// ---------------------------------------------------------------------------

export function listCanonicalSymbols() {
  return [...canonical()];
}

export function isCanonical(symbol) {
  return typeof symbol === 'string' && canonical().has(symbol);
}

/**
 * Resolve a venue specific symbol form to its canonical Oracle symbol.
 *
 * @param {string} input        raw venue symbol, e.g. "xyz:NVDA", "NVDA-USD", "NVDAx"
 * @param {object} [options]
 * @param {string} [options.assetClass]  explicit assertion required to resolve a
 *                                       contested ticker. Never inferred.
 * @returns {object} frozen resolution record. Check `.ok` before using `.symbol`.
 */
export function normalizeSymbol(input, options = {}) {
  if (typeof input !== 'string') {
    return unresolved(input, 'input must be a string');
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return unresolved(input, 'input must be a nonempty symbol');
  }

  const applied = [];
  let working = trimmed;
  let dex = null;

  // 1. dex namespace strip, allowlisted against the real HIP-3 dex list.
  const colon = working.indexOf(':');
  if (colon !== -1) {
    const prefix = working.slice(0, colon);
    const rest = working.slice(colon + 1);
    if (prefix.length === 0 || rest.length === 0) {
      return unresolved(input, 'malformed dex namespace');
    }
    if (!knownDexs().has(prefix)) {
      return unresolved(input, `unknown dex namespace "${prefix}"`, [
        {
          assetClass: 'unknown',
          description: `no HIP-3 dex named "${prefix}" in the captured fixtures`,
          venues: [],
        },
      ]);
    }
    dex = prefix;
    working = rest;
    applied.push('dex-namespace-strip');
  }

  // 2. quote suffix strip (-USD and friends), case insensitive on the suffix only.
  for (const suffix of QUOTE_SUFFIXES) {
    if (working.length > suffix.length && working.toUpperCase().endsWith(suffix)) {
      working = working.slice(0, working.length - suffix.length);
      applied.push('quote-suffix-strip');
      break;
    }
  }

  // 3. lowercase x suffix strip, allowlist gated so a real ticker ending in a
  //    lowercase x is never mangled. Uppercase X is NOT a suffix (see SKHX).
  if (working.endsWith('x')) {
    const base = working.slice(0, -1);
    if (XSTOCK_BASE_SET.has(base)) {
      working = base;
      applied.push('xstock-suffix-strip');
    }
    // Not allowlisted: leave it alone and let the canonical check decide.
  }

  if (working.length === 0) {
    return unresolved(input, 'symbol empty after transforms');
  }

  // 4. venue unique names (pre IPO, baskets) map to themselves.
  if (VENUE_UNIQUE_SET.has(working)) {
    return resolved(trimmed, working, {
      dex,
      applied,
      venueUnique: true,
      crossVenueComparable: false,
    });
  }

  // 5. contested tickers: never guessed, require an explicit assetClass.
  if (Object.hasOwn(CONTESTED_SYMBOLS, working)) {
    const candidates = CONTESTED_SYMBOLS[working];
    const asserted = options.assetClass;
    if (typeof asserted !== 'string' || asserted.length === 0) {
      return unresolved(
        input,
        `"${working}" names different underlyings on different venues, ` +
          'caller must assert assetClass',
        candidates,
      );
    }
    const match = candidates.find((c) => c.assetClass === asserted);
    if (!match) {
      return unresolved(
        input,
        `assetClass "${asserted}" matches no known underlying for "${working}"`,
        candidates,
      );
    }
    return resolved(trimmed, working, {
      dex,
      applied,
      contested: true,
      crossVenueComparable: false,
    });
  }

  // 6. canonical universe check. This is the fail closed gate.
  if (canonical().has(working)) {
    return resolved(trimmed, working, { dex, applied });
  }

  return unresolved(
    input,
    `"${working}" is not in the canonical universe, refusing to guess`,
    nearMissCandidates(working),
  );
}

/**
 * Suggest canonical symbols a caller might have meant, WITHOUT resolving to them.
 * Suggestions are diagnostic only. They are deliberately not auto applied: that is
 * exactly the fuzzy step that fabricates spreads.
 */
function nearMissCandidates(working) {
  const upper = working.toUpperCase();
  const out = [];
  for (const symbol of canonical()) {
    if (symbol === upper) continue;
    if (symbol.startsWith(upper) || upper.startsWith(symbol)) {
      out.push({
        assetClass: 'unknown',
        description: `canonical "${symbol}" shares a prefix, not auto applied`,
        venues: [],
      });
    }
    if (out.length >= 5) break;
  }
  return out;
}
