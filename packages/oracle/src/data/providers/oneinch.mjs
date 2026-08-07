// 1inch Swap API v6 — requires ONEINCH_API_KEY (Bearer).

import { httpJson } from "../http.mjs";
import { attachAutoSlippage, bindAutoSlippageGuardToCall, resolveAutoSlippage } from "../../auto-slippage.mjs";
import { resolveProviderEndpoint, credentialedHeaders } from "../provider-endpoint.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";

export const ONEINCH_API = "https://api.1inch.dev/swap/v6.0";

function endpoint(opts = {}) {
  return resolveProviderEndpoint({
    provider: "oneinch",
    defaultUrl: ONEINCH_API,
    hosts: ["api.1inch.dev"],
    url: opts.baseUrl || process.env.ONEINCH_API_URL,
  });
}

function base(opts = {}) {
  return endpoint(opts).baseUrl;
}

function apiKey(opts = {}) {
  return opts.apiKey || process.env.ONEINCH_API_KEY || process.env.ONE_INCH_API_KEY || "";
}

function headers(opts = {}) {
  const k = apiKey(opts);
  return credentialedHeaders(
    { accept: "application/json" },
    { Authorization: k ? `Bearer ${k}` : "" },
    endpoint(opts).trusted
  );
}

export async function oneinchHealth(opts = {}) {
  if (!apiKey(opts)) {
    return { ok: false, configured: false, error: "ONEINCH_API_KEY not set" };
  }
  try {
    const q = await oneinchQuote(
      {
        chainId: 8453,
        src: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        dst: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "1000000000000000",
      },
      opts
    );
    return { ok: true, configured: true, dstAmount: q.dstAmount };
  } catch (e) {
    return { ok: false, configured: true, error: String(e.message || e).slice(0, 160) };
  }
}

export async function oneinchQuote(q = {}, opts = {}) {
  if (!apiKey(opts)) throw new Error("ONEINCH_API_KEY required for 1inch");
  const chainId = Number(q.chainId ?? 1);
  const { src, dst, amount } = q;
  if (!src || !dst || !amount) throw new Error("oneinchQuote requires src, dst, amount");
  const params = new URLSearchParams({
    src,
    dst,
    amount: String(amount),
  });
  const result = await httpJson(`${base(opts)}/${chainId}/quote?${params}`, {
    headers: headers(opts),
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
  if (!result?.dstAmount) return result;
  return attachAutoSlippage(result, {
    chainId,
    venue: "1inch-quote",
    amountOut: result.dstAmount,
    liquidityUsd: q.liquidityUsd,
    priceChange5m: q.priceChange5m,
    requestedCapBps: q.maxSlippageBps ?? q.slippageBps,
  });
}

function isNative(value) {
  return /^(eth|native|0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee)$/i.test(String(value || ""));
}

export async function oneinchApproveSpender(q = {}, opts = {}) {
  if (!apiKey(opts)) throw new Error("ONEINCH_API_KEY required for 1inch");
  const chainId = Number(q.chainId ?? 1);
  return httpJson(`${base(opts)}/${chainId}/approve/spender`, {
    headers: headers(opts),
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
}

export async function oneinchPrepare(q = {}, opts = {}) {
  if (!apiKey(opts)) throw new Error("ONEINCH_API_KEY required for 1inch");
  const chainId = Number(q.chainId ?? 1);
  const { src, dst, amount } = q;
  const from = q.from || q.fromAddress || q.userAddress || q.taker;
  if (!src || !dst || !amount || !from) throw new Error("oneinchPrepare requires src, dst, amount, from");
  const selected = resolveAutoSlippage({
    liquidityUsd: q.liquidityUsd,
    priceChange5m: q.priceChange5m,
    requestedCapBps: q.maxSlippageBps ?? q.slippageBps,
  });
  if (!selected.executable) {
    throw new Error(`1inch: route requires ${selected.requiredBps} bps above cap ${selected.capBps}`);
  }
  const params = new URLSearchParams({
    src,
    dst,
    amount: String(amount),
    from,
    // 1inch Classic Swap API expresses slippage as percentage points.
    slippage: String(selected.selectedBps / 100),
  });
  if (q.receiver) params.set("receiver", q.receiver);
  if (q.referrer) params.set("referrer", q.referrer);
  if (q.disableEstimate != null) params.set("disableEstimate", String(Boolean(q.disableEstimate)));
  if (q.allowPartialFill != null) params.set("allowPartialFill", String(Boolean(q.allowPartialFill)));
  if (q.includeProtocols) params.set("includeProtocols", String(q.includeProtocols));
  if (q.excludeProtocols) params.set("excludeProtocols", String(q.excludeProtocols));
  const raw = await httpJson(`${base(opts)}/${chainId}/swap?${params}`, {
    headers: headers(opts),
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 25_000,
  });
  const tx = raw?.tx;
  if (!tx?.to || !tx?.data) throw new Error("1inch: swap returned no executable tx");
  if (tx.from && String(tx.from).toLowerCase() !== String(from).toLowerCase()) {
    throw new Error("1inch: transaction sender mismatch");
  }
  const amountOut = raw?.dstAmount || raw?.toTokenAmount || raw?.buyAmount;
  if (!amountOut) throw new Error("1inch: swap response missing dstAmount");
  const quote = attachAutoSlippage(raw, {
    chainId,
    venue: tx.to,
    amountOut,
    liquidityUsd: q.liquidityUsd,
    priceChange5m: q.priceChange5m,
    requestedCapBps: q.maxSlippageBps ?? q.slippageBps,
  });
  let requiresApproval = null;
  if (!isNative(src)) {
    const spender = raw?.spender || raw?.approvalAddress || (await oneinchApproveSpender({ chainId }, opts))?.address;
    if (!spender) throw new Error("1inch: ERC-20 route missing approval spender");
    requiresApproval = { token: src, spender, amount: String(amount) };
  }
  return stampPrepared({
    provider: "oneinch",
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
    requiresApproval,
    transaction: {
      chainId,
      from: tx.from || from,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? "0x0",
      ...(tx.gas != null ? { gasLimit: tx.gas } : {}),
      slippageGuard: bindAutoSlippageGuardToCall(quote.autoSlippage, { chainId, venue: tx.to, data: tx.data }),
    },
  }, { provider: "oneinch", kind: "oneinch-tx" });
}
