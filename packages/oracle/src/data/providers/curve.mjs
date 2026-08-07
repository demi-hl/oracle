// Curve public REST API + RouterNG single-hop exact-input prepare. No key.
import { Interface, getAddress, isAddress } from "ethers";
import { httpJson } from "../http.mjs";
import { rpcCall as defaultRpcCall } from "./evm-rpc.mjs";
import { attachAutoSlippage, bindAutoSlippageGuardToCall } from "../../auto-slippage.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";

export const CURVE_API = "https://api.curve.finance/v1";
const base = (o = {}) => (o.baseUrl || process.env.CURVE_API_URL || CURVE_API).replace(/\/$/, "");

// Official Curve RouterNG deployments from docs.curve.finance router/zaps +
// CurveRouterNG docs. Bytecode is checked before allowlisting.
export const CURVE_ROUTER_NG_BY_CHAIN = Object.freeze({
  1: "0x45312ea0eFf7E09C83CBE249fa1d7598c4C8cd4e",
  10: "0x0DCDED3545D565bA3B19E683431381007245d983",
  56: "0xA72C85C258A81761433B4e8da60505Fe3Dd551CC",
  137: "0x0DCDED3545D565bA3B19E683431381007245d983",
  988: "0xFF5Cb29241F002fFeD2eAa224e3e996D24A6E8d1",
  999: "0xd2002373543Ce3527023C75e7518C274A51ce712",
  4663: "0xFF5Cb29241F002fFeD2eAa224e3e996D24A6E8d1",
  8453: "0x4f37A9d177470499A2dD084621020b023fcffc1F",
  42161: "0x2191718CD32d02B8E60BAdFFeA33E4B5DD9A0A0D",
  43114: "0x0DCDED3545D565bA3B19E683431381007245d983",
});

const ZERO = "0x0000000000000000000000000000000000000000";
const ROUTER_IFACE = new Interface([
  "function get_dy(address[11] route,uint256[5][5] swap_params,uint256 amount,address[5] pools) view returns (uint256)",
  "function exchange(address[11] route,uint256[5][5] swap_params,uint256 amount,uint256 expected,address[5] pools,address receiver) payable returns (uint256)",
]);
const POOL_IFACE = new Interface(["function coins(uint256) view returns (address)"]);

function routerFor(chainId) {
  const router = CURVE_ROUTER_NG_BY_CHAIN[Number(chainId)];
  if (!router) throw new Error(`curve-router-ng: unsupported chainId ${chainId}`);
  return router;
}

function normalizeAddress(value, label) {
  if (!isAddress(value)) throw new Error(`${label} must be a valid EVM address`);
  return getAddress(value);
}

function positiveAmount(value, label) {
  let amount;
  try {
    amount = BigInt(String(value));
  } catch {
    throw new Error(`${label} must be an integer string`);
  }
  if (amount <= 0n) throw new Error(`${label} must be positive`);
  return amount;
}

function integer(value, label, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be an integer ${min}..${max}`);
  return n;
}

function routeArray(tokenIn, pool, tokenOut) {
  return [tokenIn, pool, tokenOut, ...Array(8).fill(ZERO)];
}

function swapParams(i, j, poolType, nCoins) {
  return [[BigInt(i), BigInt(j), 1n, BigInt(poolType), BigInt(nCoins)], ...Array.from({ length: 4 }, () => [0n, 0n, 0n, 0n, 0n])];
}

function poolsArray(pool) {
  return [pool, ...Array(4).fill(ZERO)];
}

async function poolCoins({ chainId, pool, nCoins, rpcCall, opts }) {
  const coins = [];
  for (let i = 0; i < nCoins; i++) {
    const data = POOL_IFACE.encodeFunctionData("coins", [i]);
    const raw = await rpcCall(chainId, "eth_call", [{ to: pool, data }, opts.blockTag || "latest"], opts);
    const decoded = POOL_IFACE.decodeFunctionResult("coins", raw);
    coins.push(getAddress(decoded[0]));
  }
  return coins;
}

function findIndex(coins, token, label) {
  const target = token.toLowerCase();
  const idx = coins.findIndex((coin) => coin.toLowerCase() === target);
  if (idx < 0) throw new Error(`Curve pool does not contain ${label}`);
  return idx;
}

export async function curveOpenApi(opts = {}) {
  return httpJson(`${base(opts)}/openapi.json`, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}

export async function curvePools(args = {}, opts = {}) {
  const chain = String(args.chain || args.network || "ethereum").toLowerCase();
  const registry = String(args.registry || "main").toLowerCase();
  if (!/^[a-z0-9-]+$/.test(chain) || !/^[a-z0-9-]+$/.test(registry)) throw new Error("invalid Curve chain or registry");
  return httpJson(`${base(opts)}/getPools/${chain}/${registry}`, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs ?? 20_000 });
}

export async function curveHealth(opts = {}) {
  const data = await curvePools({ chain: "ethereum", registry: "main" }, opts);
  const count = data?.data?.poolData?.length || 0;
  return { ok: data?.success === true && count > 0, poolSample: count };
}

export async function curveQuote(q = {}, opts = {}) {
  const chainId = Number(q.chainId ?? 8453);
  const router = routerFor(chainId);
  const pool = normalizeAddress(q.pool, "curve pool");
  const tokenIn = normalizeAddress(q.tokenIn, "curve tokenIn");
  const tokenOut = normalizeAddress(q.tokenOut, "curve tokenOut");
  const amountIn = positiveAmount(q.amountIn, "curve amountIn");
  const nCoins = integer(q.nCoins ?? 2, "curve nCoins", 2, 8);
  const poolType = integer(q.poolType, "curve poolType", 1, 4);
  const rpcCall = opts.rpcCall || defaultRpcCall;
  const coins = await poolCoins({ chainId, pool, nCoins, rpcCall, opts });
  const i = findIndex(coins, tokenIn, "tokenIn");
  const j = findIndex(coins, tokenOut, "tokenOut");
  if (i === j) throw new Error("Curve token indexes must differ");
  const route = routeArray(tokenIn, pool, tokenOut);
  const params = swapParams(i, j, poolType, nCoins);
  const pools = poolsArray(pool);
  const data = ROUTER_IFACE.encodeFunctionData("get_dy", [route, params, amountIn, pools]);
  const raw = await rpcCall(chainId, "eth_call", [{ to: router, data }, q.blockTag || "latest"], opts);
  const decoded = ROUTER_IFACE.decodeFunctionResult("get_dy", raw);
  const amountOut = BigInt(decoded[0]);
  if (amountOut <= 0n) throw new Error("curve quote returned zero output");
  return attachAutoSlippage({
    venue: "curve",
    router,
    chainId,
    pool,
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    nCoins,
    poolType,
    swapType: 1,
    i,
    j,
    route,
    swapParams: params.map((row) => row.map((x) => x.toString())),
    pools,
  }, {
    chainId,
    venue: router,
    amountOut: amountOut.toString(),
    liquidityUsd: q.liquidityUsd,
    priceChange5m: q.priceChange5m,
    requestedCapBps: q.maxSlippageBps ?? q.slippageBps,
  });
}

export async function curvePrepare(q = {}, opts = {}) {
  const chainId = Number(q.chainId ?? 8453);
  const router = routerFor(chainId);
  const sender = normalizeAddress(q.sender || q.from || q.fromAddress || q.receiver, "curve sender");
  const receiver = normalizeAddress(q.receiver || q.recipient || sender, "curve receiver");
  const quote = await curveQuote({ ...q, sender }, opts);
  const route = routeArray(quote.tokenIn, quote.pool, quote.tokenOut);
  const params = swapParams(quote.i, quote.j, quote.poolType, quote.nCoins);
  const pools = poolsArray(quote.pool);
  const data = ROUTER_IFACE.encodeFunctionData("exchange", [
    route,
    params,
    BigInt(quote.amountIn),
    BigInt(quote.amountOutMinimum),
    pools,
    receiver,
  ]);
  return stampPrepared({
    provider: "curve",
    calldataReady: true,
    // NOT executable authority. The bytes are assembled but nothing is signed:
    // the user's wallet is still the only thing that can authorize this. The
    // previous `executionReady: true` read as "cleared to execute" and trained
    // agents to treat a quote as permission.
    requiresUserSignature: true,
    signingReady: false,
    broadcastReady: false,
    chainId,
    quote,
    autoSlippage: quote.autoSlippage,
    requiresApproval: {
      token: quote.tokenIn,
      spender: router,
      amount: quote.amountIn,
    },
    transaction: {
      chainId,
      from: sender,
      to: router,
      data,
      value: "0",
      slippageGuard: bindAutoSlippageGuardToCall(quote.autoSlippage, { chainId, venue: router, data }),
    },
  }, { provider: "curve", kind: "curve-tx" });
}
