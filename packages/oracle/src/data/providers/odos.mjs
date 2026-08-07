// DEPRECATED UPSTREAM (2026-07-30).
//
// Odos sunset their public SOR API. Both /sor/quote/v2 and /sor/quote/v3 return
// HTTP 410 Gone with `sunset: Thu, 30 Jul 2026 12:00:00 GMT` and a link to the
// protocol's deprecation notice.
//
// The module is kept rather than deleted so that (a) an existing caller gets a
// clear 410 instead of a missing-import crash, and (b) it re-activates if Odos
// ships a replacement endpoint. The best-execution router already tolerates a
// failing source, so this degrades the comparison by one source rather than
// breaking it.
//
// Do NOT mark this provider as healthy in the catalog while the sunset stands.

// Odos public SOR v3 quote + simulated transaction assembly.
import { isAddress } from "ethers";
import { httpJson } from "../http.mjs";
import { attachAutoSlippage, bindAutoSlippageGuardToCall, resolveAutoSlippage } from "../../auto-slippage.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";

export const ODOS_API = "https://api.odos.xyz";
const base = (o = {}) => (o.baseUrl || process.env.ODOS_API_URL || ODOS_API).replace(/\/$/, "");

export async function odosChains(opts = {}) {
  return httpJson(`${base(opts)}/info/chains`, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}

function validateQuoteArgs(args = {}) {
  const chainId = Number(args.chainId);
  if (!Number.isInteger(chainId)) throw new Error("odos: chainId required");
  if (!Array.isArray(args.inputTokens) || args.inputTokens.length < 1) throw new Error("odos: inputTokens[] required");
  if (!Array.isArray(args.outputTokens) || args.outputTokens.length !== 1) {
    throw new Error("odos: agentic execution currently requires exactly one output token");
  }
  if (!isAddress(String(args.userAddr || ""))) throw new Error("odos: valid userAddr required");
  return chainId;
}

async function rawQuote(args = {}, opts = {}) {
  const chainId = validateQuoteArgs(args);
  const selected = resolveAutoSlippage({
    liquidityUsd: args.liquidityUsd,
    priceChange5m: args.priceChange5m,
    requestedCapBps: args.maxSlippageBps ?? args.slippageBps,
  });
  if (!selected.executable) {
    throw new Error(`odos: route requires ${selected.requiredBps} bps above cap ${selected.capBps}`);
  }
  const body = {
    chainId,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    userAddr: args.userAddr,
    slippageLimitPercent: selected.selectedBps / 100,
    disableRFQs: args.disableRFQs ?? true,
    compact: args.compact ?? true,
    simple: args.simple ?? false,
  };
  const quote = await httpJson(`${base(opts)}/sor/quote/v3`, {
    method: "POST",
    body,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 25_000,
  });
  const amountOut = quote?.outAmounts?.[0];
  if (!quote?.pathId || !amountOut) throw new Error("odos: quote missing pathId or outAmounts[0]");
  return { chainId, selected, quote, amountOut };
}

export async function odosQuote(args = {}, opts = {}) {
  const { chainId, quote, amountOut } = await rawQuote(args, opts);
  return {
    ...attachAutoSlippage(quote, {
      chainId,
      venue: "odos-quote",
      amountOut,
      liquidityUsd: args.liquidityUsd,
      priceChange5m: args.priceChange5m,
      requestedCapBps: args.maxSlippageBps ?? args.slippageBps,
    }),
    executionReady: false,
    executionBlocker: "call prepare to assemble and simulate the path",
  };
}

export async function odosPrepare(args = {}, opts = {}) {
  const { chainId, quote: quoteRaw, amountOut } = await rawQuote(args, opts);
  const assembled = await httpJson(`${base(opts)}/sor/assemble`, {
    method: "POST",
    body: {
      userAddr: args.userAddr,
      pathId: quoteRaw.pathId,
      simulate: true,
      ...(args.receiver ? { receiver: args.receiver } : {}),
    },
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
  const tx = assembled?.transaction;
  if (!tx?.to || !tx?.data) throw new Error("odos: assemble returned no executable transaction");
  if (Number(tx.chainId ?? chainId) !== chainId) throw new Error("odos: transaction chain mismatch");
  if (tx.from && String(tx.from).toLowerCase() !== String(args.userAddr).toLowerCase()) {
    throw new Error("odos: transaction sender mismatch");
  }
  if (assembled?.simulation?.isSuccess !== true) {
    throw new Error(`odos: assembled transaction simulation failed: ${assembled?.simulation?.simulationError || "unknown"}`);
  }
  const quote = attachAutoSlippage(quoteRaw, {
    chainId,
    venue: tx.to,
    amountOut,
    liquidityUsd: args.liquidityUsd,
    priceChange5m: args.priceChange5m,
    requestedCapBps: args.maxSlippageBps ?? args.slippageBps,
  });
  const simulatedOut = assembled?.simulation?.amountsOut?.[0];
  if (simulatedOut != null && BigInt(simulatedOut) < BigInt(quote.amountOutMinimum)) {
    throw new Error("odos: simulation output is below the bounded automatic floor");
  }
  const native = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const zeroNative = "0x0000000000000000000000000000000000000000";
  const approvals = args.inputTokens
    .filter((item) => ![native, zeroNative].includes(String(item.tokenAddress).toLowerCase()))
    .map((item) => ({ token: item.tokenAddress, spender: tx.to, amount: String(item.amount) }));
  return stampPrepared({
    provider: "odos",
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
    simulation: assembled.simulation,
    requiresApproval: approvals,
    autoSlippage: quote.autoSlippage,
    transaction: {
      chainId,
      from: tx.from || args.userAddr,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? "0x0",
      ...(tx.gas != null ? { gasLimit: tx.gas } : {}),
      ...(tx.nonce != null ? { nonce: tx.nonce } : {}),
      slippageGuard: bindAutoSlippageGuardToCall(quote.autoSlippage, { chainId, venue: tx.to, data: tx.data }),
    },
  }, { provider: "odos", kind: "odos-tx" });
}

export async function odosHealth(opts = {}) {
  const data = await odosChains(opts);
  return { ok: Array.isArray(data?.chains) && data.chains.length > 0, chainCount: data?.chains?.length || 0 };
}
