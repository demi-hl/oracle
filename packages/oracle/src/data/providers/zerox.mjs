// 0x Swap API v2 — price/quote. Requires ZEROX_API_KEY (or 0X_API_KEY).

import { httpJson } from "../http.mjs";
import { attachAutoSlippage, bindAutoSlippageGuardToCall, resolveAutoSlippage } from "../../auto-slippage.mjs";
import { resolveProviderEndpoint, credentialedHeaders } from "../provider-endpoint.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";

export const ZEROX_API = "https://api.0x.org";

function endpoint(opts = {}) {
  return resolveProviderEndpoint({
    provider: "zerox",
    defaultUrl: ZEROX_API,
    hosts: ["api.0x.org"],
    url: opts.baseUrl || process.env.ZEROX_API_URL,
  });
}

function base(opts = {}) {
  return endpoint(opts).baseUrl;
}

function apiKey(opts = {}) {
  return (
    opts.apiKey ||
    process.env.ZEROX_API_KEY ||
    process.env.OX_API_KEY ||
    process.env["0X_API_KEY"] ||
    ""
  );
}

function headers(opts = {}) {
  return credentialedHeaders(
    { "0x-version": "v2", accept: "application/json" },
    { "0x-api-key": apiKey(opts) },
    endpoint(opts).trusted
  );
}

export async function zeroxHealth(opts = {}) {
  if (!apiKey(opts)) {
    return { ok: false, configured: false, error: "ZEROX_API_KEY not set" };
  }
  try {
    const q = await zeroxPrice(
      {
        chainId: 8453,
        sellToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        buyToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sellAmount: "1000000000000000",
      },
      opts
    );
    return { ok: true, configured: true, buyAmount: q.buyAmount || q.grossBuyAmount };
  } catch (e) {
    return { ok: false, configured: true, error: String(e.message || e).slice(0, 160) };
  }
}

/** Indicative price (no firm quote). */
export async function zeroxPrice(q = {}, opts = {}) {
  if (!apiKey(opts)) throw new Error("ZEROX_API_KEY required for 0x");
  const {
    chainId = 8453,
    sellToken,
    buyToken,
    sellAmount,
    taker,
  } = q;
  if (!sellToken || !buyToken || !sellAmount) {
    throw new Error("zeroxPrice requires sellToken, buyToken, sellAmount");
  }
  const params = new URLSearchParams({
    chainId: String(chainId),
    sellToken,
    buyToken,
    sellAmount: String(sellAmount),
  });
  if (taker) params.set("taker", taker);
  return httpJson(`${base(opts)}/swap/allowance-holder/price?${params}`, {
    headers: headers(opts),
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
}

/** Firm quote (may include transaction). */
export async function zeroxQuote(q = {}, opts = {}) {
  if (!apiKey(opts)) throw new Error("ZEROX_API_KEY required for 0x");
  const {
    chainId = 8453,
    sellToken,
    buyToken,
    sellAmount,
    taker,
  } = q;
  if (!sellToken || !buyToken || !sellAmount) {
    throw new Error("zeroxQuote requires sellToken, buyToken, sellAmount");
  }
  const selected = resolveAutoSlippage({
    liquidityUsd: q.liquidityUsd,
    priceChange5m: q.priceChange5m,
    requestedCapBps: q.maxSlippageBps ?? q.slippageBps,
  });
  if (!selected.executable) {
    throw new Error(`0x: route requires ${selected.requiredBps} bps above cap ${selected.capBps}`);
  }
  const params = new URLSearchParams({
    chainId: String(chainId),
    sellToken,
    buyToken,
    sellAmount: String(sellAmount),
    slippageBps: String(selected.selectedBps),
  });
  if (taker) params.set("taker", taker);
  const result = await httpJson(`${base(opts)}/swap/allowance-holder/quote?${params}`, {
    headers: headers(opts),
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
  const amountOut = result?.buyAmount || result?.grossBuyAmount;
  if (!amountOut) return { ...result, autoSlippagePolicy: selected };
  return attachAutoSlippage(result, {
    chainId,
    venue: result?.transaction?.to || result?.to || "0x",
    amountOut,
    liquidityUsd: q.liquidityUsd,
    priceChange5m: q.priceChange5m,
    requestedCapBps: q.maxSlippageBps ?? q.slippageBps,
  });
}

export async function zeroxPrepare(q = {}, opts = {}) {
  if (!q.taker) throw new Error("0x: taker required for executable prepare");
  const quote = await zeroxQuote(q, opts);
  const tx = quote?.transaction;
  if (!tx?.to || !tx?.data) throw new Error("0x: firm quote returned no transaction");
  const chainId = Number(q.chainId ?? 8453);
  const spender = quote?.issues?.allowance?.spender || quote?.allowanceTarget;
  return stampPrepared({
    provider: "zerox",
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
    requiresApproval: quote?.issues?.allowance?.actual != null && BigInt(quote.issues.allowance.actual) < BigInt(q.sellAmount)
      ? { token: q.sellToken, spender, amount: String(q.sellAmount) }
      : null,
    transaction: {
      chainId,
      from: q.taker,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? "0x0",
      ...(tx.gas != null ? { gasLimit: tx.gas } : {}),
      slippageGuard: bindAutoSlippageGuardToCall(quote.autoSlippage, { chainId, venue: tx.to, data: tx.data }),
    },
  }, { provider: "zerox", kind: "zerox-tx" });
}
