// Balancer public GraphQL API + v3 Router exact-input prepare. No key.
import { Interface, getAddress, isAddress } from "ethers";
import { httpJson } from "../http.mjs";
import { rpcCall as defaultRpcCall } from "./evm-rpc.mjs";
import { attachAutoSlippage, bindAutoSlippageGuardToCall } from "../../auto-slippage.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";

export const BALANCER_API = "https://api-v3.balancer.fi/";
const endpoint = (o = {}) => o.baseUrl || process.env.BALANCER_API_URL || BALANCER_API;

async function gql(query, variables, opts = {}) {
  return httpJson(endpoint(opts), {
    method: "POST",
    body: { query, variables },
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
}

const POOLS_QUERY = `query Pools($first: Int, $where: GqlPoolFilter) { poolGetPools(first: $first, where: $where) { id address chain type protocolVersion dynamicData { totalLiquidity volume24h fees24h } } }`;

// Official Balancer v3 Router deployments; bytecode checked via eth_getCode on
// 2026-07-23. Polygon is intentionally excluded from this v3 prepare slice.
export const BALANCER_V3_CHAINS = Object.freeze({
  1: {
    name: "ethereum",
    router: "0xAE563E3f8219521950555F5962419C8919758Ea2",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  10: {
    name: "optimism",
    router: "0xe2fa4e1d17725e72dcdAfe943Ecf45dF4B9E285b",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
  },
  8453: {
    name: "base",
    router: "0x3f170631ed9821Ca51A59D996aB095162438DC10",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  42161: {
    name: "arbitrum",
    router: "0xEAedc32a51c510d35ebC11088fD5fF2b47aACF2E",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  43114: {
    name: "avalanche",
    router: "0xF39CA6ede9BF7820a952b52f3c94af526bAB9015",
    weth: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  },
});

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO = "0x0000000000000000000000000000000000000000";
const BALANCER_V3_IFACE = new Interface([
  "function querySwapSingleTokenExactIn(address pool,address tokenIn,address tokenOut,uint256 exactAmountIn,address sender,bytes userData) returns (uint256 amountOut)",
  "function swapSingleTokenExactIn(address pool,address tokenIn,address tokenOut,uint256 exactAmountIn,uint256 minAmountOut,uint256 deadline,bool wethIsEth,bytes userData) payable returns (uint256 amountOut)",
]);

function chainMeta(chainId) {
  const id = Number(chainId ?? 8453);
  const meta = BALANCER_V3_CHAINS[id];
  if (!meta) {
    throw new Error(`balancer-v3: unsupported chainId ${chainId} (supported: ${Object.keys(BALANCER_V3_CHAINS).join(", ")})`);
  }
  return { chainId: id, ...meta };
}

function isNativeToken(value) {
  const v = String(value || "").toLowerCase();
  return !v || v === "eth" || v === "native" || v === ZERO || v === NATIVE.toLowerCase();
}

function normalizeAddress(value, label) {
  if (!isAddress(value)) throw new Error(`${label} must be a valid EVM address`);
  return getAddress(value);
}

function normalizeToken(value, meta, label) {
  const s = String(value || "");
  if (isNativeToken(s) || /^weth$/i.test(s)) return getAddress(meta.weth);
  if (/^usdc$/i.test(s)) return getAddress(meta.usdc);
  return normalizeAddress(s, label);
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

function userData(value) {
  if (value == null || value === "") return "0x";
  const data = String(value);
  if (!/^0x[0-9a-fA-F]*$/.test(data)) throw new Error("balancer userData must be hex");
  return data;
}

export async function balancerPools(args = {}, opts = {}) {
  const first = Math.min(100, Math.max(1, Number(args.first || 20)));
  const chains = (args.chains || [args.chain || "ETHEREUM"]).map((x) => String(x).toUpperCase());
  return gql(POOLS_QUERY, { first, chains, where: { chainIn: chains } }, opts);
}

export async function balancerHealth(opts = {}) {
  const data = await gql("query { __typename }", {}, opts);
  return { ok: data?.data?.__typename === "Query" };
}

export async function balancerQuote(q = {}, opts = {}) {
  const meta = chainMeta(q.chainId);
  const pool = normalizeAddress(q.pool, "balancer pool");
  const tokenInRaw = q.tokenIn || "WETH";
  const tokenIn = normalizeToken(tokenInRaw, meta, "balancer tokenIn");
  const tokenOut = normalizeToken(q.tokenOut || "USDC", meta, "balancer tokenOut");
  const amountIn = positiveAmount(q.amountIn, "balancer amountIn");
  const sender = normalizeAddress(q.sender || q.from || q.fromAddress || q.recipient, "balancer sender");
  const data = BALANCER_V3_IFACE.encodeFunctionData("querySwapSingleTokenExactIn", [
    pool,
    tokenIn,
    tokenOut,
    amountIn,
    sender,
    userData(q.userData),
  ]);
  const call = opts.rpcCall || defaultRpcCall;
  const raw = await call(meta.chainId, "eth_call", [{ to: meta.router, data }, q.blockTag || "latest"], opts);
  const decoded = BALANCER_V3_IFACE.decodeFunctionResult("querySwapSingleTokenExactIn", raw);
  const amountOut = BigInt(decoded[0]);
  if (amountOut <= 0n) throw new Error("balancer quote returned zero output");
  return attachAutoSlippage({
    venue: "balancer",
    protocolVersion: 3,
    chainId: meta.chainId,
    chain: meta.name,
    router: meta.router,
    pool,
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
  }, {
    chainId: meta.chainId,
    venue: meta.router,
    amountOut: amountOut.toString(),
    liquidityUsd: q.liquidityUsd,
    priceChange5m: q.priceChange5m,
    requestedCapBps: q.maxSlippageBps ?? q.slippageBps,
  });
}

export async function balancerPrepare(q = {}, opts = {}) {
  const meta = chainMeta(q.chainId);
  const sender = normalizeAddress(q.sender || q.from || q.fromAddress || q.recipient, "balancer sender");
  const inputRaw = q.tokenIn || "WETH";
  const nativeInput = isNativeToken(inputRaw);
  const quote = await balancerQuote({ ...q, sender }, opts);
  const deadlineWindow = Math.min(600, Math.max(30, Number(q.deadlineSeconds ?? 300)));
  const nowSeconds = Number(opts.nowSeconds ?? Math.floor(Date.now() / 1000));
  const deadline = BigInt(nowSeconds + deadlineWindow);
  const wethIsEth = q.wethIsEth != null ? Boolean(q.wethIsEth) : nativeInput;
  const data = BALANCER_V3_IFACE.encodeFunctionData("swapSingleTokenExactIn", [
    quote.pool,
    quote.tokenIn,
    quote.tokenOut,
    BigInt(quote.amountIn),
    BigInt(quote.amountOutMinimum),
    deadline,
    wethIsEth,
    userData(q.userData),
  ]);
  return stampPrepared({
    provider: "balancer",
    calldataReady: true,
    // NOT executable authority. The bytes are assembled but nothing is signed:
    // the user's wallet is still the only thing that can authorize this. The
    // previous `executionReady: true` read as "cleared to execute" and trained
    // agents to treat a quote as permission.
    requiresUserSignature: true,
    signingReady: false,
    broadcastReady: false,
    chainId: meta.chainId,
    deadline: deadline.toString(),
    quote,
    autoSlippage: quote.autoSlippage,
    requiresApproval: nativeInput ? null : {
      token: quote.tokenIn,
      spender: meta.router,
      amount: quote.amountIn,
    },
    transaction: {
      chainId: meta.chainId,
      from: sender,
      to: meta.router,
      data,
      value: nativeInput ? quote.amountIn : "0",
      slippageGuard: bindAutoSlippageGuardToCall(quote.autoSlippage, { chainId: meta.chainId, venue: meta.router, data }),
    },
  }, { provider: "balancer", kind: "balancer-tx" });
}
