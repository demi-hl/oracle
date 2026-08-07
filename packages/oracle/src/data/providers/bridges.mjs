// Bridge quote pack — Across, Hop, Relay (public, no key).

import { httpJson } from "../http.mjs";
import { attachAutoSlippage, bindAutoSlippageGuardToCall, resolveAutoSlippage } from "../../auto-slippage.mjs";
import { QUOTE_PLACEHOLDER_ADDRESS, quoteAddress } from "../quote-placeholder.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";

export const ACROSS_API = "https://across.to/api";
export const HOP_API = "https://api.hop.exchange/v1";
export const RELAY_API = "https://api.relay.link";

const HOP_CHAIN_IDS = {
  ethereum: 1,
  optimism: 10,
  bsc: 56,
  polygon: 137,
  arbitrum: 42161,
  avalanche: 43114,
  base: 8453,
};

// ── Across ──────────────────────────────────────────────────────────────────

export async function acrossHealth(opts = {}) {
  try {
    const q = await acrossSuggestedFees(
      {
        token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        destinationToken: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        originChainId: 1,
        destinationChainId: 42161,
        amount: "1000000000000000",
      },
      opts
    );
    return { ok: true, estimatedFillTimeSec: q.estimatedFillTimeSec };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}

export async function acrossSuggestedFees(q = {}, opts = {}) {
  const {
    token,
    destinationToken = token,
    originChainId,
    destinationChainId,
    amount,
  } = q;
  if (!token || originChainId == null || destinationChainId == null || !amount) {
    throw new Error("acrossSuggestedFees requires token, originChainId, destinationChainId, amount");
  }
  const params = new URLSearchParams({
    token,
    destinationToken,
    originChainId: String(originChainId),
    destinationChainId: String(destinationChainId),
    amount: String(amount),
  });
  const base = (opts.baseUrl || process.env.ACROSS_API_URL || ACROSS_API).replace(/\/$/, "");
  return httpJson(`${base}/suggested-fees?${params}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
}

// ── Hop ─────────────────────────────────────────────────────────────────────

export async function hopHealth(opts = {}) {
  try {
    const q = await hopQuote(
      {
        amount: "1000000000000000",
        token: "ETH",
        fromChain: "ethereum",
        toChain: "arbitrum",
        slippage: 0.5,
      },
      opts
    );
    return { ok: true, estimatedRecieved: q.estimatedRecieved || q.estimatedReceived };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}

export async function hopQuote(q = {}, opts = {}) {
  const {
    amount,
    token = "ETH",
    fromChain = "ethereum",
    toChain = "arbitrum",
  } = q;
  if (!amount) throw new Error("hopQuote requires amount");
  const legacyCap = q.slippage == null ? undefined : Math.round(Number(q.slippage) * 100);
  const selected = resolveAutoSlippage({
    liquidityUsd: q.liquidityUsd,
    priceChange5m: q.priceChange5m,
    crossChain: fromChain !== toChain,
    requestedCapBps: q.maxSlippageBps ?? q.slippageBps ?? legacyCap,
  });
  if (!selected.executable) {
    throw new Error(`hop: route requires ${selected.requiredBps} bps above cap ${selected.capBps}`);
  }
  const params = new URLSearchParams({
    amount: String(amount),
    token,
    fromChain,
    toChain,
    // Hop expresses slippage as percentage points: 0.5 = 50 bps.
    slippage: String(selected.selectedBps / 100),
  });
  const base = (opts.baseUrl || process.env.HOP_API_URL || HOP_API).replace(/\/$/, "");
  const result = await httpJson(`${base}/quote?${params}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
  const amountOut = result?.estimatedRecieved || result?.estimatedReceived;
  if (!amountOut) return { ...result, autoSlippagePolicy: selected };
  return attachAutoSlippage(result, {
    chainId: Number(q.originChainId || q.chainId || HOP_CHAIN_IDS[fromChain] || 0),
    venue: result?.tx?.to || "hop",
    amountOut,
    liquidityUsd: q.liquidityUsd,
    priceChange5m: q.priceChange5m,
    crossChain: fromChain !== toChain,
    requestedCapBps: q.maxSlippageBps ?? q.slippageBps ?? legacyCap,
  });
}

// ── Relay ───────────────────────────────────────────────────────────────────

export async function relayHealth(opts = {}) {
  try {
    const q = await relayQuote(
      {
        user: QUOTE_PLACEHOLDER_ADDRESS,
        originChainId: 1,
        destinationChainId: 8453,
        originCurrency: "0x0000000000000000000000000000000000000000",
        destinationCurrency: "0x0000000000000000000000000000000000000000",
        amount: "1000000000000000",
        tradeType: "EXACT_INPUT",
      },
      opts
    );
    return { ok: true, hasSteps: Array.isArray(q.steps), stepCount: q.steps?.length || 0 };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}

export async function relayQuote(q = {}, opts = {}) {
  const {
    user = QUOTE_PLACEHOLDER_ADDRESS,
    originChainId,
    destinationChainId,
    originCurrency = "0x0000000000000000000000000000000000000000",
    destinationCurrency = "0x0000000000000000000000000000000000000000",
    amount,
    tradeType = "EXACT_INPUT",
  } = q;
  if (originChainId == null || destinationChainId == null || !amount) {
    throw new Error("relayQuote requires originChainId, destinationChainId, amount");
  }
  const selected = resolveAutoSlippage({
    liquidityUsd: q.liquidityUsd,
    priceChange5m: q.priceChange5m,
    crossChain: Number(originChainId) !== Number(destinationChainId),
    requestedCapBps: q.maxSlippageBps ?? q.slippageBps,
  });
  if (!selected.executable) {
    throw new Error(`relay: route requires ${selected.requiredBps} bps above cap ${selected.capBps}`);
  }
  const base = (opts.baseUrl || process.env.RELAY_API_URL || RELAY_API).replace(/\/$/, "");
  const result = await httpJson(`${base}/quote`, {
    method: "POST",
    body: {
      user,
      originChainId: Number(originChainId),
      destinationChainId: Number(destinationChainId),
      originCurrency,
      destinationCurrency,
      amount: String(amount),
      tradeType,
      // Relay expects an integer-string in basis points ("50" = 0.50%).
      slippageTolerance: String(selected.selectedBps),
    },
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
  const amountOut = result?.details?.currencyOut?.amount;
  if (!amountOut || !/^\d+$/.test(String(amountOut))) {
    return { ...result, autoSlippagePolicy: selected };
  }
  return attachAutoSlippage(result, {
    chainId: Number(originChainId),
    venue: result?.steps?.[0]?.items?.[0]?.data?.to || "relay",
    amountOut,
    liquidityUsd: q.liquidityUsd,
    priceChange5m: q.priceChange5m,
    crossChain: Number(originChainId) !== Number(destinationChainId),
    requestedCapBps: q.maxSlippageBps ?? q.slippageBps,
  });
}

export async function relayPrepare(q = {}, opts = {}) {
  const quote = await relayQuote(q, opts);
  const chainId = Number(q.originChainId);
  const items = (quote.steps || []).flatMap((step) =>
    (step.items || []).filter((item) => item?.data?.to && item?.data?.data).map((item) => ({ stepId: step.id, ...item.data }))
  );
  if (!items.length) throw new Error("relay: quote returned no executable transaction items");
  const venue = String(quote?.autoSlippage?.venue || "").toLowerCase();
  if (items.some((tx) => String(tx.to).toLowerCase() !== venue)) {
    throw new Error("relay: route includes a separate approval/transaction that is not yet safely bound");
  }
  const transactions = items.map((tx) => ({
    chainId,
    from: tx.from || q.user,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? "0x0",
    ...(tx.gasLimit != null || tx.gas != null ? { gasLimit: tx.gasLimit ?? tx.gas } : {}),
    slippageGuard: bindAutoSlippageGuardToCall(quote.autoSlippage, { chainId, venue: tx.to, data: tx.data }),
  }));
  return stampPrepared({
    provider: "relay",
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
    transactions,
  }, { provider: "relay", kind: "relay-tx" });
}
