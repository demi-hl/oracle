// Aerodrome Slipstream (Base) — QuoterV2 + SwapRouter exact-input.
// Official deployments: aerodrome-finance/slipstream README (Base).
// Quoter/router use tickSpacing (not Uniswap fee tiers). No API key.
// Read/quote/prepare only — never signs or broadcasts.

import { Interface, getAddress, isAddress } from "ethers";
import { rpcCall } from "./evm-rpc.mjs";
import { attachAutoSlippage, bindAutoSlippageGuardToCall } from "../../auto-slippage.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";

/** @type {Record<number, { name: string, quoter: string, router: string, factory: string, weth: string, usdc: string }>} */
export const AERODROME_CHAINS = {
  8453: {
    name: "base",
    // Verified 2026-07-24: slipstream README initial deployment + eth_getCode + live quote.
    quoter: "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0",
    router: "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5",
    factory: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
};

// Common Slipstream tick spacings on Base.
export const AERODROME_TICK_SPACINGS = [1, 50, 100, 200, 2000];

const QUOTER_IFACE = new Interface([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

const ROUTER_IFACE = new Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO = "0x0000000000000000000000000000000000000000";

function chainMeta(chainId) {
  const id = Number(chainId);
  const m = AERODROME_CHAINS[id];
  if (!m) {
    throw new Error(
      `aerodrome: unsupported chainId ${chainId} (supported: ${Object.keys(AERODROME_CHAINS).join(", ")})`
    );
  }
  return { chainId: id, ...m };
}

function normalizeToken(addr, chainId) {
  const meta = AERODROME_CHAINS[Number(chainId)];
  if (!addr || addr === NATIVE || addr === ZERO || /^eth$/i.test(String(addr))) {
    return getAddress(meta.weth);
  }
  const s = String(addr);
  if (/^weth$/i.test(s)) return getAddress(meta.weth);
  if (/^usdc$/i.test(s)) return getAddress(meta.usdc);
  if (!isAddress(s)) throw new Error(`invalid token address: ${addr}`);
  return getAddress(s);
}

/**
 * Quote exact-input single hop via Aerodrome Slipstream QuoterV2.
 * @param {object} q
 * @param {number} [q.chainId=8453]
 * @param {string} [q.tokenIn] default WETH
 * @param {string} [q.tokenOut] default USDC
 * @param {string|number|bigint} q.amountIn raw base units
 * @param {number} [q.tickSpacing] if omitted, tries common spacings for best-out
 */
export async function aerodromeQuoteExactIn(q = {}, opts = {}) {
  const { chainId, quoter, router } = chainMeta(q.chainId ?? 8453);
  const tokenIn = normalizeToken(q.tokenIn || "WETH", chainId);
  const tokenOut = normalizeToken(q.tokenOut || AERODROME_CHAINS[chainId].usdc, chainId);
  const amountIn = BigInt(q.amountIn ?? 0);
  if (amountIn <= 0n) throw new Error("amountIn required (raw base units)");

  const spacings =
    q.tickSpacing != null
      ? [Number(q.tickSpacing)]
      : q.tryTickSpacings === false
        ? [100]
        : [...AERODROME_TICK_SPACINGS];

  const results = [];
  let best = null;

  for (const tickSpacing of spacings) {
    const data = QUOTER_IFACE.encodeFunctionData("quoteExactInputSingle", [
      {
        tokenIn,
        tokenOut,
        amountIn,
        tickSpacing,
        sqrtPriceLimitX96: 0n,
      },
    ]);
    try {
      const raw = await rpcCall(chainId, "eth_call", [{ to: quoter, data }, "latest"], opts);
      if (!raw || raw === "0x") {
        results.push({ tickSpacing, ok: false, error: "empty result" });
        continue;
      }
      const decoded = QUOTER_IFACE.decodeFunctionResult("quoteExactInputSingle", raw);
      const row = {
        tickSpacing,
        ok: true,
        amountOut: decoded[0].toString(),
        sqrtPriceX96After: decoded[1].toString(),
        initializedTicksCrossed: Number(decoded[2]),
        gasEstimate: decoded[3].toString(),
      };
      results.push(row);
      if (!best || BigInt(row.amountOut) > BigInt(best.amountOut)) best = row;
    } catch (e) {
      results.push({ tickSpacing, ok: false, error: String(e.message || e).slice(0, 160) });
    }
  }

  if (!best) {
    const err = results.map((r) => `${r.tickSpacing}:${r.error || "fail"}`).join("; ");
    throw new Error(`aerodrome quote failed chain=${chainId}: ${err}`);
  }

  return attachAutoSlippage(
    {
      venue: "aerodrome",
      chainId,
      chain: AERODROME_CHAINS[chainId].name,
      quoter,
      router,
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      tickSpacing: best.tickSpacing,
      amountOut: best.amountOut,
      gasEstimate: best.gasEstimate,
      sqrtPriceX96After: best.sqrtPriceX96After,
      initializedTicksCrossed: best.initializedTicksCrossed,
      triedTickSpacings: results,
      best: true,
    },
    {
      chainId,
      venue: router,
      amountOut: best.amountOut,
      liquidityUsd: q.liquidityUsd,
      priceChange5m: q.priceChange5m,
      requestedCapBps: q.maxSlippageBps ?? q.slippageBps,
    }
  );
}

export async function aerodromePrepareExactIn(q = {}, opts = {}) {
  const chainId = Number(q.chainId ?? 8453);
  const meta = chainMeta(chainId);
  const recipient = getAddress(q.recipient || q.from || q.userAddress);
  const inputRaw = String(q.tokenIn || "WETH");
  const nativeInput =
    !q.tokenIn || inputRaw === NATIVE || inputRaw === ZERO || /^eth$/i.test(inputRaw);
  const quote = await aerodromeQuoteExactIn(q, opts);
  const deadlineWindow = Math.min(600, Math.max(30, Number(q.deadlineSeconds ?? 300)));
  const nowSeconds = Number(opts.nowSeconds ?? Math.floor(Date.now() / 1000));
  const deadline = nowSeconds + deadlineWindow;
  const data = ROUTER_IFACE.encodeFunctionData("exactInputSingle", [
    {
      tokenIn: quote.tokenIn,
      tokenOut: quote.tokenOut,
      tickSpacing: quote.tickSpacing,
      recipient,
      deadline,
      amountIn: BigInt(quote.amountIn),
      amountOutMinimum: BigInt(quote.amountOutMinimum),
      sqrtPriceLimitX96: 0n,
    },
  ]);
  return stampPrepared({
    provider: "aerodrome",
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
    requiresApproval: nativeInput
      ? null
      : {
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
  }, { provider: "aerodrome", kind: "aerodrome-exact-in" });
}

export async function aerodromeHealth(opts = {}) {
  const chainId = Number(opts.chainId ?? 8453);
  try {
    const q = await aerodromeQuoteExactIn(
      {
        chainId,
        tokenIn: "WETH",
        tokenOut: "USDC",
        amountIn: "1000000000000000",
      },
      opts
    );
    const usdc = Number(q.amountOut) / 1e6;
    return {
      ok: true,
      chainId,
      tickSpacing: q.tickSpacing,
      amountOutUsdc: usdc,
      midPxHint: usdc / 0.001,
      router: AERODROME_CHAINS[chainId]?.router,
      quoter: AERODROME_CHAINS[chainId]?.quoter,
    };
  } catch (e) {
    return { ok: false, chainId, error: String(e.message || e).slice(0, 200) };
  }
}

export async function aerodromeChains() {
  return Object.entries(AERODROME_CHAINS).map(([id, m]) => ({
    chainId: Number(id),
    name: m.name,
    quoter: m.quoter,
    router: m.router,
    factory: m.factory,
    weth: m.weth,
    usdc: m.usdc,
  }));
}
