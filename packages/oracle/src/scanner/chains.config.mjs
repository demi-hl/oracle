// Built-in chain configs.
//
// This file is the "adding a chain is data" claim made concrete. Each entry is pure
// configuration -- no chain-specific code -- and `defineEvmScanner` turns it into a
// working scanner.
//
// To add a chain: append an entry, set the RPC env var, done. If you also want
// routing on it, add verified venues (see CONTRIBUTING for the verification rule:
// bytecode check plus the protocol's own source, recorded per chain).
//
// Venues are intentionally EMPTY here. An address is only useful with provenance,
// and provenance has to be established per chain by whoever adds it. An empty venue
// list means the chain is read/research-capable and fail-closed for routing, which
// is the correct default rather than a gap.

import { defineEvmScanner } from "./evm-scanner.mjs";
import { registerScanner } from "./contract.mjs";

/**
 * `dexscreenerSlug` is DexScreener's own chain identifier, which is not the chain id
 * and not always the obvious name. Omit it when unknown -- pool discovery then
 * reports UNAVAILABLE instead of silently returning another chain's pools.
 */
export const CHAIN_CONFIGS = Object.freeze([
  {
    key: "ethereum",
    chainId: 1,
    name: "Ethereum",
    rpcEnv: ["ETH_RPC_URL", "ETHEREUM_RPC_URL", "MAINNET_RPC_URL"],
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    explorer: "https://etherscan.io",
    dexscreenerSlug: "ethereum",
    venueKind: "uniswap-v3",
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    venues: [
      {
        kind: "quoter",
        address: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        label: "Uniswap V3 QuoterV2",
        verified: {
          method:
            "functional probe, not a codesize check: quoteExactInputSingle returned a " +
            "live sane price (WETH->USDC fee 500 quoted 1908.71 USDC). A contract that correctly prices a known pair " +
            "IS a working V3 quoter",
          source: "scripts/verify-v3-venues.mjs (re-runnable)",
          date: "2026-07-30",
          chainId: 1,
        },
      },
      {
        kind: "router",
        address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        label: "Uniswap V3 SwapRouter02",
        verified: {
          method:
            "eth_getCode returned real bytecode on this chain and the paired quoter " +
            "at the same deployment passed a live functional quote",
          source: "scripts/verify-v3-venues.mjs (re-runnable)",
          date: "2026-07-30",
          chainId: 1,
        },
      },
    ],
  },
  {
    key: "optimism",
    chainId: 10,
    name: "OP Mainnet",
    rpcEnv: ["OPTIMISM_RPC_URL", "OP_RPC_URL"],
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    explorer: "https://optimistic.etherscan.io",
    dexscreenerSlug: "optimism",
    venueKind: "uniswap-v3",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    venues: [
      {
        kind: "quoter",
        address: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        label: "Uniswap V3 QuoterV2",
        verified: {
          method:
            "functional probe, not a codesize check: quoteExactInputSingle returned a " +
            "live sane price (WETH->USDC fee 500 quoted 1905.23 USDC). A contract that correctly prices a known pair " +
            "IS a working V3 quoter",
          source: "scripts/verify-v3-venues.mjs (re-runnable)",
          date: "2026-07-30",
          chainId: 10,
        },
      },
      {
        kind: "router",
        address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        label: "Uniswap V3 SwapRouter02",
        verified: {
          method:
            "eth_getCode returned real bytecode on this chain and the paired quoter " +
            "at the same deployment passed a live functional quote",
          source: "scripts/verify-v3-venues.mjs (re-runnable)",
          date: "2026-07-30",
          chainId: 10,
        },
      },
    ],
  },
  {
    key: "bsc",
    chainId: 56,
    name: "BNB Smart Chain",
    rpcEnv: ["BSC_RPC_URL", "BNB_RPC_URL"],
    nativeCurrency: { symbol: "BNB", decimals: 18 },
    explorer: "https://bscscan.com",
    dexscreenerSlug: "bsc",
    venueKind: "uniswap-v3",
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    venues: [
      {
        kind: "quoter",
        address: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
        label: "Uniswap V3 QuoterV2",
        verified: {
          method:
            "functional probe, not a codesize check: quoteExactInputSingle returned a " +
            "live sane price (WBNB->USDC fee 500 quoted 413.86 USDC). A contract that correctly prices a known pair " +
            "IS a working V3 quoter",
          source: "scripts/verify-v3-venues.mjs (re-runnable)",
          date: "2026-07-30",
          chainId: 56,
        },
      },
      {
        kind: "router",
        address: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2",
        label: "Uniswap V3 SwapRouter02",
        verified: {
          method:
            "eth_getCode returned real bytecode on this chain and the paired quoter " +
            "at the same deployment passed a live functional quote",
          source: "scripts/verify-v3-venues.mjs (re-runnable)",
          date: "2026-07-30",
          chainId: 56,
        },
      },
    ],
  },
  {
    key: "polygon",
    chainId: 137,
    name: "Polygon",
    rpcEnv: ["POLYGON_RPC_URL", "POLYGON_RPC"],
    nativeCurrency: { symbol: "POL", decimals: 18 },
    explorer: "https://polygonscan.com",
    dexscreenerSlug: "polygon",
    venueKind: "uniswap-v3",
    wrappedNative: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    venues: [
      {
        kind: "quoter",
        address: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        label: "Uniswap V3 QuoterV2",
        verified: {
          method:
            "functional probe, not a codesize check: quoteExactInputSingle returned a " +
            "live sane price (WMATIC->USDC fee 500 quoted 0.0720 USDC). A contract that correctly prices a known pair " +
            "IS a working V3 quoter",
          source: "scripts/verify-v3-venues.mjs (re-runnable)",
          date: "2026-07-30",
          chainId: 137,
        },
      },
      {
        kind: "router",
        address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        label: "Uniswap V3 SwapRouter02",
        verified: {
          method:
            "eth_getCode returned real bytecode on this chain and the paired quoter " +
            "at the same deployment passed a live functional quote",
          source: "scripts/verify-v3-venues.mjs (re-runnable)",
          date: "2026-07-30",
          chainId: 137,
        },
      },
    ],
  },
  {
    key: "stable",
    chainId: 988,
    name: "Stable Mainnet",
    rpcEnv: ["STABLE_RPC_URL", "STABLE_RPC"],
    // The stablecoin IS the gas token here, 18 decimals native. The same balance
    // also appears as a 6-decimal ERC-20 mirror -- it is ONE balance, never summed.
    nativeCurrency: { symbol: "USDT0", decimals: 18 },
    venueKind: "uniswap-v3",
    wrappedNative: "0x5d442b349590a6048Eb2dC0eC346cAA5F47A9ab5",
    venues: [
      {
        kind: "quoter",
        address: "0xb070179E7032CdA868b53e6C1742F80c9e940d1A",
        label: "Uniswap V3 QuoterV2 (canonical)",
        verified: {
          method:
            "Stable is on the OFFICIAL Uniswap v3 Deployments List (governance-recognised " +
            "2026-05-12, UAC process completed 2026-04, deployed by Protofire), so this is a " +
            "canonical deployment rather than a fork. eth_getCode returned 8273 bytes, the same " +
            "size as the canonical quoter on the seven already-verified chains. Functional probe " +
            "on a live pool (TOAST -> USDT0, fee 10000): 100 in -> 0.000003, 1000 -> 0.000031, " +
            "10000 -> 0.000319 USDT0. Output scales monotonically with input, which is a working " +
            "quoter answering, not a revert. Two of three sampled pools carry non-zero liquidity. " +
            "NOTE: the pools discovered so far are thin, so real routing size is limited -- the " +
            "venue is proved, deep liquidity is not.",
          source: "scripts/verify-v3-venues.mjs (re-runnable)",
          date: "2026-08-05",
          chainId: 988,
        },
      },
      {
        kind: "router",
        address: "0x32eaf9B5d5F2CD7361c5012890C943D7de84C22a",
        label: "Uniswap SwapRouter02 (canonical)",
        verified: {
          method:
            "eth_getCode returned 24497 bytes. Cross-checked on-chain rather than trusted from " +
            "docs: router.factory() returns 0x88f0a512ef09175d456bc9547f914f48c013e4aa, the same " +
            "v3 core factory that created the pools quoted above, and router.WETH9() returns the " +
            "wrappedNative recorded on this chain entry. Address published in the Stable docs " +
            "DEX reference and the Uniswap deployments list.",
          source: "docs.stable.xyz/en/reference/dexes + on-chain factory()/WETH9() round-trip",
          date: "2026-08-05",
          chainId: 988,
        },
      },
    ],
  },
  {
    key: "hyperevm",
    chainId: 999,
    name: "HyperEVM",
    rpcEnv: ["HYPEREVM_RPC_URL", "HYPER_EVM_RPC"],
    nativeCurrency: { symbol: "HYPE", decimals: 18 },
    dexscreenerSlug: "hyperevm",
    venueKind: "uniswap-v3",
    wrappedNative: "0x5555555555555555555555555555555555555555",
    venues: [
      {
        kind: "quoter",
        address: "0x03A918028f22D9E1473B7959C927AD7425A45C7C",
        label: "HyperSwap V3 QuoterV2",
        verified: {
          method:
            "functional probe, not a codesize check: quoteExactInputSingle(1 WHYPE -> USDT0) " +
            "returned live output on all four fee tiers (100: 57.3385, 500: 57.4187, " +
            "3000: 57.3237, 10000: 56.1963 USDT0). Decimals read on-chain: WHYPE 18, USDT0 6. " +
            "Best tier checked against an INDEPENDENT control the same minute -- Hyperliquid " +
            "allMids put HYPE at 57.3205, so the pool is 0.171% from the perp mid, which is " +
            "the right shape for fee plus impact rather than a wrong contract or a decimals bug.",
          source: "scripts/verify-v3-venues.mjs (re-runnable)",
          date: "2026-08-05",
          chainId: 999,
        },
      },
      {
        kind: "router",
        address: "0x4E2960a8cd19B467b82d26D83fAcb0fAE26b094D",
        label: "HyperSwap V3 SwapRouter",
        verified: {
          method:
            "eth_getCode returned 12070 bytes, and it is the router paired with the quoter " +
            "proved above -- the same pair already shipped in UNI_V3_VENUES[999].hyperswap, " +
            "which is the map the quote/prepare path actually routes through.",
          source: "scripts/verify-v3-venues.mjs (re-runnable)",
          date: "2026-08-05",
          chainId: 999,
        },
      },
    ],
  },
  {
    key: "abstract",
    chainId: 2741,
    name: "Abstract",
    rpcEnv: ["ABSTRACT_RPC_URL", "ABS_RPC_URL"],
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    venueKind: "uniswap-v3",
    wrappedNative: "0x3439153EB7AF838Ad19d56E1571FBD09333C2809",
    venues: [
      {
        kind: "quoter",
        address: "0x728BD3eC25D5EDBafebB84F3d67367Cd9EBC7693",
        label: "Uniswap V3 QuoterV2 (Abstract deployment)",
        verified: {
          method:
            "Abstract is a ZK-stack chain, so CREATE2 addresses differ and the canonical Uniswap " +
            "addresses are NOT valid here -- probing them returns codesize 0, which is what " +
            "previously made this chain look like it had no V3 at all. Found the real deployment " +
            "from live traffic instead: scanned recent Swap(...) logs, took the busiest pool, " +
            "read pool.factory() = 0xa1160e73b63f322ae88cc2d8e700833e71d0b2a1, then enumerated " +
            "that factory's deployer (0xf3d63166F0Ca56C3c1A3508FcE03Ff0Cf3Fb691e) and probed each " +
            "of its 56 contracts with a real quoteExactInputSingle call. Exactly one answered: " +
            "1 WETH -> 1846.475731 USDC.e at fee 500. Independent sanity check: the pool's own " +
            "slot0() spot price is 1873.11 USDC.e per WETH, so the quoter sits ~1.4% below spot, " +
            "the right shape for fee plus price impact on this size.",
          source: "scripts/verify-v3-venues.mjs (re-runnable)",
          date: "2026-08-05",
          chainId: 2741,
        },
      },
      {
        kind: "router",
        address: "0x7712FA47387542819d4E35A23f8116C90C18767C",
        label: "Uniswap SwapRouter02 (Abstract deployment)",
        verified: {
          method:
            "eth_getCode returned 167392 bytes and the runtime contains the exactInputSingle " +
            "selector. router.factory() matches the factory proved above and router.WETH9() " +
            "matches the wrappedNative on this entry. Chosen over its byte-identical twin " +
            "(0xfD6257F4...) because this is the address real users actually route through: it " +
            "appeared as tx.to on live swaps against the WETH/USDC.e pool.",
          source: "on-chain factory()/WETH9() round-trip + live swap tx.to sampling",
          date: "2026-08-05",
          chainId: 2741,
        },
      },
    ],
  },
  {
    key: "robinhood",
    chainId: 4663,
    name: "Robinhood Chain",
    rpcEnv: ["RH_CHAIN_RPC", "ROBINHOOD_RPC_URL"],
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    // DexScreener does index this chain under the slug "robinhood" (verified live
    // 2026-07-31: a CASHCAT search returns pairs tagged chainId "robinhood"). Without
    // the slug, resolvePools reported UNAVAILABLE on every RH token even though the
    // data was there.
    dexscreenerSlug: "robinhood",
    venueKind: "uniswap-v3",
    wrappedNative: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    venues: [
      {
        kind: "quoter",
        address: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
        label: "Uniswap V3 QuoterV2",
        verified: {
          method:
            "functional probe, not a codesize check: quoteExactInputSingle returned a " +
            "live sane price (WETH->USDG fee 100 quoted 1866.58 USDG, and USDG->CASHCAT " +
            "fee 10000 quoted a live amount). A contract that correctly prices known pairs " +
            "IS a working V3 quoter",
          source: "live eth_call against rpc.mainnet.chain.robinhood.com",
          date: "2026-07-31",
          chainId: 4663,
        },
      },
      {
        kind: "router",
        address: "0xcaf681a66d020601342297493863e78c959e5cb2",
        label: "Uniswap V3 SwapRouter02",
        verified: {
          method:
            "eth_getCode returned real bytecode (24497 bytes) on this chain and the paired " +
            "quoter at the same deployment passed a live functional quote",
          source: "live eth_getCode against rpc.mainnet.chain.robinhood.com",
          date: "2026-07-31",
          chainId: 4663,
        },
      },
      {
        kind: "factory",
        address: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
        label: "Uniswap V3 Factory",
        verified: {
          method:
            "eth_getCode returned real bytecode (24535 bytes) and a PoolCreated log scan " +
            "over this factory returned 76 pools in ~9000 recent blocks",
          source: "live eth_getLogs against rpc.mainnet.chain.robinhood.com",
          date: "2026-07-31",
          chainId: 4663,
        },
      },
    ],
  },
  {
    key: "base",
    chainId: 8453,
    name: "Base",
    rpcEnv: ["BASE_RPC_URL"],
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    explorer: "https://basescan.org",
    dexscreenerSlug: "base",
    // Base runs the V3 adapter: its V3 pools carry far deeper liquidity than the V2
    // fork, and the chain-specific quoter is verified below. Worth noting how the
    // address was found -- the CANONICAL mainnet quoter address also returns bytecode
    // on Base (2109 bytes), so a codesize check would have waved through the wrong
    // contract. Only the functional probe distinguished them.
    venueKind: "uniswap-v3",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    venues: [
      {
        kind: "quoter",
        address: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
        label: "Uniswap V3 QuoterV2 (Base)",
        verified: {
          method:
            "functional probe: quoteExactInputSingle returned WETH->USDC at fee 500 " +
            "= 1908.44 USDC, a live sane price. The canonical mainnet quoter address " +
            "also has bytecode on Base but does NOT price this pair, which is exactly " +
            "the false positive a codesize-only check accepts",
          source: "scripts/verify-v3-venues.mjs (re-runnable)",
          date: "2026-07-30",
          chainId: 8453,
        },
      },
      {
        kind: "router",
        address: "0x2626664c2603336E57B271c5C0b26F421741e481",
        label: "Uniswap V3 SwapRouter02 (Base)",
        verified: {
          method:
            "eth_getCode returned real bytecode and the paired Base quoter passed a " +
            "live functional quote",
          source: "scripts/verify-v3-venues.mjs (re-runnable)",
          date: "2026-07-30",
          chainId: 8453,
        },
      },
      {
        // Kept as the V2 reference wiring. Not selected while venueKind is v3, but
        // it documents a verified alternate route and shows both shapes in one place.
        kind: "router-v2",
        address: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
        label: "Uniswap V2 Router02 (Base)",
        verified: {
          method:
            "eth_getCode returned 17891 bytes; live getAmountsOut on WETH->USDC " +
            "round-tripped to 98.75% (2x0.30% fee + impact)",
          source: "https://docs.uniswap.org/contracts/v2/reference/smart-contracts/v2-deployments",
          date: "2026-07-30",
          chainId: 8453,
        },
      },
    ],
  },
  {
    key: "arbitrum",
    chainId: 42161,
    name: "Arbitrum One",
    rpcEnv: ["ARBITRUM_RPC_URL", "ARB_RPC_URL"],
    nativeCurrency: { symbol: "ETH", decimals: 18 },
    explorer: "https://arbiscan.io",
    dexscreenerSlug: "arbitrum",
    venueKind: "uniswap-v3",
    wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    venues: [
      {
        kind: "quoter",
        address: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        label: "Uniswap V3 QuoterV2",
        verified: {
          method:
            "functional probe, not a codesize check: quoteExactInputSingle returned a " +
            "live sane price (WETH->USDC fee 500 quoted 1908.72 USDC). A contract that correctly prices a known pair " +
            "IS a working V3 quoter",
          source: "scripts/verify-v3-venues.mjs (re-runnable)",
          date: "2026-07-30",
          chainId: 42161,
        },
      },
      {
        kind: "router",
        address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        label: "Uniswap V3 SwapRouter02",
        verified: {
          method:
            "eth_getCode returned real bytecode on this chain and the paired quoter " +
            "at the same deployment passed a live functional quote",
          source: "scripts/verify-v3-venues.mjs (re-runnable)",
          date: "2026-07-30",
          chainId: 42161,
        },
      },
    ],
  },
  {
    key: "avalanche",
    chainId: 43114,
    name: "Avalanche C-Chain",
    rpcEnv: ["AVALANCHE_RPC_URL", "AVAX_RPC_URL"],
    nativeCurrency: { symbol: "AVAX", decimals: 18 },
    explorer: "https://snowtrace.io",
    dexscreenerSlug: "avalanche",
    venueKind: "uniswap-v3",
    wrappedNative: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    venues: [
      {
        kind: "quoter",
        address: "0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F",
        label: "Uniswap V3 QuoterV2",
        verified: {
          method:
            "functional probe, not a codesize check: quoteExactInputSingle returned a " +
            "live sane price (WAVAX->USDC fee 500 quoted 6.48 USDC). A contract that correctly prices a known pair " +
            "IS a working V3 quoter",
          source: "scripts/verify-v3-venues.mjs (re-runnable)",
          date: "2026-07-30",
          chainId: 43114,
        },
      },
      {
        kind: "router",
        address: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE",
        label: "Uniswap V3 SwapRouter02",
        verified: {
          method:
            "eth_getCode returned real bytecode on this chain and the paired quoter " +
            "at the same deployment passed a live functional quote",
          source: "scripts/verify-v3-venues.mjs (re-runnable)",
          date: "2026-07-30",
          chainId: 43114,
        },
      },
    ],
  },
]);

/** Register every built-in chain. Idempotent. */
export function registerBuiltinScanners() {
  return CHAIN_CONFIGS.map((c) => registerScanner(defineEvmScanner(c)));
}

/**
 * Register a chain Oracle has never seen.
 *
 * This is the whole point: no code change, no PR to this file required.
 *
 *   registerCustomChain({
 *     key: "mychain", chainId: 7777, name: "My Chain",
 *     rpcEnv: ["MYCHAIN_RPC_URL"],
 *     nativeCurrency: { symbol: "MYC", decimals: 18 },
 *   });
 */
export function registerCustomChain(config) {
  return registerScanner(defineEvmScanner(config));
}
