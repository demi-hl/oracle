// LI.FI public quote API — no API key required for basic quotes.

import { httpJson } from "../http.mjs";
import { attachAutoSlippage, bindAutoSlippageGuardToCall, resolveAutoSlippage } from "../../auto-slippage.mjs";
import { QUOTE_PLACEHOLDER_ADDRESS, quoteAddress } from "../quote-placeholder.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";

import { resolveFee, lifiFeeParams } from "../../router/integrator-fee.mjs";

export const LIFI_API = "https://li.quest/v1";

function base(opts = {}) {
  return (opts.baseUrl || process.env.LIFI_API_URL || LIFI_API).replace(/\/$/, "");
}

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO = "0x0000000000000000000000000000000000000000";

function isNativeToken(value) {
  const token = String(value || NATIVE).toLowerCase();
  return token === NATIVE.toLowerCase() || token === ZERO;
}

function address(value, label) {
  const text = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new Error(`lifi: ${label} must be a 20-byte address`);
  return text.toLowerCase();
}

export async function lifiHealth(opts = {}) {
  // cheap chains list
  const chains = await httpJson(`${base(opts)}/chains`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 12_000,
  });
  const n = Array.isArray(chains) ? chains.length : chains?.chains?.length || 0;
  return { ok: n > 0, chainCount: n };
}

/**
 * @param {object} q
 * @param {number|string} q.fromChain
 * @param {number|string} q.toChain
 * @param {string} q.fromToken
 * @param {string} q.toToken
 * @param {string} q.fromAmount  wei/base units
 * @param {string} [q.fromAddress]
 */
export async function lifiQuote(q = {}, opts = {}) {
  const {
    fromChain,
    toChain = fromChain,
    fromToken = NATIVE,
    toToken,
    fromAmount,
    fromAddress = QUOTE_PLACEHOLDER_ADDRESS,
  } = q;
  if (fromChain == null || !toToken || !fromAmount) {
    throw new Error("lifiQuote requires fromChain, toToken, fromAmount");
  }
  const params = new URLSearchParams({
    fromChain: String(fromChain),
    toChain: String(toChain),
    fromToken,
    toToken,
    fromAmount: String(fromAmount),
    fromAddress,
  });
  const selected = resolveAutoSlippage({
    liquidityUsd: q.liquidityUsd,
    priceChange5m: q.priceChange5m,
    crossChain: Number(toChain) !== Number(fromChain),
    requestedCapBps: q.maxSlippageBps ?? q.slippageBps,
  });
  if (!selected.executable) {
    throw new Error(`lifi: route requires ${selected.requiredBps} bps above cap ${selected.capBps}`);
  }
  // LI.FI expects a decimal fraction: 0.005 = 50 bps.
  params.set("slippage", String(selected.selectedBps / 10_000));
  // Integrator fee. Off unless configured, and always zero for Locals Only
  // holders — see router/integrator-fee.mjs for why the policy lives in one
  // place instead of per-provider.
  const fee = resolveFee({ isHolder: q.isHolder, action: q.feeAction || "swap" });
  for (const [k, v] of Object.entries(lifiFeeParams(fee))) params.set(k, v);
  const result = await httpJson(`${base(opts)}/quote?${params}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
  const amountOut = result?.estimate?.toAmount || result?.toAmount;
  if (!amountOut) return { ...result, autoSlippagePolicy: selected, oracleFee: fee };
  const venue = result?.transactionRequest?.to || result?.estimate?.approvalAddress || "lifi";
  const guarded = attachAutoSlippage(result, {
    chainId: Number(fromChain),
    venue,
    amountOut,
    liquidityUsd: q.liquidityUsd,
    priceChange5m: q.priceChange5m,
    crossChain: Number(toChain) !== Number(fromChain),
    requestedCapBps: q.maxSlippageBps ?? q.slippageBps,
  });
  const providerMin = result?.estimate?.toAmountMin || result?.toAmountMin;
  if (providerMin != null && BigInt(providerMin) < BigInt(guarded.amountOutMinimum)) {
    throw new Error("lifi: provider transaction is under-protected versus bounded auto-slippage floor");
  }
  return { ...guarded, oracleFee: fee };
}

export async function lifiPrepare(q = {}, opts = {}) {
  const quote = await lifiQuote(q, opts);
  const tx = quote?.transactionRequest;
  if (!tx?.to || !tx?.data) throw new Error("lifi: quote did not return an executable transactionRequest");
  const chainId = Number(q.fromChain);
  if (tx.chainId != null && Number(tx.chainId) !== chainId) throw new Error("lifi: transaction chain mismatch");
  if (q.fromAddress && tx.from && String(tx.from).toLowerCase() !== String(q.fromAddress).toLowerCase()) {
    throw new Error("lifi: transaction sender mismatch");
  }
  let requiresApproval = null;
  if (!isNativeToken(q.fromToken)) {
    const spender = quote?.estimate?.approvalAddress || quote?.approvalAddress;
    if (!spender) throw new Error("lifi: ERC20 route missing approvalAddress");
    // q.fromToken may be a SYMBOL ("WETH") -- LI.FI's API accepts symbols, and the
    // router passes the user's raw CLI argument straight through. The approval
    // must name a real 20-byte token, so prefer the resolved address LI.FI echoes
    // back in its own action/estimate before falling back to the input.
    const resolvedToken =
      quote?.action?.fromToken?.address ||
      quote?.estimate?.fromToken?.address ||
      q.fromToken;
    requiresApproval = {
      token: address(resolvedToken, "approval token"),
      spender: address(spender, "approval spender"),
      amount: String(q.fromAmount),
    };
  }
  return stampPrepared({
    provider: "lifi",
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
      from: tx.from || q.fromAddress,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? "0x0",
      ...(tx.gasLimit != null ? { gasLimit: tx.gasLimit } : {}),
      slippageGuard: bindAutoSlippageGuardToCall(quote.autoSlippage, { chainId, venue: tx.to, data: tx.data }),
    },
  }, { provider: "lifi", kind: "lifi-tx" });
}

export async function lifiChains(opts = {}) {
  return httpJson(`${base(opts)}/chains`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 12_000,
  });
}
