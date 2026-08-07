// Prepare-only artifact builder for RH Uniswap routes.
// Emits unsigned transaction descriptors. Contains zero signing code and zero
// key handling by construction. Refuses quote-only routes and stale quotes.

import { quote as rhQuote } from './venues/rh-uniswap.mjs';
import { getRhPoolState } from './fixtures.mjs';

export const FRESHNESS_MS = 120_000;

// Uniswap V3 SwapRouter02 style exactInputSingle selector, placeholder encoding.
// The real calldata builder lands when a full router address is pinned. For v1
// we emit a structured intent the user wallet / higher layer can encode.
const V3_ROUTER = '0x0000000000000000000000000000000000000000'; // not yet pinned
const V4_POOL_MANAGER = '0x84b75b19A3cdf8E2F56d0507d22D442847B2053C';

/**
 * Prepare an unsigned swap artifact for a RH Uniswap equity pool.
 *
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {'buy'|'sell'} [opts.side]
 * @param {object} [opts.sizeUsd]   fixed point
 * @param {number} [opts.nowMs]
 * @param {string} opts.recipient   user wallet, required
 */
export function prepare(opts = {}) {
  const { symbol, side = 'buy', sizeUsd = null, recipient, nowMs = Date.now() } = opts;

  if (typeof symbol !== 'string' || !symbol) {
    throw new TypeError('symbol is required');
  }
  if (typeof recipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    throw new TypeError('recipient must be a 0x-prefixed 20 byte address');
  }

  const q = rhQuote({ symbol, side, sizeUsd });
  if (q === null) {
    throw new Error(`no RH Uniswap pool for ${symbol}`);
  }
  if (q.tier !== 'prepare') {
    throw new Error(`route tier is ${q.tier}, only prepare tier can be prepared`);
  }

  const ageMs = nowMs - q.capturedAt;
  if (ageMs > FRESHNESS_MS) {
    throw new Error(
      `quote is stale (${ageMs}ms old, bound ${FRESHNESS_MS}ms); re-quote before preparing`,
    );
  }

  const state = getRhPoolState();
  const pool = state.pools[symbol];
  const to = pool.version === 'v4' ? V4_POOL_MANAGER : V3_ROUTER;

  // Approval target is the router/pool manager, NEVER the destination of funds.
  const spender = to;
  const token = side === 'buy' ? pool.quoteAddr : pool.token;

  return Object.freeze({
    artifactKind: 'unsigned-tx',
    chainId: 4663,
    to,
    data: '0x', // calldata encoding is a follow up; structure is the contract
    value: '0',
    requiresApproval: {
      spender,
      token,
      amount: null, // exact amount filled by the caller from size
    },
    requiresWalletSignature: true,
    backendSigner: false,
    unsigned: true,
    houseSigned: false,
    quoteRef: {
      venue: q.venue,
      symbol: q.symbol,
      symbolRaw: q.symbolRaw,
      capturedAt: q.capturedAt,
      blockOrSeq: q.blockOrSeq,
      mid: q.mid,
      version: pool.version,
      pair: pool.pair,
    },
    quoteAgeMs: ageMs,
    recipient,
    side,
    notes: [
      'prepare-only: user wallet must sign',
      'calldata encoding is deferred; this artifact is the bound intent',
      pool.version === 'v4'
        ? 'V4 route via PoolManager'
        : 'V3 route via SwapRouter (address not yet pinned)',
    ],
  });
}
