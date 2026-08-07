// ParaSwap/Velora public market API — keyless price routes, quote-only here.
import { httpJson } from "../http.mjs";
import { attachAutoSlippage, bindAutoSlippageGuardToCall } from "../../auto-slippage.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";
import { resolveVerifiedFee, paraswapFeeParams } from "../../router/integrator-fee.mjs";

export const PARASWAP_API = "https://api.paraswap.io";
const base = (o = {}) => (o.baseUrl || process.env.PARASWAP_API_URL || PARASWAP_API).replace(/\/$/, "");
function token(value, name) {
  const s = String(value || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error(`${name} must be a 20-byte token address`);
  return s.toLowerCase();
}

export async function paraswapTokens(args = {}, opts = {}) {
  const chainId = Number(args.chainId || 1);
  return httpJson(`${base(opts)}/tokens/${chainId}`, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}

export async function paraswapPrice(args = {}, opts = {}) {
  const chainId = Number(args.chainId || args.network || 1);
  if (args.amount == null) throw new Error("amount required");
  const params = new URLSearchParams({
    srcToken: token(args.srcToken, "srcToken"),
    destToken: token(args.destToken, "destToken"),
    amount: String(args.amount),
    srcDecimals: String(Number(args.srcDecimals)),
    destDecimals: String(Number(args.destDecimals)),
    side: String(args.side || "SELL").toUpperCase(),
    network: String(chainId),
    version: String(args.version || "6.2"),
  });
  if (args.includeDEXS) params.set("includeDEXS", String(args.includeDEXS));
  if (args.excludeDEXS) params.set("excludeDEXS", String(args.excludeDEXS));
  const fee = await resolveVerifiedFee({
    wallet: args.userAddress || args.fromAddress,
    env: opts.env,
    action: args.feeAction || "swap",
    holderCheck: opts.holderCheck,
  });
  for (const [k, v] of Object.entries(paraswapFeeParams(fee))) params.set(k, v);
  const result = await httpJson(`${base(opts)}/prices?${params}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
  const amountOut = result?.priceRoute?.destAmount;
  if (!amountOut) return { ...result, executionReady: false, oracleFee: fee };
  return {
    ...attachAutoSlippage(result, {
      chainId,
      venue: result?.priceRoute?.contractAddress || "paraswap-quote",
      amountOut,
      liquidityUsd: args.liquidityUsd,
      priceChange5m: args.priceChange5m,
      quoteAgeMs: 0,
      requestedCapBps: args.maxSlippageBps ?? args.slippageBps,
    }),
    executionReady: false,
    executionBlocker: "call prepare to bind the price route to a validated transaction",
    oracleFee: fee,
  };
}

export async function paraswapPrepare(args = {}, opts = {}) {
  if (String(args.side || "SELL").toUpperCase() !== "SELL") {
    throw new Error("paraswap: agentic prepare currently supports exact-input SELL only");
  }
  const chainId = Number(args.chainId || args.network || 1);
  const userAddress = token(args.userAddress, "userAddress");
  const quote = await paraswapPrice(args, opts);
  const priceRoute = quote?.priceRoute;
  const expectedTarget = String(priceRoute?.contractAddress || "").toLowerCase();
  if (!expectedTarget) throw new Error("paraswap: price route missing contractAddress");
  const body = {
    srcToken: token(args.srcToken, "srcToken"),
    destToken: token(args.destToken, "destToken"),
    srcAmount: String(priceRoute.srcAmount || args.amount),
    // ParaSwap treats destAmount as the on-chain minimum for SELL routes.
    destAmount: String(quote.amountOutMinimum),
    priceRoute,
    userAddress,
    ignoreChecks: false,
    ignoreGasEstimate: false,
  };
  if (args.receiver) body.receiver = token(args.receiver, "receiver");
  const tx = await httpJson(`${base(opts)}/transactions/${chainId}`, {
    method: "POST",
    body,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 25_000,
  });
  if (Number(tx.chainId ?? chainId) !== chainId) throw new Error("paraswap: transaction chain mismatch");
  if (String(tx.to || "").toLowerCase() !== expectedTarget) throw new Error("paraswap: transaction target mismatch");
  if (tx.from && String(tx.from).toLowerCase() !== userAddress) throw new Error("paraswap: transaction sender mismatch");
  return stampPrepared({
    provider: "paraswap",
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
    requiresApproval: body.srcToken !== "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
      ? { token: body.srcToken, spender: priceRoute.tokenTransferProxy || expectedTarget, amount: body.srcAmount }
      : null,
    transaction: {
      chainId,
      from: tx.from || userAddress,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? "0x0",
      ...(tx.gas != null ? { gasLimit: tx.gas } : {}),
      slippageGuard: bindAutoSlippageGuardToCall(quote.autoSlippage, { chainId, venue: tx.to, data: tx.data }),
    },
  }, { provider: "paraswap", kind: "paraswap-tx" });
}

export async function paraswapHealth(opts = {}) {
  const data = await paraswapTokens({ chainId: 1 }, opts);
  const count = Array.isArray(data?.tokens) ? data.tokens.length : Object.keys(data?.tokens || {}).length;
  return { ok: count > 0, tokenSample: count };
}
