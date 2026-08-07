// Uniswap V4 Quoter — multi-chain prepare-only quotes via eth_call.
//
// Cross-chain by design. Addresses are the official Uniswap V4 deployments
// (docs.uniswap.org/contracts/v4/deployments, scraped 2026-08-02) plus the
// Robinhood Chain deployment that the RH SQUEEZE book already proved live.
//
// WHY THIS EXISTS: a V3 factory quote can return a real, on-chain, DEAD shell
// while the live book sits on V4. Verified on Robinhood 2026-08-02 with SQUEEZE
// (V3 ~$7, V4 ~$471k). The impact ceiling blocks garbage V3 fills; this module
// is the source that can actually price the live book.
//
// Scope:
//   * quoteExactInputSingle against V4Quoter
//   * poolId derivation (keccak of PoolKey) for identity checks
//   * catalog/list exposure
//   * prepare exact-input single-hop Universal Router calldata when recipient
//     and slippage are explicit; the fresh successful quote supplies PoolKey
//
// Never signs. Never broadcasts.

import { AbiCoder, Interface, getAddress, isAddress, keccak256 } from "ethers";
import { rpcCall } from "./evm-rpc.mjs";
import { attachAutoSlippage } from "../../auto-slippage.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";

const abi = AbiCoder.defaultAbiCoder();
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Official Uniswap V4 deployments + RH.
 * Source: Uniswap docs V4 deployments page (2026-08-02) and RH squeeze-v4 worktree.
 * Only chains Oracle already routes are listed here.
 *
 * @type {Record<number, {
 *   name: string,
 *   poolManager: string,
 *   quoter: string,
 *   stateView?: string,
 *   universalRouter?: string,
 *   weth: string,
 *   usdc: string,
 * }>}
 */
export const UNI_V4_CHAINS = {
  1: {
    name: "ethereum",
    poolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
    quoter: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203",
    stateView: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
    universalRouter: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  10: {
    name: "optimism",
    poolManager: "0x9a13f98cb987694c9f086b1f5eb990eea8264ec3",
    quoter: "0x1f3131a13296fb91c90870043742c3cdbff1a8d7",
    stateView: "0xc18a3169788f4f75a170290584eca6395c75ecdb",
    universalRouter: "0x851116d9223fabed8e56c0e6b8ad0c31d98b3507",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  },
  56: {
    name: "bsc",
    poolManager: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
    quoter: "0x9f75dd27d6664c475b90e105573e550ff69437b0",
    stateView: "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4",
    universalRouter: "0x1906c1d672b88cd1b9ac7593301ca990f94eae07",
    weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  },
  137: {
    name: "polygon",
    poolManager: "0x67366782805870060151383f4bbff9dab53e5cd6",
    quoter: "0xb3d5c3dfc3a7aebff71895a7191796bffc2c81b9",
    stateView: "0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a",
    universalRouter: "0x1095692a6237d83c6a72f3f5efedb9a670c49223",
    weth: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  },
  8453: {
    name: "base",
    poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    quoter: "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
    stateView: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
    universalRouter: "0x6ff5693b99212da76ad316178a184ab56d299b43",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  42161: {
    name: "arbitrum",
    poolManager: "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
    quoter: "0x3972c00f7ed4885e145823eb7c655375d275a1c5",
    stateView: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
    universalRouter: "0xa51afafe0263b40edaef0df8781ea9aa03e381a3",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  43114: {
    name: "avalanche",
    poolManager: "0x06380c0e0912312b5150364b9dc4542ba0dbbc85",
    quoter: "0xbe40675bb704506a3c2ccfb762dcfd1e979845c2",
    stateView: "0xc3c9e198c735a4b97e3e683f391ccbdd60b69286",
    universalRouter: "0x94b75331ae8d42c1b61065089b7d48fe14aa73b7",
    weth: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  },
  // Robinhood Chain — V4 is the live book for SQUEEZE and other Doppler launches.
  // PoolManager/Quoter/UniversalRouter proved via V4 Swap/Init log emitters +
  // squeeze-v4 worktree (2026-08-02). usdc slot is USDG, same as V3 adapter.
  4663: {
    name: "robinhood",
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    universalRouter: "0x8876789976dEcBfCbBbe364623C63652db8C0904",
    weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    usdc: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  },
};

// Common V4 fee/tickSpacing pairs. Callers can override with explicit fee+tickSpacing.
export const UNI_V4_FEE_TIERS = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
  // Doppler / RH launch pools often use a 2.5% fee with tickSpacing 8.
  { fee: 25000, tickSpacing: 8 },
];

const QUOTER_IFACE = new Interface([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const UNIVERSAL_ROUTER_IFACE = new Interface([
  "function execute(bytes commands,bytes[] inputs,uint256 deadline) payable",
]);

// Universal Router command/action constants from Commands.sol and Actions.sol.
const V4_SWAP = "0x10";
const V4_ACTIONS = "0x060c0f"; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

function chainMeta(chainId) {
  const id = Number(chainId);
  const m = UNI_V4_CHAINS[id];
  if (!m) {
    throw new Error(
      `uniswap-v4: unsupported chainId ${chainId} (supported: ${Object.keys(UNI_V4_CHAINS).join(", ")})`,
    );
  }
  return { chainId: id, ...m };
}

function normalizeToken(addr, chainId) {
  const meta = UNI_V4_CHAINS[Number(chainId)];
  if (!addr || addr === NATIVE || addr === ZERO || /^eth$/i.test(String(addr))) {
    return getAddress(meta.weth);
  }
  const s = String(addr);
  if (/^weth$/i.test(s)) return getAddress(meta.weth);
  if (/^usdc$/i.test(s) || /^usdg$/i.test(s)) return getAddress(meta.usdc);
  if (!isAddress(s)) throw new Error(`invalid token address: ${addr}`);
  return getAddress(s);
}

/**
 * V4 poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))
 * currency0 must be the lower address. Hooks default to address(0).
 */
export function computeV4PoolId({ currency0, currency1, fee, tickSpacing, hooks = ZERO }) {
  const a = getAddress(currency0);
  const b = getAddress(currency1);
  if (a.toLowerCase() === b.toLowerCase()) throw new Error("poolKey currencies must differ");
  const [c0, c1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  const h = hooks && isAddress(hooks) ? getAddress(hooks) : ZERO;
  return keccak256(abi.encode(
    ["address", "address", "uint24", "int24", "address"],
    [c0, c1, Number(fee), Number(tickSpacing), h],
  ));
}

function buildPoolKey({ tokenIn, tokenOut, fee, tickSpacing, hooks = ZERO }) {
  const a = getAddress(tokenIn);
  const b = getAddress(tokenOut);
  const [currency0, currency1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  const zeroForOne = a.toLowerCase() === currency0.toLowerCase();
  return {
    poolKey: {
      currency0,
      currency1,
      fee: Number(fee),
      tickSpacing: Number(tickSpacing),
      hooks: hooks && isAddress(hooks) ? getAddress(hooks) : ZERO,
    },
    zeroForOne,
  };
}

/**
 * Quote exact-input single hop via V4Quoter.
 *
 * @param {object} q
 * @param {number} q.chainId
 * @param {string} [q.tokenIn]
 * @param {string} [q.tokenOut]
 * @param {string|number|bigint} q.amountIn
 * @param {number} [q.fee]
 * @param {number} [q.tickSpacing]
 * @param {string} [q.hooks]
 * @param {Array<{fee:number,tickSpacing:number}>} [q.tryTiers]
 */
export async function uniV4QuoteExactIn(q = {}, opts = {}) {
  const { chainId, quoter, poolManager, universalRouter } = chainMeta(q.chainId ?? 8453);
  const tokenIn = normalizeToken(q.tokenIn || "WETH", chainId);
  const tokenOut = normalizeToken(q.tokenOut || UNI_V4_CHAINS[chainId].usdc, chainId);
  const amountIn = BigInt(q.amountIn ?? 0);
  if (amountIn <= 0n) throw new Error("amountIn required (raw base units)");
  if (amountIn > 0xffffffffffffffffffffffffffffffffn) {
    throw new Error("amountIn exceeds uint128");
  }

  const tiers =
    q.fee != null && q.tickSpacing != null
      ? [{ fee: Number(q.fee), tickSpacing: Number(q.tickSpacing) }]
      : q.tryTiers === false
        ? [{ fee: 500, tickSpacing: 10 }]
        : [...UNI_V4_FEE_TIERS];

  const hooks = q.hooks || ZERO;
  const results = [];
  let best = null;

  for (const tier of tiers) {
    const { poolKey, zeroForOne } = buildPoolKey({
      tokenIn,
      tokenOut,
      fee: tier.fee,
      tickSpacing: tier.tickSpacing,
      hooks,
    });
    const data = QUOTER_IFACE.encodeFunctionData("quoteExactInputSingle", [
      {
        poolKey,
        zeroForOne,
        exactAmount: amountIn,
        hookData: "0x",
      },
    ]);
    try {
      const raw = await rpcCall(chainId, "eth_call", [{ to: quoter, data }, "latest"], opts);
      if (!raw || raw === "0x") {
        results.push({ ...tier, ok: false, error: "empty result" });
        continue;
      }
      const decoded = QUOTER_IFACE.decodeFunctionResult("quoteExactInputSingle", raw);
      const row = {
        fee: tier.fee,
        tickSpacing: tier.tickSpacing,
        ok: true,
        amountOut: decoded[0].toString(),
        gasEstimate: decoded[1].toString(),
        poolKey,
        zeroForOne,
        poolId: computeV4PoolId({ ...poolKey }),
      };
      results.push(row);
      if (!best || BigInt(row.amountOut) > BigInt(best.amountOut)) best = row;
    } catch (e) {
      results.push({ ...tier, ok: false, error: String(e.message || e).slice(0, 160) });
    }
  }

  if (!best) {
    const err = results.map((r) => `${r.fee}/${r.tickSpacing}:${r.error || "fail"}`).join("; ");
    throw new Error(`uniswap-v4 quote failed chain=${chainId}: ${err}`);
  }

  return attachAutoSlippage(
    {
      venue: "uniswap-v4",
      chainId,
      chain: UNI_V4_CHAINS[chainId].name,
      poolManager,
      quoter,
      universalRouter: universalRouter || null,
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      fee: best.fee,
      tickSpacing: best.tickSpacing,
      hooks: best.poolKey.hooks,
      poolId: best.poolId,
      zeroForOne: best.zeroForOne,
      amountOut: best.amountOut,
      gasEstimate: best.gasEstimate,
      triedTiers: results,
      best: true,
      executionReady: false,
      // A successful quote discovered the complete PoolKey. Preparation is only
      // advertised when its remaining safety inputs were explicit.
      prepareReady:
        typeof q.recipient === "string" && isAddress(q.recipient) && q.slippageBps != null,
    },
    {
      chainId,
      venue: universalRouter || quoter,
      amountOut: best.amountOut,
      liquidityUsd: q.liquidityUsd,
      priceChange5m: q.priceChange5m,
      requestedCapBps: q.maxSlippageBps ?? q.slippageBps,
    },
  );
}

/**
 * Prepare (never sign or broadcast) a V4 exact-input, single-hop swap.
 * A fresh successful quote is the source of truth for the complete PoolKey.
 * ERC-20 input only: native wrapping/unwrapping is intentionally not inferred.
 */
export async function uniV4PrepareExactIn(q = {}, opts = {}) {
  const chainId = Number(q.chainId ?? 8453);
  const meta = chainMeta(chainId);
  if (!q.recipient) throw new Error("uniswap-v4 prepare requires recipient");
  const recipient = getAddress(q.recipient);
  if (q.slippageBps == null) {
    throw new Error("uniswap-v4 prepare requires explicit slippageBps");
  }
  const slippageBps = Number(q.slippageBps);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error("slippageBps must be an integer from 0 through 9999");
  }
  const rawInput = String(q.tokenIn || "");
  if (!rawInput || rawInput === NATIVE || rawInput === ZERO || /^eth$/i.test(rawInput)) {
    throw new Error("uniswap-v4 prepare currently requires an ERC-20 tokenIn; native input is not inferred");
  }

  const quote = await uniV4QuoteExactIn(q, opts);
  if (!meta.universalRouter) throw new Error(`uniswap-v4: no Universal Router on chain ${chainId}`);
  const amountOutMinimum = (BigInt(quote.amountOut) * BigInt(10_000 - slippageBps)) / 10_000n;
  const poolKey = {
    currency0: quote.zeroForOne ? quote.tokenIn : quote.tokenOut,
    currency1: quote.zeroForOne ? quote.tokenOut : quote.tokenIn,
    fee: quote.fee,
    tickSpacing: quote.tickSpacing,
    hooks: quote.hooks,
  };
  const minHopPriceX36 = 0n;
  const swap = abi.encode(
    ["tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)"],
    [[poolKey, quote.zeroForOne, BigInt(quote.amountIn), amountOutMinimum, minHopPriceX36, "0x"]],
  );
  const settle = abi.encode(["address", "uint256"], [quote.tokenIn, BigInt(quote.amountIn)]);
  const take = abi.encode(["address", "uint256"], [quote.tokenOut, amountOutMinimum]);
  const plan = abi.encode(["bytes", "bytes[]"], [V4_ACTIONS, [swap, settle, take]]);
  const deadlineWindow = Math.min(600, Math.max(30, Number(q.deadlineSeconds ?? 300)));
  const nowSeconds = Number(opts.nowSeconds ?? Math.floor(Date.now() / 1000));
  const deadline = nowSeconds + deadlineWindow;
  const data = UNIVERSAL_ROUTER_IFACE.encodeFunctionData("execute", [V4_SWAP, [plan], deadline]);

  return stampPrepared({
    provider: "uniswap-v4",
    prepareReady: true,
    calldataReady: true,
    executionReady: false,
    requiresUserSignature: true,
    signingReady: false,
    broadcastReady: false,
    chainId,
    deadline,
    quote: { ...quote, amountOutMinimum: amountOutMinimum.toString(), slippageBps },
    requiresApproval: {
      token: quote.tokenIn,
      spender: PERMIT2,
      amount: quote.amountIn,
      note: "Universal Router V4 settlement uses Permit2; Permit2 authorization for the Universal Router is also required",
    },
    transaction: {
      chainId,
      from: recipient,
      to: meta.universalRouter,
      data,
      value: "0",
    },
  }, { provider: "uniswap-v4", kind: "univ4-swap-tx" });
}

export async function uniV4Chains() {
  return Object.entries(UNI_V4_CHAINS).map(([id, m]) => ({
    chainId: Number(id),
    name: m.name,
    poolManager: m.poolManager,
    quoter: m.quoter,
    stateView: m.stateView || null,
    universalRouter: m.universalRouter || null,
    weth: m.weth,
    usdc: m.usdc,
  }));
}

export async function uniV4Health(opts = {}) {
  const meta = chainMeta(opts.chainId ?? 8453);
  const code = await rpcCall(meta.chainId, "eth_getCode", [meta.quoter, "latest"], opts);
  const ok = typeof code === "string" && code !== "0x" && code.length > 4;
  return {
    ok,
    chainId: meta.chainId,
    quoter: meta.quoter,
    poolManager: meta.poolManager,
    codeBytes: ok ? (code.length - 2) / 2 : 0,
  };
}
