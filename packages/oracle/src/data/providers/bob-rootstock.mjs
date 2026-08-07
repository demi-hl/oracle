// BOB and Rootstock — the two Bitcoin L2s that speak EVM — via Blockscout v2.
//
// Grouped in one module because they are the same integration: both run a
// Blockscout v2 instance with an identical REST schema, so one code path serves
// both and the only difference is the base URL.
//
//   BOB       chainId 60808  https://explorer.gobob.xyz
//   Rootstock chainId 30     https://rootstock.blockscout.com
//
// Verified live:
//   GET /api/v2/stats                    200  on both
//   GET /api/v2/addresses/{address}      200  on both (coin balance + flags)
//   GET /api/v2/addresses/{a}/token-balances  token holdings
//
// Distinct from the generic `blockscout` provider, which is registered for L1
// and EVM L2 rollups only — these two chains are absent from that map, and
// their Bitcoin-L2 framing is the reason to surface them separately.
//
// Read-only.

import { httpJson } from "../http.mjs";

export const BTC_L2_CHAINS = Object.freeze({
  60808: { name: "bob", label: "BOB (Build on Bitcoin)", url: "https://explorer.gobob.xyz", nativeSymbol: "ETH" },
  30: { name: "rootstock", label: "Rootstock (RSK)", url: "https://rootstock.blockscout.com", nativeSymbol: "RBTC" },
});

const ALIASES = new Map([
  ["bob", 60808],
  ["rootstock", 30],
  ["rsk", 30],
]);

export const BTC_L2_DEFAULT_CHAIN_ID = 60808;

/** Accepts a chainId (60808/30) or a name ("bob"/"rootstock"/"rsk"). */
export function btcL2ChainId(value) {
  if (value == null || value === "") return BTC_L2_DEFAULT_CHAIN_ID;
  const asName = ALIASES.get(String(value).trim().toLowerCase());
  if (asName) return asName;
  const id = Number(value);
  if (!BTC_L2_CHAINS[id]) {
    throw new Error(`bob-rootstock: unsupported chain ${value} (supported: ${Object.keys(BTC_L2_CHAINS).join(", ")} / bob, rootstock)`);
  }
  return id;
}

function baseUrl(chainId, opts = {}) {
  if (opts.baseUrl) return String(opts.baseUrl).replace(/\/$/, "");
  const id = btcL2ChainId(chainId);
  const env = id === 30 ? process.env.ROOTSTOCK_EXPLORER_URL : process.env.BOB_EXPLORER_URL;
  return String(env || BTC_L2_CHAINS[id].url).replace(/\/$/, "");
}

function evmAddress(value, label = "address") {
  const text = String(value || "").trim();
  // Rootstock renders EIP-1191 checksums (chain-id salted), so case is NOT
  // validated here — only shape. Blockscout accepts either casing.
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new Error(`bob-rootstock: ${label} must be a 0x EVM address`);
  return text;
}

function get(chainId, path, opts = {}) {
  return httpJson(`${baseUrl(chainId, opts)}${path.startsWith("/") ? path : `/${path}`}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
}

export async function btcL2Health(opts = {}, args = {}) {
  // Health accepts an optional chain so a sweep can probe either instance;
  // default is BOB.
  let chainId;
  try {
    chainId = btcL2ChainId(args.chainId ?? args.chain ?? opts.chainId);
  } catch (error) {
    return { ok: false, provider: "bob-rootstock", error: String(error?.message || error), exec: false };
  }
  const meta = BTC_L2_CHAINS[chainId];
  try {
    const stats = await get(chainId, "/api/v2/stats", opts);
    return {
      ok: stats?.total_blocks != null || stats?.total_transactions != null,
      provider: "bob-rootstock",
      chainId,
      chain: meta.name,
      baseUrl: baseUrl(chainId, opts),
      totalBlocks: stats?.total_blocks ?? null,
      averageBlockTimeMs: stats?.average_block_time ?? null,
      exec: false,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "bob-rootstock",
      chainId,
      chain: meta.name,
      baseUrl: baseUrl(chainId, opts),
      error: String(error?.message || error),
      exec: false,
    };
  }
}

/** Chain stats for one L2. Pass `chainId: "all"` to fan out across both. */
export async function btcL2Stats(args = {}, opts = {}) {
  const which = args.chainId ?? args.chain;
  if (String(which).trim().toLowerCase() === "all") {
    const ids = Object.keys(BTC_L2_CHAINS).map(Number);
    const rows = await Promise.all(
      ids.map(async (id) => {
        try {
          return await btcL2Stats({ chainId: id }, opts);
        } catch (error) {
          return { provider: "bob-rootstock", chainId: id, chain: BTC_L2_CHAINS[id].name, error: String(error?.message || error) };
        }
      })
    );
    return { provider: "bob-rootstock", chains: rows };
  }
  const chainId = btcL2ChainId(which);
  const meta = BTC_L2_CHAINS[chainId];
  const s = await get(chainId, "/api/v2/stats", opts);
  return {
    provider: "bob-rootstock",
    chainId,
    chain: meta.name,
    label: meta.label,
    nativeSymbol: meta.nativeSymbol,
    // Blockscout reports average_block_time in MILLISECONDS. Emitting seconds
    // too because a 29409 vs 2000 comparison across these two chains is
    // otherwise easy to misread as blocks-per-second.
    averageBlockTimeMs: s.average_block_time ?? null,
    averageBlockTimeSec: s.average_block_time == null ? null : Number(s.average_block_time) / 1000,
    gasPrices: s.gas_prices ?? null,
    gasPriceUpdatedAt: s.gas_price_updated_at ?? null,
    gasUsedToday: s.gas_used_today ?? null,
    coinPrice: s.coin_price ?? null,
    coinPriceChangePct: s.coin_price_change_percentage ?? null,
    marketCap: s.market_cap ?? null,
    tvl: s.tvl ?? null,
    totalBlocks: s.total_blocks ?? null,
    totalAddresses: s.total_addresses ?? null,
    totalTransactions: s.total_transactions ?? null,
    transactionsToday: s.transactions_today ?? null,
    networkUtilizationPct: s.network_utilization_percentage ?? null,
    raw: s,
  };
}

/** Native balance + account flags for an address on either L2. */
export async function btcL2AddressInfo(args = {}, opts = {}) {
  const chainId = btcL2ChainId(args.chainId ?? args.chain);
  const address = evmAddress(args.address || args.addr, "address");
  const meta = BTC_L2_CHAINS[chainId];
  const a = await get(chainId, `/api/v2/addresses/${encodeURIComponent(address)}`, opts);
  return {
    provider: "bob-rootstock",
    chainId,
    chain: meta.name,
    address,
    nativeSymbol: meta.nativeSymbol,
    coinBalanceWei: a.coin_balance == null ? null : String(a.coin_balance),
    coinBalance: a.coin_balance == null ? null : Number(a.coin_balance) / 1e18,
    isContract: a.is_contract ?? null,
    isVerified: a.is_verified ?? null,
    name: a.name ?? null,
    blockNumberBalanceUpdatedAt: a.block_number_balance_updated_at ?? null,
    raw: a,
  };
}

/** ERC-20 token holdings for an address on either L2. */
export async function btcL2TokenBalances(args = {}, opts = {}) {
  const chainId = btcL2ChainId(args.chainId ?? args.chain);
  const address = evmAddress(args.address || args.addr, "address");
  const rows = await get(chainId, `/api/v2/addresses/${encodeURIComponent(address)}/token-balances`, opts);
  const list = Array.isArray(rows) ? rows : [];
  const limit = Math.min(500, Math.max(1, Number(args.limit || list.length || 1)));
  return {
    provider: "bob-rootstock",
    chainId,
    chain: BTC_L2_CHAINS[chainId].name,
    address,
    count: list.length,
    tokens: list.slice(0, limit).map((t) => ({
      symbol: t.token?.symbol ?? null,
      name: t.token?.name ?? null,
      address: t.token?.address ?? t.token?.address_hash ?? null,
      type: t.token?.type ?? null,
      decimals: t.token?.decimals ?? null,
      rawBalance: t.value == null ? null : String(t.value),
      balance:
        t.value == null || t.token?.decimals == null ? null : Number(t.value) / 10 ** Number(t.token.decimals),
      exchangeRate: t.token?.exchange_rate ?? null,
    })),
  };
}
