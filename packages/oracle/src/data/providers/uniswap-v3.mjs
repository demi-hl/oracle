// Uniswap V3 QuoterV2 — exact-input quotes via eth_call (no API key).
// Chains: Ethereum, Optimism, BNB, Polygon, Base, Arbitrum, Avalanche, Robinhood. Read-only; never signs or swaps.

import { Interface, getAddress, isAddress } from "ethers";
import { rpcCall } from "./evm-rpc.mjs";
import { attachAutoSlippage, bindAutoSlippageGuardToCall } from "../../auto-slippage.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";

/** @type {Record<number, { quoter: string, weth: string, usdc: string, name: string }>} */
export const UNI_V3_CHAINS = {
  1: {
    name: "ethereum",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  8453: {
    name: "base",
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  42161: {
    name: "arbitrum",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  // Robinhood Chain. Addresses mirror rhbot server/swap.js SWAP_CONFIG (the vetted
  // source) and were re-proved on the live chain before being added here:
  // eth_chainId == 4663, eth_getCode non-empty for every address below, and a real
  // quoteExactInputSingle returned 1 WETH -> 1866.58 USDG at fee 100 (2026-07-31).
  //
  // The router-level price-impact guard is what blocks dead RH V3 shells from being
  // treated as executable routes.
  4663: {
    name: "robinhood",
    quoter: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
    router: "0xcaf681a66d020601342297493863e78c959e5cb2",
    weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    usdc: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  },
  // HyperEVM 999. There is NO canonical Uniswap v3 deployment on this chain, so
  // this entry deliberately carries no quoter/router: callers must name a venue
  // (see UNI_V3_VENUES) and are refused otherwise. Token addresses verified
  // on-chain 2026-08-05 by reading symbol()/decimals() directly:
  //   0x5555...5555 -> "WHYPE" / "Wrapped HYPE", 18
  //   0xB8CE59FC... -> "USD\u20AE0", 6  (the real USDT0; note the Tether glyph)
  // 0xb88339CB... is NOT USDT0 -- it answers symbol() as "USDC" and was an
  // earlier mislabel on my part.
  999: {
    name: "hyperevm",
    weth: "0x5555555555555555555555555555555555555555",
    usdc: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb",
  },
  // Optimism / BNB / Polygon / Avalanche. Official Uniswap v3 deployments,
  // each proved on-chain in the MAD PR #16 lane: eth_getCode non-empty for
  // quoter, router, wrapped-native and stable, plus a decimals-correct quote.
  10: {
    name: "optimism",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  },
  56: {
    name: "bsc",
    quoter: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
    router: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2",
    weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  },
  137: {
    name: "polygon",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    weth: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  },
  43114: {
    name: "avalanche",
    quoter: "0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F",
    router: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE",
    weth: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  },
};

export const UNI_V3_FEE_TIERS = [100, 500, 3000, 10000];

const QUOTER_IFACE = new Interface([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);

const ROUTER_IFACE = new Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)",
]);

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO = "0x0000000000000000000000000000000000000000";

// Uniswap-v3 FORKS that speak the same QuoterV2 + SwapRouter02 ABI but live at
// different addresses on a chain that already has a canonical v3 deployment.
// Keyed chainId -> venue slug. A venue is only listed here after its quoter has
// been proved FUNCTIONALLY (a real quoteExactInputSingle returning a sane,
// decimals-correct amount) -- non-empty bytecode is not evidence, since the
// canonical mainnet quoter address also has code on chains where it prices
// nothing. Algebra-style forks with non-standard fee tiers are deliberately
// absent: they need their own adapter, not this ABI.
/** @type {Record<number, Record<string, { quoter: string, router: string, name: string }>>} */
// PancakeSwap V3 uses 2500 where Uniswap uses 3000, and reverts on 3000.
export const PANCAKE_FEE_TIERS = [100, 500, 2500, 10000];

export const UNI_V3_VENUES = {
  // HyperEVM 999. Proved FUNCTIONALLY on 2026-08-05, not by codesize -- the
  // canonical mainnet quoter address also has bytecode on chains where it prices
  // nothing, so codesize is not evidence.
  // quoteExactInputSingle(0.1 WHYPE -> USD\u20AE0) returned live output on all four
  // fee tiers: 5.7073 (100), 5.7080 (500), 5.6766 (3000), 5.6050 (10000).
  // Best tier implies ~57.08 USD/HYPE against a Hyperliquid mid of 56.98 the same
  // minute -- 0.2% apart, the right shape for a shallow-fee pool plus impact.
  // PancakeSwap V3. Same QuoterV2/SwapRouter addresses on every chain (CREATE2).
  // Proved functionally 2026-08-05 against a live spot control, per chain:
  //   BSC 56       0.1 WBNB  -> 59.9756 USDT  (fee 100)
  //   Base 8453    0.1 WETH  -> 186.9915 USDC (fee 100)
  //   Arbitrum     0.1 WETH  -> 186.9621 USDC (fee 100)
  // Fee 3000 reverts on all three -- PancakeSwap's middle tier is 2500, which is
  // why this entry carries its own feeTiers.
  56: {
    pancakeswap: {
      name: "pancakeswap",
      quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
      router: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
      feeTiers: PANCAKE_FEE_TIERS,
    },
  },
  8453: {
    pancakeswap: {
      name: "pancakeswap",
      quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
      router: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
      feeTiers: PANCAKE_FEE_TIERS,
    },
  },
  42161: {
    pancakeswap: {
      name: "pancakeswap",
      quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
      router: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
      feeTiers: PANCAKE_FEE_TIERS,
    },
  },
  999: {
    hyperswap: {
      name: "hyperswap",
      quoter: "0x03A918028f22D9E1473B7959C927AD7425A45C7C",
      router: "0x4E2960a8cd19B467b82d26D83fAcb0fAE26b094D",
    },
  },
};

/**
 * Resolve the addresses to quote/prepare against.
 * Default (no venue) is the canonical deployment for the chain, so every existing
 * caller keeps its exact behaviour.
 */
function chainMeta(chainId, venue) {
  const id = Number(chainId);
  const m = UNI_V3_CHAINS[id];
  if (!m) {
    throw new Error(
      `uniswap-v3: unsupported chainId ${chainId} (supported: ${Object.keys(UNI_V3_CHAINS).join(", ")})`
    );
  }
  const forksForChain = UNI_V3_VENUES[id] || {};
  if (!venue) {
    // Fail closed rather than quoting against an undefined address.
    if (!m.quoter || !m.router) {
      const known = Object.keys(forksForChain).join(", ") || "none registered";
      throw new Error(
        `uniswap-v3: chain ${id} (${m.name}) has no canonical Uniswap v3 deployment -- name a venue explicitly (known: ${known})`
      );
    }
    return { chainId: id, venue: m.name, ...m };
  }

  const slug = String(venue).toLowerCase();
  if (slug === m.name && m.quoter && m.router) return { chainId: id, venue: m.name, ...m };

  const forks = forksForChain;
  const f = forks[slug];
  if (!f) {
    // Only advertise the chain's own name when it is actually selectable, i.e.
    // when a canonical deployment exists. On venue-required chains it is not.
    const known = [...(m.quoter && m.router ? [m.name] : []), ...Object.keys(forks)].join(", ");
    throw new Error(
      `uniswap-v3: unknown venue "${venue}" on chain ${id} (known: ${known})`
    );
  }
  // Fork entries carry their own quoter/router; token defaults stay chain-level.
  return { chainId: id, venue: slug, ...m, quoter: f.quoter, router: f.router, feeTiers: f.feeTiers || null };
}

function normalizeToken(addr, chainId) {
  const meta = UNI_V3_CHAINS[Number(chainId)];
  if (!addr || addr === NATIVE || addr === ZERO || /^eth$/i.test(String(addr))) {
    return getAddress(meta.weth);
  }
  const s = String(addr);
  if (/^weth$/i.test(s)) return getAddress(meta.weth);
  if (/^usdc$/i.test(s)) return getAddress(meta.usdc);
  if (!isAddress(s)) throw new Error(`invalid token address: ${addr}`);
  return getAddress(s);
}

function encodePath(tokens, fees) {
  // path = token0 (20) + fee (3) + token1 (20) [+ fee + token2 ...]
  if (tokens.length !== fees.length + 1) {
    throw new Error("path: fees.length must be tokens.length - 1");
  }
  let hex = "0x";
  for (let i = 0; i < fees.length; i++) {
    hex += tokens[i].slice(2).toLowerCase();
    hex += Number(fees[i]).toString(16).padStart(6, "0");
  }
  hex += tokens[tokens.length - 1].slice(2).toLowerCase();
  return hex;
}

/**
 * Quote exact-input single hop via QuoterV2.
 * @param {object} q
 * @param {number} q.chainId
 * @param {string} [q.tokenIn] default WETH
 * @param {string} [q.tokenOut] default USDC
 * @param {string|number|bigint} q.amountIn  raw wei/base units
 * @param {number} [q.fee] 100|500|3000|10000 — if omitted, tries tiers best-out
 */
export async function uniV3QuoteExactIn(q = {}, opts = {}) {
  const { chainId, quoter, router, feeTiers } = chainMeta(q.chainId ?? 8453, q.venue);
  const tokenIn = normalizeToken(q.tokenIn || "WETH", chainId);
  const tokenOut = normalizeToken(q.tokenOut || UNI_V3_CHAINS[chainId].usdc, chainId);
  const amountIn = BigInt(q.amountIn ?? 0);
  if (amountIn <= 0n) throw new Error("amountIn required (raw base units)");

  // Fee tiers are venue-specific: PancakeSwap V3 uses 2500 and REVERTS on 3000,
  // so a global tier list would skip its real pools and make a live venue look
  // dead. The single-tier shortcut takes the venue's middle tier, not a constant.
  const venueTiers = feeTiers && feeTiers.length ? feeTiers : UNI_V3_FEE_TIERS;
  const fees =
    q.fee != null
      ? [Number(q.fee)]
      : q.tryFees === false
        ? [venueTiers[Math.min(2, venueTiers.length - 1)]]
        : [...venueTiers];

  const results = [];
  let best = null;

  for (const fee of fees) {
    const data = QUOTER_IFACE.encodeFunctionData("quoteExactInputSingle", [
      {
        tokenIn,
        tokenOut,
        amountIn,
        fee,
        sqrtPriceLimitX96: 0n,
      },
    ]);
    try {
      const raw = await rpcCall(chainId, "eth_call", [{ to: quoter, data }, "latest"], opts);
      if (!raw || raw === "0x") {
        results.push({ fee, ok: false, error: "empty result" });
        continue;
      }
      const decoded = QUOTER_IFACE.decodeFunctionResult("quoteExactInputSingle", raw);
      const row = {
        fee,
        ok: true,
        amountOut: decoded[0].toString(),
        sqrtPriceX96After: decoded[1].toString(),
        initializedTicksCrossed: Number(decoded[2]),
        gasEstimate: decoded[3].toString(),
      };
      results.push(row);
      if (!best || BigInt(row.amountOut) > BigInt(best.amountOut)) best = row;
    } catch (e) {
      results.push({ fee, ok: false, error: String(e.message || e).slice(0, 160) });
    }
  }

  if (!best) {
    const err = results.map((r) => `${r.fee}:${r.error || "fail"}`).join("; ");
    throw new Error(`uniswap-v3 quote failed chain=${chainId}: ${err}`);
  }

  return attachAutoSlippage({
    venue: "uniswap-v3",
    chainId,
    chain: UNI_V3_CHAINS[chainId].name,
    quoter,
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    fee: best.fee,
    amountOut: best.amountOut,
    gasEstimate: best.gasEstimate,
    sqrtPriceX96After: best.sqrtPriceX96After,
    initializedTicksCrossed: best.initializedTicksCrossed,
    triedFees: results,
    best: true,
  }, {
    chainId,
    venue: router,
    amountOut: best.amountOut,
    liquidityUsd: q.liquidityUsd,
    priceChange5m: q.priceChange5m,
    requestedCapBps: q.maxSlippageBps ?? q.slippageBps,
  });
}

/**
 * Multi-hop exact input. pathTokens + pathFees.
 * e.g. tokens [WETH, USDC], fees [500]
 */
export async function uniV3QuoteExactInPath(q = {}, opts = {}) {
  const { chainId, quoter, router } = chainMeta(q.chainId ?? 8453);
  const tokens = (q.tokens || []).map((t) => normalizeToken(t, chainId));
  const fees = (q.fees || []).map(Number);
  if (tokens.length < 2) throw new Error("tokens[] need at least 2 addresses");
  const amountIn = BigInt(q.amountIn ?? 0);
  if (amountIn <= 0n) throw new Error("amountIn required");

  const path = encodePath(tokens, fees);
  const data = QUOTER_IFACE.encodeFunctionData("quoteExactInput", [path, amountIn]);
  const raw = await rpcCall(chainId, "eth_call", [{ to: quoter, data }, "latest"], opts);
  const decoded = QUOTER_IFACE.decodeFunctionResult("quoteExactInput", raw);

  return attachAutoSlippage({
    venue: "uniswap-v3",
    chainId,
    chain: UNI_V3_CHAINS[chainId].name,
    quoter,
    tokens,
    fees,
    path,
    amountIn: amountIn.toString(),
    amountOut: decoded[0].toString(),
    gasEstimate: decoded[3].toString(),
  }, {
    chainId,
    venue: router,
    amountOut: decoded[0].toString(),
    liquidityUsd: q.liquidityUsd,
    priceChange5m: q.priceChange5m,
    requestedCapBps: q.maxSlippageBps ?? q.slippageBps,
  });
}

/** Convenience: WETH → USDC for amountIn wei (default 0.001 ETH). */
export async function uniV3EthUsdc(q = {}, opts = {}) {
  const chainId = Number(q.chainId ?? 8453);
  const amountIn = q.amountIn ?? "1000000000000000"; // 0.001 ether
  const quote = await uniV3QuoteExactIn(
    {
      chainId,
      tokenIn: UNI_V3_CHAINS[chainId].weth,
      tokenOut: UNI_V3_CHAINS[chainId].usdc,
      amountIn,
      fee: q.fee,
    },
    opts
  );
  const usdc = Number(quote.amountOut) / 1e6;
  return { ...quote, amountOutUsdc: usdc, pair: "WETH/USDC" };
}

export async function uniV3PrepareExactIn(q = {}, opts = {}) {
  const chainId = Number(q.chainId ?? 8453);
  const meta = chainMeta(chainId, q.venue);
  const recipient = getAddress(q.recipient);
  const inputRaw = String(q.tokenIn || "WETH");
  const nativeInput = !q.tokenIn || inputRaw === NATIVE || inputRaw === ZERO || /^eth$/i.test(inputRaw);
  const quote = await uniV3QuoteExactIn(q, opts);
  const exact = ROUTER_IFACE.encodeFunctionData("exactInputSingle", [{
    tokenIn: quote.tokenIn,
    tokenOut: quote.tokenOut,
    fee: quote.fee,
    recipient,
    amountIn: BigInt(quote.amountIn),
    amountOutMinimum: BigInt(quote.amountOutMinimum),
    sqrtPriceLimitX96: 0n,
  }]);
  const deadlineWindow = Math.min(600, Math.max(30, Number(q.deadlineSeconds ?? 300)));
  const nowSeconds = Number(opts.nowSeconds ?? Math.floor(Date.now() / 1000));
  const deadline = nowSeconds + deadlineWindow;
  const data = ROUTER_IFACE.encodeFunctionData("multicall", [deadline, [exact]]);
  return stampPrepared({
    provider: "uniswap-v3",
    calldataReady: true,
    // NOT executable authority. The bytes are assembled but nothing is signed:
    // the user's wallet is still the only thing that can authorize this. The
    // previous `executionReady: true` read as "cleared to execute" and trained
    // agents to treat a quote as permission.
    requiresUserSignature: true,
    signingReady: false,
    broadcastReady: false,
    chainId,
    deadline,
    quote,
    autoSlippage: quote.autoSlippage,
    requiresApproval: nativeInput ? null : {
      token: quote.tokenIn,
      spender: meta.router,
      amount: quote.amountIn,
    },
    transaction: {
      chainId,
      from: recipient,
      to: meta.router,
      data,
      value: nativeInput ? quote.amountIn : "0",
      slippageGuard: bindAutoSlippageGuardToCall(quote.autoSlippage, { chainId, venue: meta.router, data }),
    },
  }, { provider: "uniswap-v3", kind: "univ3-swap-tx" });
}

export async function uniV3Health(opts = {}) {
  const chainId = Number(opts.chainId ?? 8453);
  try {
    const q = await uniV3EthUsdc({ chainId, amountIn: "1000000000000000" }, opts);
    return {
      ok: true,
      chainId,
      fee: q.fee,
      amountOutUsdc: q.amountOutUsdc,
      midPxHint: q.amountOutUsdc / 0.001,
    };
  } catch (e) {
    return { ok: false, chainId, error: String(e.message || e).slice(0, 200) };
  }
}

export async function uniV3Chains() {
  return Object.entries(UNI_V3_CHAINS).map(([id, m]) => ({
    chainId: Number(id),
    name: m.name,
    quoter: m.quoter,
    weth: m.weth,
    usdc: m.usdc,
  }));
}
