// Aave V3 public GraphQL API (api.v3.aave.com/graphql) — keyless reads.
//
// Read-only: markets, per-market reserves, supported chains. No key, no
// signing, no broadcast. The Aave app API also exposes tx-building queries
// (supply/borrow/withdraw); this module deliberately never touches them.
//
// Schema notes verified against the live endpoint (2026-08-06):
//   - `markets(request: MarketsRequest!)` where MarketsRequest = { chainIds, user }
//   - `market(request: MarketRequest!)`   where MarketRequest  = { address, chainId, user }
//   - `chains(filter: ChainsFilter!)`     ChainsFilter = MAINNET_ONLY | TESTNET_ONLY | ALL
//   - totalMarketSize / totalAvailableLiquidity are BigDecimal SCALARS (no subfields)
//   - PercentValue  = { raw decimals value formatted }
//   - DecimalValue  = { raw decimals value }
//   - TokenAmount   = { amount: DecimalValue, usd: BigDecimal, usdPerToken: BigDecimal }
// Selecting subfields on a BigDecimal (or `amount` on a DecimalValue) is a
// hard GraphQL error, so the queries below are pinned to the real shapes.

import { httpJson } from "../http.mjs";

export const AAVE_V3_API = "https://api.v3.aave.com/graphql";

/** Aave V3 mainnet deployments, verified live via chains(filter: MAINNET_ONLY). */
export const AAVE_V3_CHAIN_IDS = Object.freeze([
  1, 10, 56, 100, 137, 146, 232, 324, 1088, 1868, 5000, 42161, 42220, 43114, 57073, 59144, 534352,
]);

const endpoint = (o = {}) => o.baseUrl || process.env.AAVE_V3_API_URL || AAVE_V3_API;

async function gql(query, variables, opts = {}) {
  // GraphQL is a POST, so http.mjs will not dedupe or replay it — that is the
  // correct behaviour for a non-idempotent method even though this one is a read.
  const res = await httpJson(endpoint(opts), {
    method: "POST",
    body: { query, variables },
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
  if (res?.errors?.length) {
    throw new Error(`aave-v3: ${res.errors.map((e) => e?.message || String(e)).join("; ")}`);
  }
  return res;
}

const MARKETS_QUERY = `query Markets($request: MarketsRequest!) {
  markets(request: $request) {
    name
    address
    chain { chainId name }
    totalMarketSize
    totalAvailableLiquidity
  }
}`;

const MARKET_RESERVES_QUERY = `query Market($request: MarketRequest!) {
  market(request: $request) {
    name
    address
    chain { chainId name }
    totalMarketSize
    totalAvailableLiquidity
    reserves {
      underlyingToken { symbol address decimals }
      isFrozen
      isPaused
      flashLoanEnabled
      size { amount { value } usd }
      supplyInfo {
        apy { value formatted }
        total { value }
        supplyCap { amount { value } usd }
        supplyCapReached
        canBeCollateral
        maxLTV { value }
        liquidationThreshold { value }
      }
      borrowInfo {
        apy { value formatted }
        total { amount { value } usd }
        availableLiquidity { amount { value } usd }
        utilizationRate { value }
        borrowCap { amount { value } usd }
        borrowCapReached
        reserveFactor { value }
      }
    }
  }
}`;

const CHAINS_QUERY = `query Chains($filter: ChainsFilter!) {
  chains(filter: $filter) { chainId name isTestnet explorerUrl }
}`;

function chainIdList(args = {}) {
  const raw = args.chainIds ?? (args.chainId != null ? [args.chainId] : null);
  const ids = (Array.isArray(raw) ? raw : [raw ?? 1])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) throw new Error("aave-v3: chainIds must contain at least one chain id");
  return [...new Set(ids)];
}

/** List Aave V3 markets across one or more chains. */
export async function aaveMarkets(args = {}, opts = {}) {
  const request = { chainIds: chainIdList(args) };
  if (args.user) request.user = String(args.user);
  const res = await gql(MARKETS_QUERY, { request }, opts);
  return { markets: res?.data?.markets ?? [] };
}

/** Full reserve detail for ONE market (pool address + chain). */
export async function aaveMarketReserves(args = {}, opts = {}) {
  const address = String(args.address || args.market || args.marketAddress || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error("aave-v3: marketReserves requires an EVM market (pool) address");
  }
  const chainId = Number(args.chainId ?? 1);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error("aave-v3: chainId must be a positive integer");
  const request = { address, chainId };
  if (args.user) request.user = String(args.user);
  const res = await gql(MARKET_RESERVES_QUERY, { request }, opts);
  const market = res?.data?.market ?? null;
  if (!market) throw new Error(`aave-v3: no market at ${address} on chain ${chainId}`);
  return { market };
}

/** Chains Aave V3 is deployed on. filter: MAINNET_ONLY (default) | TESTNET_ONLY | ALL */
export async function aaveChains(args = {}, opts = {}) {
  const allowed = new Set(["MAINNET_ONLY", "TESTNET_ONLY", "ALL"]);
  const filter = String(args.filter || "MAINNET_ONLY").toUpperCase();
  if (!allowed.has(filter)) throw new Error(`aave-v3: filter must be one of ${[...allowed].join(", ")}`);
  const res = await gql(CHAINS_QUERY, { filter }, opts);
  return { chains: res?.data?.chains ?? [] };
}

export async function aaveHealth(opts = {}) {
  // The schema exposes a first-class `health: Boolean` — cheapest possible probe.
  const res = await gql("query { health }", {}, opts);
  return { ok: res?.data?.health === true, provider: "aave-v3" };
}
