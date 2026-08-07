// Portfolio pricing and pruning math.
//
// Extracted from the route so it can be pinned by a deterministic golden-master
// test. Everything here is pure: no network, no Next, no chain registry. Prices
// are injected by the caller, which is what makes the fixture reproducible.
//
// The bug class this module exists to contain: a portfolio total that is
// silently WRONG is worse than one that is missing. A spoofed ERC-20 once
// priced a test wallet at $6.1T against a real $710K. Nothing in a passing test
// suite caught it, because nothing asserted on a total.

/**
 * DeFiLlama namespaces for contract-address pricing. A chain absent here can
 * still price its native coin; only token-by-address lookup is unavailable.
 */
export const LLAMA_CHAIN_NAMESPACES = Object.freeze({
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  137: "polygon",
  8453: "base",
  42161: "arbitrum",
  43114: "avax",
});

/** Native coin price keys. Native assets cannot be minted by a third party. */
export const NATIVE_PRICE_KEYS = Object.freeze({
  1: "coingecko:ethereum",
  10: "coingecko:ethereum",
  56: "coingecko:binancecoin",
  137: "coingecko:polygon-ecosystem-token",
  988: "coingecko:tether",
  999: "coingecko:hyperliquid",
  2741: "coingecko:ethereum",
  4663: "coingecko:ethereum",
  8453: "coingecko:ethereum",
  42161: "coingecko:ethereum",
  43114: "coingecko:avalanche-2",
});

/** Rows kept per chain. Genuine holdings are bounded; airdropped spam is not. */
export const MAX_ROWS_PER_CHAIN = 60;

/**
 * Single-position ceiling, in USD.
 *
 * No individual position in a real consumer wallet reaches a billion dollars.
 * A row that does is a pricing fault — spoofed decimals, a bad oracle quote, or
 * a symbol collision — not a fortune. Such rows are flagged and excluded from
 * the headline total rather than silently summed into it.
 */
export const IMPLAUSIBLE_ROW_USD = 1_000_000_000;

/**
 * Share of the total a single row may hold before it is called out.
 *
 * Concentration is legitimate (one whale position can dominate a wallet), so
 * this does NOT exclude the row. It only marks it for disclosure, because a
 * total resting almost entirely on one price deserves to say so.
 */
export const CONCENTRATION_WARN_RATIO = 0.8;

export function stringValue(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Resolve the price key for a row.
 *
 * Symbol is attacker-controlled on any ERC-20: anyone can deploy a token called
 * "BTC". It is therefore trusted ONLY for assets a third party cannot mint —
 * the chain's own native coin, or a real Bitcoin UTXO. Every other asset prices
 * by contract address, or not at all.
 */
export function priceKeyForRow(row) {
  if (row.kind === "btc-utxo") return "coingecko:bitcoin";
  if (row.kind === "native" && row.chainNumericId) {
    return NATIVE_PRICE_KEYS[row.chainNumericId] ?? null;
  }
  if (row.chainId === "solana" && row.address) return `solana:${row.address}`;
  if (!row.chainNumericId || !row.address) return null;
  const namespace = LLAMA_CHAIN_NAMESPACES[row.chainNumericId];
  return namespace ? `${namespace}:${row.address.toLowerCase()}` : null;
}

export function decimalAmount(amount, decimals) {
  if (!amount || decimals === null || decimals === undefined) return null;
  if (!/^\d+$/.test(amount)) return null;
  const value = Number(amount) / 10 ** decimals;
  return Number.isFinite(value) ? value : null;
}

/**
 * Drop rows carrying no information, before the response size is measured.
 *
 * Nothing priced or non-zero is discarded, so the total is unaffected.
 */
export function prunedRows(rows) {
  const kept = rows.filter((row) => {
    const amount = stringValue(row.amount) ?? stringValue(row.sats) ?? stringValue(row.size) ?? stringValue(row.count);
    if (row.priced === true) return true;
    if (!amount) return false;
    return !/^0+$/.test(amount.replace(/[.,]/g, ""));
  });
  return { rows: kept, dropped: rows.length - kept.length };
}

/** Apply injected prices to rows that the upstream did not already value. */
export function valueRows(rows, prices) {
  return rows.map((row) => {
    if (row.priced && row.valueUsd !== null) return row;
    const key = priceKeyForRow(row);
    const amount = decimalAmount(row.amount, row.decimals);
    const price = key ? prices.get(key) : null;
    if (amount === null || price === null || price === undefined) return row;
    const valueUsd = amount * price;
    if (!Number.isFinite(valueUsd)) return row;
    return { ...row, valueUsd: String(valueUsd), priced: true };
  });
}

/**
 * Flag rows whose value is not physically plausible.
 *
 * Last line of defence for the wrong-number bug class. Spoofed decimals, a bad
 * quote, or a future symbol-trust regression all surface here as an absurd row
 * value. Flagged rows keep their data but are excluded from the total, so the
 * headline degrades to "partial" instead of to "$6.1 trillion".
 */
export function flagImplausible(rows) {
  let suspectCount = 0;
  const flagged = rows.map((row) => {
    if (!row.priced || row.valueUsd === null) return row;
    const value = Number(row.valueUsd);
    if (!Number.isFinite(value) || Math.abs(value) < IMPLAUSIBLE_ROW_USD) return row;
    suspectCount += 1;
    return { ...row, suspect: true, suspectReason: "value exceeds plausible single-position ceiling" };
  });
  return { rows: flagged, suspectCount };
}

/** Sum priced, non-suspect rows. Returns null when nothing is priced. */
export function knownValue(rows) {
  const values = rows.flatMap((row) => {
    if (row.suspect === true) return [];
    const value = !row.priced || row.valueUsd === null ? Number.NaN : Number(row.valueUsd);
    return Number.isFinite(value) ? [value] : [];
  });
  if (values.length === 0) return null;
  return String(values.reduce((sum, value) => sum + value, 0));
}

/**
 * Largest single-row share of the total.
 *
 * Reported, never acted on: heavy concentration is a normal wallet shape, but a
 * total that is 98% one price should disclose that rather than imply breadth.
 */
export function concentration(rows) {
  const total = Number(knownValue(rows) ?? Number.NaN);
  if (!Number.isFinite(total) || total <= 0) return null;
  const top = rows.reduce((max, row) => {
    if (row.suspect === true || !row.priced || row.valueUsd === null) return max;
    const value = Number(row.valueUsd);
    return Number.isFinite(value) && value > max ? value : max;
  }, 0);
  if (top <= 0) return null;
  const ratio = top / total;
  return { ratio, concentrated: ratio >= CONCENTRATION_WARN_RATIO };
}

/** Cap rows per chain, keeping the most valuable. Cuts are counted, not hidden. */
export function cappedRows(rows, maxPerChain = MAX_ROWS_PER_CHAIN) {
  const byChain = new Map();
  for (const row of rows) {
    const bucket = byChain.get(row.chainId);
    if (bucket) bucket.push(row);
    else byChain.set(row.chainId, [row]);
  }

  const kept = [];
  let truncated = 0;
  for (const bucket of byChain.values()) {
    if (bucket.length <= maxPerChain) {
      kept.push(...bucket);
      continue;
    }
    const ranked = [...bucket].sort((a, b) => {
      if (a.priced !== b.priced) return a.priced ? -1 : 1;
      const left = a.valueUsd === null ? 0 : Number(a.valueUsd);
      const right = b.valueUsd === null ? 0 : Number(b.valueUsd);
      return (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0);
    });
    kept.push(...ranked.slice(0, maxPerChain));
    truncated += bucket.length - maxPerChain;
  }
  return { rows: kept, truncated };
}
