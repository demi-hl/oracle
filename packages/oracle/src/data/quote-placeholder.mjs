// Placeholder addresses for quote-only provider calls.
//
// Several aggregator APIs (LI.FI, CoW, bridge quoters) require a `from`/`user`
// address to price a route, even when nothing will be signed. Hardcoding a real
// operator wallet as that default is a privacy and correctness bug: public users
// would silently quote against someone else's account, and balance-aware routers
// can return routes tailored to that stranger's holdings.
//
// So: callers SHOULD pass their own address. When they don't, we fall back to a
// well-known burn/zero-ish placeholder that holds nothing and signs nothing.
//
// vitalik.eth is deliberately NOT used here either -- a placeholder must be
// obviously inert, not a real person's account.

/**
 * ERC-191 "dead" address. Universally recognizable as a placeholder, holds no
 * meaningful balance, and cannot sign. Safe default for price-only queries.
 */
export const QUOTE_PLACEHOLDER_ADDRESS =
  "0x000000000000000000000000000000000000dEaD";

/**
 * Resolve the address to use for a quote-only request.
 *
 * @param {string} [preferred] caller-supplied address (their own wallet)
 * @returns {string} the caller's address when usable, else the inert placeholder
 */
export function quoteAddress(preferred) {
  const v = String(preferred || "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(v) ? v : QUOTE_PLACEHOLDER_ADDRESS;
}
