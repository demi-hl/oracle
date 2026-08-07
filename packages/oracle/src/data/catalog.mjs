// Provider catalog — DATA plane registry. Wallet keys never live here.

import { UNI_V3_CHAINS } from "./providers/uniswap-v3.mjs";
import { UNI_V4_CHAINS } from "./providers/uniswap-v4.mjs";

/** @typedef {{ id: string, venue: string, chainIds: number[], auth: 'none'|'apiKey'|'agentKey', ops: string[], baseEnv?: string[], description?: string }} ProviderMeta */

const REGISTRY = new Map();
const UNI_V3_CHAIN_IDS = Object.keys(UNI_V3_CHAINS).map(Number);
const UNI_V4_CHAIN_IDS = Object.keys(UNI_V4_CHAINS).map(Number);
const BUILTIN_PROVIDER_IDS = new Set();
let BUILTINS_LOCKED = false;

export function registerProvider(meta) {
  if (!meta?.id) throw new Error("registerProvider requires id");
  if (!meta.venue) throw new Error("registerProvider requires venue");
  if (!Array.isArray(meta.ops)) throw new Error("registerProvider requires ops[]");
  const id = String(meta.id);
  if (BUILTINS_LOCKED && BUILTIN_PROVIDER_IDS.has(id)) {
    throw new Error(`registerProvider refuses to overwrite built-in provider: ${id}`);
  }
  REGISTRY.set(id, {
    chainIds: meta.chainIds || [],
    auth: meta.auth || "none",
    description: meta.description || "",
    baseEnv: meta.baseEnv || [],
    ...meta,
    id,
  });
  return REGISTRY.get(id);
}

export function getProvider(id) {
  return REGISTRY.get(id) || null;
}

export function listProviders({ venue, op } = {}) {
  let all = [...REGISTRY.values()];
  if (venue) all = all.filter((p) => p.venue === venue);
  if (op) all = all.filter((p) => p.ops.includes(op));
  return all;
}

export function clearProvidersForTest() {
  REGISTRY.clear();
}

function lockBuiltinProviders() {
  BUILTIN_PROVIDER_IDS.clear();
  for (const id of REGISTRY.keys()) BUILTIN_PROVIDER_IDS.add(id);
  BUILTINS_LOCKED = true;
}

// ── Built-in providers ──────────────────────────────────────────────────────

registerProvider({
  id: "hl-info",
  venue: "hl",
  chainIds: [],
  auth: "none",
  ops: [
    "health",
    "allMids",
    "l2Book",
    "outcomeMeta",
    "clearinghouse",
    "userFills",
    "meta",
    "metaAndAssetCtxs",
    "candleSnapshot",
    "openOrders",
    "frontendOpenOrders",
    "userState",
    "spotMeta",
  ],
  baseEnv: ["HL_INFO_URL", "HL_API_URL"],
  description: "Hyperliquid public /info",
});

registerProvider({
  id: "protocol-templates",
  venue: "protocol-builder",
  chainIds: [],
  auth: "none",
  ops: ["health", "list", "gate", "prepareDeploy"],
  description: "Gated Safe* Solidity templates: forge test required before unsigned deploy prepare. NOT a firm audit.",
});

registerProvider({
  id: "poly-public",
  venue: "poly",
  chainIds: [137],
  auth: "none",
  ops: ["health", "time", "markets", "book", "midpoint", "spread", "price", "events"],
  baseEnv: ["POLY_CLOB_URL", "POLY_GAMMA_URL"],
  description: "Polymarket CLOB + Gamma public REST",
});

registerProvider({
  id: "rh-agent",
  venue: "rh",
  chainIds: [4663, 1],
  auth: "none",
  ops: [
    "health",
    "policy",
    "chainConfig",
    "chainGas",
    "swapsConfig",
    "swapsPresets",
    "tradingStatus",
    "nftDrops",
    "feeEstimate",
  ],
  baseEnv: ["RH_AGENT_BASE_URL", "RH_AGENT_URL"],
  description: "RH agent local HTTP (unauthenticated read routes)",
});

registerProvider({
  id: "portfolio",
  venue: "multichain-wallet",
  chainIds: [1, 10, 56, 137, 988, 999, 2741, 4663, 8453, 42161, 43114],
  auth: "none",
  ops: ["health", "balances", "snapshot", "history", "valueGraph"],
  execution: "read-only",
  description:
    "Read-only balance aggregation across configured EVM chains, Solana, Bitcoin, and Hyperliquid, plus profile-local observation snapshots, history, and value graphs with explicit partial coverage.",
});

registerProvider({
  id: "nft-portfolio",
  venue: "multichain-nft-wallet",
  chainIds: [1, 10, 137, 988, 999, 2741, 4663, 8453, 42161, 43114],
  auth: "optionalApiKey",
  ops: ["health", "inventory", "gallery", "pnl", "prepareList"],
  execution: "prepare",
  baseEnv: ["OPENSEA_API_KEY", "MAGICEDEN_API_KEY", "SATFLOW_API_KEY"],
  description:
    "Normalized EVM, Solana, and Bitcoin NFT inventory, static contact-sheet galleries, explicit PnL coverage, and user-confirmed unsigned listing preparation.",
});

registerProvider({
  id: "evm-rpc",
  venue: "evm",
  chainIds: [1, 137, 42161, 8453, 10, 4663, 999],
  auth: "none",
  ops: ["health", "healthAll", "blockNumber", "chainId", "getBalance", "call", "erc20Allowance", "erc20Balance", "transactionReceipt"],
  baseEnv: ["ETH_RPC_URL", "POLYGON_RPC_URL", "RH_CHAIN_RPC", "BASE_RPC_URL", "ARBITRUM_RPC_URL"],
  description: "EVM JSON-RPC multi-chain (env RPC or public fallbacks)",
});

registerProvider({
  id: "solana-rpc",
  venue: "solana",
  chainIds: [],
  auth: "none",
  ops: ["health", "latestBlockhash", "getBalance", "tokenAccounts", "simulate"],
  baseEnv: ["SOLANA_RPC_URL"],
  description: "Solana mainnet JSON-RPC read/prepare surface (no key, no signing, no broadcast)",
});

registerProvider({
  id: "bitcoin-esplora",
  venue: "bitcoin",
  chainIds: [],
  auth: "none",
  ops: ["health", "tipHeight", "fees", "address", "utxos", "tx", "decode"],
  execution: "read-only",
  baseEnv: ["BTC_ESPLORA_URL", "BTC_NETWORK"],
  description:
    "Bitcoin L1 via Esplora (mempool.space/Blockstream). Reads only on data plane. User-signed broadcast is bitcoin_send on exec MCP. No Core RPC, no house keys. Wallets: Xverse/UniSat/Leather/OKX/Phantom",
});

registerProvider({
  id: "bitcoin-meta",
  venue: "bitcoin-metaprotocol",
  chainIds: [],
  auth: "optionalApiKey",
  ops: [
    "health",
    "runeBalances",
    "inscriptions",
    "inscriptionInfo",
    "inscriptionChildren",
    "ordBlockInfo",
  ],
  execution: "read-only",
  baseEnv: ["BTC_META_API_URL", "UNISAT_API_KEY", "BESTINSLOT_API_KEY"],
  description:
    "Bitcoin ordinals/runes reads. Keyless tier via ordinals.com recursive (inscriptionInfo/children/blockInfo); address-indexed ops (inscriptions, runeBalances) need a keyed indexer. Hiro is deprecated (410) and Magic Eden BTC is dead — use satflow for market.",
});

registerProvider({
  id: "satflow",
  venue: "bitcoin-marketplace",
  chainIds: [],
  auth: "apiKey",
  ops: [
    "health",
    "collectionFloors",
    "collectionStats",
    "item",
    "walletContents",
    "floorListings",
    "preparePurchase",
    "prepareList",
  ],
  execution: "prepare",
  baseEnv: ["SATFLOW_API_KEY", "SATFLOW_API_URL"],
  description:
    "Satflow ordinals+runes marketplace (api.satflow.com). Primary BTC NFT market after Magic Eden BTC sunset. PSBT intents for buy/list; key via x-api-key.",
});

registerProvider({
  id: "jupiter",
  venue: "solana-dex",
  chainIds: [],
  auth: "none",
  ops: ["health", "venues", "quote", "prepare"],
  execution: "prepare",
  baseEnv: ["JUPITER_SWAP_API_URL", "SOLANA_RPC_URL"],
  description: "Jupiter Swap API v1 quote + unsigned user-signature swap transaction preparation",
});

registerProvider({
  id: "hl-perps",
  venue: "hyperliquid",
  chainIds: [],
  auth: "none",
  ops: ["health", "assetInfo", "prepareOrder", "prepareCancel", "prepareLeverage", "prepareIsolatedMargin", "prepareBracket"],
  notes: "Hyperliquid perp orders/leverage. PREPARE-ONLY: returns signable actions, never submits.",
});

registerProvider({
  id: "hl-markets",
  venue: "hyperliquid",
  chainIds: [],
  auth: "none",
  ops: ["health", "markets", "leaderboards", "coin", "spot"],
  notes: "Joined Hyperliquid market datapoints for the Hyperliquid agent. Read-only.",
});

registerProvider({
  id: "hl-staking",
  venue: "hypercore-staking",
  chainIds: [],
  auth: "none",
  ops: [
    "health",
    "validators",
    "delegatorSummary",
    "delegations",
    "rewards",
    "history",
    "preflight",
    "prepareStakeDeposit",
    "prepareStakeWithdraw",
    "prepareDelegate",
  ],
  execution: "prepare",
  baseEnv: ["HL_INFO_URL", "HL_EXCHANGE_URL", "HL_TESTNET"],
  description:
    "Hyperliquid HyperCore HYPE staking. Public reads (validators, delegations, rewards) plus EIP-712 prepare for cDeposit / cWithdraw / tokenDelegate. Prepare-only: the user's wallet signs and submits, Oracle never posts to /exchange.",
});

registerProvider({
  id: "magiceden-sol",
  venue: "solana-nft",
  chainIds: [],
  auth: "optionalApiKey",
  ops: ["health", "stats", "listings", "tokenListings", "prepareBuy", "prepareList", "prepareMint"],
  execution: "prepare",
  baseEnv: ["MAGICEDEN_API_KEY", "MAGICEDEN_API_URL"],
  description:
    "Magic Eden Solana NFT market. Reads (stats/listings) are keyless; buy/list/mint instruction builders need MAGICEDEN_API_KEY and return an unsigned base64 transaction for the user's Solana wallet. Never signs or broadcasts.",
});

registerProvider({
  id: "defillama",
  venue: "prices",
  chainIds: [],
  auth: "none",
  ops: ["health", "prices", "pricesBySymbol", "protocols", "yields", "stablecoins", "dexVolumes"],
  baseEnv: ["DEFILLAMA_COINS_URL", "DEFILLAMA_API_URL"],
  description: "DeFiLlama public prices + protocols TVL",
});

registerProvider({
  id: "lifi",
  venue: "dex",
  chainIds: [1, 10, 56, 137, 988, 999, 2741, 4663, 8453, 42161, 43114],
  auth: "none",
  ops: ["health", "quote", "prepare", "chains"],
  execution: "prepare",
  baseEnv: ["LIFI_API_URL"],
  description: "LI.FI public cross-chain / DEX aggregator quotes (no key)",
});

registerProvider({
  id: "dexscreener",
  venue: "dex",
  chainIds: [],
  auth: "none",
  ops: ["health", "token", "search", "pair"],
  baseEnv: ["DEXSCREENER_API_URL"],
  description: "DexScreener public token/pair discovery",
});

registerProvider({
  id: "uniswap-v3",
  venue: "dex",
  chainIds: UNI_V3_CHAIN_IDS,
  auth: "none",
  ops: ["health", "quote", "prepare", "quotePath", "ethUsdc", "chains"],
  execution: "prepare",
  baseEnv: [
    "ETH_RPC_URL",
    "BASE_RPC_URL",
    "ARBITRUM_RPC_URL",
    "OPTIMISM_RPC_URL",
    "BSC_RPC_URL",
    "POLYGON_RPC_URL",
    "AVALANCHE_RPC_URL",
    "RH_CHAIN_RPC",
  ],
  description: "Uniswap V3 QuoterV2 exact-in quotes via eth_call across official deployments plus Robinhood Chain, no key",
});

registerProvider({
  id: "uniswap-v4",
  venue: "dex",
  chainIds: UNI_V4_CHAIN_IDS,
  auth: "none",
  ops: ["health", "quote", "chains"],
  execution: "read-only",
  baseEnv: [
    "ETH_RPC_URL",
    "BASE_RPC_URL",
    "ARBITRUM_RPC_URL",
    "OPTIMISM_RPC_URL",
    "BSC_RPC_URL",
    "POLYGON_RPC_URL",
    "AVALANCHE_RPC_URL",
    "RH_CHAIN_RPC",
  ],
  description:
    "Uniswap V4 Quoter exact-in quotes via eth_call across official deployments plus Robinhood Chain. Quote-only until Universal Router prepare is classified.",
});

registerProvider({
  id: "aerodrome",
  venue: "dex",
  chainIds: [8453],
  auth: "none",
  ops: ["health", "quote", "prepare", "chains"],
  execution: "prepare",
  baseEnv: ["BASE_RPC_URL"],
  description:
    "Aerodrome Slipstream CL on Base — QuoterV2 + SwapRouter exact-input via eth_call (tickSpacing, no key)",
});

registerProvider({
  id: "zerox",
  venue: "dex",
  chainIds: [1, 10, 137, 8453, 42161],
  auth: "apiKey",
  ops: ["health", "price", "quote", "prepare"],
  execution: "prepare",
  baseEnv: ["ZEROX_API_KEY", "ZEROX_API_URL"],
  description:
    "0x Swap API v2 price/quote/prepare — requires ZEROX_API_KEY (unconfigured without key; no Oracle key shipped)",
});

registerProvider({
  id: "across",
  venue: "bridge",
  chainIds: [1, 10, 137, 42161, 8453],
  auth: "none",
  ops: ["health", "suggestedFees"],
  baseEnv: ["ACROSS_API_URL"],
  description: "Across bridge suggested-fees (public)",
});

registerProvider({
  id: "hop",
  venue: "bridge",
  chainIds: [1, 10, 137, 42161],
  auth: "none",
  ops: ["health", "quote"],
  baseEnv: ["HOP_API_URL"],
  description: "Hop Protocol bridge quotes (public)",
});

registerProvider({
  id: "relay",
  venue: "bridge",
  chainIds: [1, 10, 137, 8453, 42161],
  auth: "none",
  ops: ["health", "quote", "prepare"],
  execution: "prepare",
  baseEnv: ["RELAY_API_URL"],
  description: "Relay.link bridge/swap quotes (public)",
});

registerProvider({
  id: "cowswap",
  venue: "dex",
  chainIds: [1, 100, 42161, 8453],
  auth: "none",
  ops: ["health", "quote", "prepareOrder", "order", "status", "chains"],
  execution: "intent",
  baseEnv: [],
  description: "CowSwap batch auction quotes + guarded EIP-712 order intents (public)",
});

registerProvider({
  id: "oneinch",
  venue: "dex",
  chainIds: [1, 10, 137, 8453, 42161],
  auth: "apiKey",
  ops: ["health", "quote", "prepare", "approveSpender"],
  execution: "prepare",
  baseEnv: ["ONEINCH_API_KEY", "ONEINCH_API_URL"],
  description:
    "1inch Swap API v6 quote/prepare — requires ONEINCH_API_KEY (unconfigured without key; no Oracle key shipped)",
});

registerProvider({
  id: "hl-ws",
  venue: "hl",
  chainIds: [],
  auth: "none",
  ops: ["health", "allMids", "l2Book", "snapshot"],
  baseEnv: ["HL_WS_URL"],
  description: "Hyperliquid short-lived WS snapshots (allMids/l2Book)",
});

registerProvider({
  id: "poly-ws",
  venue: "poly",
  chainIds: [137],
  auth: "none",
  ops: ["health", "book", "snapshot"],
  baseEnv: ["POLY_WS_URL"],
  description: "Polymarket CLOB short-lived WS market snapshots",
});

registerProvider({
  id: "opensea-nft",
  venue: "nft",
  chainIds: [1, 10, 137, 988, 999, 2741, 4663, 8453, 42161, 43114],
  auth: "apiKey",
  ops: ["health", "collection", "floor", "accountNfts", "accountPnl", "prepareList"],
  execution: "prepare",
  baseEnv: ["OPENSEA_API_KEY", "OPENSEA_ENV_FILE"],
  description: "OpenSea multichain NFT inventory, estimated values, indexed account PnL, collection floors, and unsigned listing actions",
});

registerProvider({
  id: "hyperevm-dex",
  venue: "hyperevm",
  chainIds: [999],
  auth: "none",
  ops: ["health", "search", "token"],
  baseEnv: ["HYPEREVM_RPC_URL"],
  description: "HyperEVM pair discovery via DexScreener + optional RPC",
});

registerProvider({
  id: "geckoterminal",
  venue: "dex-data",
  chainIds: [],
  auth: "none",
  ops: ["health", "networks", "pool", "token", "ohlcv"],
  baseEnv: ["GECKOTERMINAL_API_URL"],
  description: "GeckoTerminal public networks, pools, tokens, and OHLCV",
});

registerProvider({
  id: "curve",
  venue: "dex",
  chainIds: [1, 10, 56, 137, 988, 999, 4663, 8453, 42161, 43114],
  auth: "none",
  ops: ["health", "openapi", "pools", "quote", "prepare"],
  execution: "prepare",
  baseEnv: ["CURVE_API_URL"],
  description: "Curve public pool registry API + RouterNG validated single-hop prepare",
});

registerProvider({
  id: "gmx",
  venue: "perps-data",
  chainIds: [42161, 43114],
  auth: "none",
  ops: ["health", "tickers", "markets", "marketsInfo", "tokens", "prepareOrder", "positions", "orderStatus", "verifyOrder"],
  execution: "intent",
  baseEnv: [],
  description: "GMX v2 public oracle/markets plus guarded async order intents on Arbitrum and Avalanche",
});

registerProvider({
  id: "morpho",
  venue: "lending-data",
  chainIds: [1, 10, 137, 2741, 8453, 42161, 4663, 999, 988],
  auth: "none",
  ops: ["health", "markets", "vaults", "prepareVault"],
  execution: "intent",
  baseEnv: ["MORPHO_API_URL"],
  description: "Morpho public GraphQL markets/vaults + guarded ERC-4626 vault intents",
});

registerProvider({
  id: "balancer",
  venue: "dex",
  chainIds: [1, 10, 137, 42161, 43114, 8453],
  auth: "none",
  ops: ["health", "pools", "quote", "prepare"],
  execution: "prepare",
  baseEnv: ["BALANCER_API_URL"],
  description: "Balancer public GraphQL pool data + v3 Router exact-input prepare (Polygon read-only)",
});

registerProvider({
  id: "pendle",
  venue: "yield",
  chainIds: [1, 10, 56, 8453, 42161, 999],
  auth: "none",
  ops: ["health", "markets", "quote", "prepare"],
  execution: "prepare",
  baseEnv: ["PENDLE_API_URL"],
  description: "Pendle public yield-market API + Hosted SDK direct Convert prepare",
});

registerProvider({
  id: "odos",
  venue: "dex",
  chainIds: [1, 10, 56, 137, 8453, 42161, 43114, 4663],
  auth: "none",
  ops: ["health", "chains", "quote", "prepare"],
  // Tier is the honest signal here: the API returns HTTP 410 Gone as of
  // 2026-07-30, so it can no longer read or prepare anything. Leaving it as
  // "prepare" would advertise a capability that is provably dead.
  execution: "unavailable",
  deprecated: {
    since: "2026-07-30",
    reason: "Odos sunset the public SOR API; /sor/quote/v2 and v3 both return 410 Gone",
    evidence: "sunset: Thu, 30 Jul 2026 12:00:00 GMT response header",
  },
  baseEnv: ["ODOS_API_URL"],
  description: "Odos public SOR (DEPRECATED upstream 2026-07-30 -- endpoint returns 410)",
});

registerProvider({
  id: "blockscout",
  venue: "explorer",
  chainIds: [1, 10, 137, 8453, 42161],
  auth: "none",
  ops: ["health", "stats", "address", "token"],
  baseEnv: [],
  description: "Verified public Blockscout REST v2 instances",
});

registerProvider({
  id: "paraswap",
  venue: "dex",
  chainIds: [1, 10, 56, 137, 8453, 42161, 43114, 4663],
  auth: "none",
  ops: ["health", "tokens", "price", "quote", "prepare"],
  execution: "prepare",
  baseEnv: ["PARASWAP_API_URL"],
  description: "ParaSwap/Velora public price routes + validated transaction builder",
});

registerProvider({
  id: "rfq",
  venue: "intent-rfq",
  chainIds: [1, 10, 56, 137, 8453, 42161, 43114, 4663],
  auth: "none",
  ops: ["health", "intent", "quote"],
  execution: "prepare",
  baseEnv: ["ZEROX_API_KEY", "ONEINCH_API_KEY"],
  description: "Cross-chain RFQ intent normalizer and firm-quote fanout over reviewed venues. Prepares artifacts only, never signs or broadcasts.",
});

lockBuiltinProviders();

registerProvider({
  id: "polygon-staking",
  venue: "polygon-staking",
  chainIds: [137],
  auth: "none",
  ops: ["health", "validators", "validatorDetail"],
  baseEnv: ["POLYGON_STAKING_API_URL"],
  description: "Polygon POS staking validators",
});
registerProvider({
  id: "babylon-staking",
  venue: "btc-staking",
  chainIds: [],
  auth: "none",
  ops: ["health", "stats", "finalityProviders", "delegations"],
  execution: "read-only",
  baseEnv: ["BABYLON_STAKING_API_URL"],
  description:
    "Babylon native BTC staking (staking-api.babylonlabs.io v2). Keyless per-staker positions from a PUBLIC key alone — APR, TVL, finality-provider roster, and delegations. Read-only; staking/unbonding is user-wallet.",
});
registerProvider({
  id: "mempool-mining",
  venue: "btc-mining",
  chainIds: [],
  auth: "none",
  ops: ["health", "difficulty", "poolShare", "hashrate", "rewardStats"],
  execution: "read-only",
  baseEnv: ["MEMPOOL_API_URL"],
  description:
    "Bitcoin mining + network security telemetry via mempool.space /api/v1/mining. Difficulty retarget, pool concentration (top-1/top-3 share), hashrate trend, subsidy-vs-fee split.",
});
registerProvider({
  id: "liquid-esplora",
  venue: "liquid",
  chainIds: [],
  auth: "none",
  ops: ["health", "tipHeight", "addressInfo", "assetInfo"],
  execution: "read-only",
  baseEnv: ["LIQUID_ESPLORA_URL"],
  description:
    "Liquid Network (Blockstream sidechain) via Esplora. Same schema as bitcoin-esplora plus multi-asset issuance/peg stats. Confidential addresses return TXO counts only — amounts are blinded on chain and reported as such.",
});
registerProvider({
  id: "hiro-stacks",
  venue: "stacks",
  chainIds: [],
  auth: "none",
  ops: ["health", "networkInfo", "stackingInfo", "poxCycles", "blocks"],
  execution: "read-only",
  baseEnv: ["HIRO_API_URL", "HIRO_API_KEY"],
  description:
    "Stacks (Bitcoin L2) via Hiro public API. Network tip, PoX stacking state (the BTC-yield mechanism), and historical reward cycles. Keyless tier is ~20 rps; HIRO_API_KEY is optional and never required.",
});
registerProvider({
  id: "ordinals-runes",
  venue: "btc-runes",
  chainIds: [],
  auth: "none",
  ops: ["health", "blockHeight", "blockInfo", "satInfo", "runeInfo"],
  execution: "read-only",
  baseEnv: ["ORDINALS_BASE_URL"],
  description:
    "Runes + sat/block index via a public ord server (ordinals.com). /r/blockheight is PLAIN TEXT; the /runes listing is 406 'JSON API disabled' so only per-rune lookup exists; rune names must drop the bullet spacer (UNCOMMONGOODS).",
});
registerProvider({
  id: "mempool-lightning",
  venue: "btc-lightning",
  chainIds: [],
  auth: "none",
  ops: ["health", "statistics", "nodeRankings", "nodeCountries"],
  execution: "read-only",
  baseEnv: ["MEMPOOL_API_URL"],
  description:
    "Lightning Network topology via mempool.space. Capacity/channel/node aggregates, node rankings, country distribution. STALE-PRONE: the crawler snapshot has been observed weeks behind, so every response carries ageDays + a stale flag.",
});
registerProvider({
  id: "bob-rootstock",
  venue: "btc-l2",
  chainIds: [60808, 30],
  auth: "none",
  ops: ["health", "stats", "addressInfo", "tokenBalances"],
  execution: "read-only",
  baseEnv: ["BOB_EXPLORER_URL", "ROOTSTOCK_EXPLORER_URL"],
  description:
    "BOB (60808) and Rootstock (30) — the EVM Bitcoin L2s — via their Blockscout v2 instances (identical schema, one code path). Chain stats, gas prices, native balances, token holdings. Pass chainId 'all' to fan out.",
});
registerProvider({
  id: "bisq-markets",
  venue: "bisq",
  chainIds: [],
  auth: "none",
  ops: ["health", "markets", "ticker", "trades"],
  execution: "read-only",
  baseEnv: ["BISQ_MARKETS_URL"],
  description:
    "Bisq non-KYC P2P BTC price discovery (markets.bisq.network). Value is the BASIS against centralized spot, not the absolute print: volume is thin and the last trade can be hours old, so trade age is always reported.",
});
registerProvider({
  id: "magiceden-ordinals",
  venue: "btc-ordinals-market",
  chainIds: [],
  auth: "none",
  ops: ["health", "collectionStat"],
  execution: "read-only",
  baseEnv: ["MAGICEDEN_ORD_API_URL", "MAGICEDEN_API_KEY", "MAGICEDEN_PROBE_COLLECTION"],
  description:
    "Magic Eden ordinals collection stats. DEGRADED UPSTREAM: /v2/ord/btc/* returned 503 'no healthy upstream' on every verification attempt. health() reports ok:false while it is down and collectionStat() returns upstreamDown:true with fallback 'satflow' instead of throwing. Only /stat is wired; 600 req/min documented.",
});
registerProvider({
  id: "braiins-insights",
  venue: "btc-mining",
  chainIds: [],
  auth: "none",
  ops: ["health", "priceStats", "poolStats"],
  execution: "read-only",
  baseEnv: ["BRAIINS_INSIGHTS_URL"],
  description:
    "Braiins mining insights — BTC price tick + per-pool block/hashrate distribution. Use insights.braiins.com (302s to learn.braiins.com, followed transparently); pool.braiins.com/api is 403 and is NOT the public API.",
});
registerProvider({
  id: "pyth-price-feeds",
  venue: "solana-oracle",
  chainIds: [],
  auth: "none",
  ops: ["health", "latestPrice", "latestPrices", "feedDirectory"],
  baseEnv: ["PYTH_HERMES_URL"],
  description: "Pyth Network: Solana price feeds with confidence intervals, real-time updates, zero auth",
});
registerProvider({
  id: "solend-lending",
  venue: "solana-lending",
  chainIds: [],
  auth: "none",
  ops: ["health", "markets", "reserves"],
  baseEnv: ["SAVE_API_URL"],
  description: "Solend/Save lending: markets + per-reserve supply/borrow APY, Solana's Aave equivalent (keyless)",
});
registerProvider({
  id: "jito-mev",
  venue: "solana-mev",
  chainIds: [],
  auth: "none",
  ops: ["health", "recentBundles", "tipFloor"],
  baseEnv: ["JITO_API_URL"],
  description: "Jito MEV: recent bundles, tippers, tip floor — real-time Solana MEV data (keyless)",
});
registerProvider({
  id: "sanctum-lst",
  venue: "solana-staking",
  chainIds: [],
  auth: "none",
  ops: ["health", "lstList", "apyAll", "apyIndividual"],
  baseEnv: ["SANCTUM_API_URL"],
  description: "Sanctum LST: liquid staking tokens with per-token APY — JitoSOL, mSOL, bSOL, compSOL, pathSOL, etc. (keyless)",
});
registerProvider({
  id: "kamino-strategies",
  venue: "solana-yield",
  chainIds: [],
  auth: "none",
  ops: ["health", "strategies", "strategyMetrics"],
  baseEnv: ["KAMINO_API_URL"],
  description: "Kamino: live yield strategies with APY, TVL, vault balances (keyless)",
});
registerProvider({
  id: "meteora-dlmm",
  venue: "solana-dex",
  chainIds: [],
  auth: "none",
  ops: ["health", "pools", "poolSearch"],
  baseEnv: ["METEORA_API_URL"],
  description: "Meteora DLMM: concentrated liquidity pools via amm-v2 API, distinct from Jupiter DEX routes (keyless)",
});
registerProvider({
  id: "aave-v3",
  venue: "evm-lending",
  chainIds: [1, 10, 56, 137, 59144, 1088, 534352, 8453, 42161, 43114, 5000, 1868],
  auth: "none",
  ops: ["health", "markets", "marketReserves", "chains"],
  baseEnv: ["AAVE_V3_API_URL"],
  description: "Aave V3 GraphQL: multi-chain lending, full market + reserve schema with supplyInfo/borrowInfo (keyless)",
});
registerProvider({
  id: "cow-protocol",
  venue: "evm-intent",
  chainIds: [1, 100, 42161],
  auth: "none",
  ops: ["health", "auction", "openOrders", "recentTrades"],
  baseEnv: ["COW_API_URL"],
  description: "CoW Protocol: intent/solver auction data, open orders, trades — intent-based DEX not covered by existing providers (keyless)",
});
registerProvider({
  id: "relayscan-mev",
  venue: "evm-mev",
  chainIds: [1],
  auth: "none",
  ops: ["health", "overview", "builderProfit", "dailyStats"],
  baseEnv: ["RELAYSCAN_API_URL"],
  description: "Relayscan: MEV relay overview, builder profit rankings, daily block stats (keyless)",
});
registerProvider({
  id: "birdeye-tokens",
  venue: "solana-tokens",
  chainIds: [],
  auth: "none",
  ops: ["health", "tokenList"],
  baseEnv: ["BIRDEYE_API_URL"],
  description: "Birdeye public token list: Solana tokens ranked by 24h volume, market cap (keyless)",
});
registerProvider({
  id: "das-assets",
  venue: "solana-nft",
  chainIds: [],
  auth: "none",
  ops: ["health", "assetsByOwner", "searchAssets", "assetProof"],
  baseEnv: ["SOLANA_RPC_URL"],
  description: "Digital Asset Standard (DAS): compressed NFT reads via public Solana RPC — getAssetsByOwner, searchAssets, assetProof. No Helius key needed.",
});
registerProvider({
  id: "symbiotic-restaking",
  venue: "evm-restaking",
  chainIds: [1],
  auth: "none",
  ops: ["health", "vaults", "vaultDetail"],
  baseEnv: ["SYMBIOTIC_API_URL"],
  description: "Symbiotic restaking: vaults with collateral data, approved status, operator metadata (keyless)",
});
registerProvider({
  id: "beefy-yields",
  venue: "evm-yield",
  chainIds: [1, 10, 56, 137, 8453, 42161, 43114, 250, 1088],
  auth: "none",
  ops: ["health", "apy", "apyBreakdown"],
  baseEnv: ["BEEFY_API_URL"],
  description: "Beefy Finance: cross-chain yield aggregator vaults with APY breakdowns (keyless)",
});
registerProvider({
  id: "across-bridge",
  venue: "evm-bridge",
  chainIds: [1, 10, 42161, 8453, 324, 59144],
  auth: "none",
  ops: ["health", "pools", "suggestedFees"],
  baseEnv: ["ACROSS_API_URL"],
  description: "Across bridge: pool liquidity + APY per bridge pool with suggested fees (keyless)",
});
registerProvider({
  id: "spark-lend",
  venue: "evm-lending",
  chainIds: [1],
  auth: "none",
  ops: ["health", "markets"],
  baseEnv: ["SPARK_API_URL"],
  description: "Spark Lend / Sky Savings: ERC-4626 vault APY + TVL + user count (keyless)",
});
registerProvider({
  id: "l2beat-tvl",
  venue: "evm-l2",
  chainIds: [],
  auth: "none",
  ops: ["health", "tvl", "activity"],
  baseEnv: ["L2BEAT_API_URL"],
  description: "L2Beat: L2 scaling TVL, project-level breakdowns, activity metrics (keyless)",
});
registerProvider({
  id: "celestia-da",
  venue: "evm-da",
  chainIds: [],
  auth: "none",
  ops: ["health", "stats", "blockStats"],
  baseEnv: ["CELENIUM_API_URL"],
  description: "Celestia DA via Celenium: blob stats, block-level blob counts, network metrics (keyless)",
});
