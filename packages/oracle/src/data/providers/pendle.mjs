// Pendle public core API — markets and Hosted SDK Convert tx builder, no key.
import { getAddress } from "ethers";
import { httpJson } from "../http.mjs";
import { attachAutoSlippage, bindAutoSlippageGuardToCall, resolveAutoSlippage } from "../../auto-slippage.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";

export const PENDLE_API = "https://api-v2.pendle.finance/core";

// Official Pendle Router from deployment docs. Bytecode checked via eth_getCode
// on Arbitrum/Base 2026-07-23.
export const PENDLE_ROUTER_BY_CHAIN = Object.freeze({
  42161: "0x888888888889758F76e7103c6CbF23ABbF58F946",
  8453: "0x888888888889758F76e7103c6CbF23ABbF58F946",
});

const ZERO = "0x0000000000000000000000000000000000000000";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const base = (o = {}) => (o.baseUrl || process.env.PENDLE_API_URL || PENDLE_API).replace(/\/$/, "");

function checksum(value, label) {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${label} must be a valid EVM address`);
  }
}

function normal(value, label) {
  return checksum(value, label).toLowerCase();
}

function isNative(value) {
  const v = String(value || "").toLowerCase();
  return v === "native" || v === "eth" || v === NATIVE || v === ZERO;
}

function amountString(value, label) {
  let amount;
  try {
    amount = BigInt(String(value));
  } catch {
    throw new Error(`${label} must be an integer string`);
  }
  if (amount <= 0n) throw new Error(`${label} must be positive`);
  return amount.toString();
}

function normalizeInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("pendle convert requires inputs[]");
  return inputs.map((input, i) => ({
    token: checksum(input.token, `pendle input ${i} token`),
    amount: amountString(input.amount, `pendle input ${i} amount`),
  }));
}

function normalizeOutputs(outputs) {
  if (!Array.isArray(outputs) || outputs.length === 0) throw new Error("pendle convert requires outputs[]");
  return outputs.map((token, i) => checksum(token, `pendle output ${i} token`));
}

function routerFor(chainId) {
  const router = PENDLE_ROUTER_BY_CHAIN[Number(chainId)];
  if (!router) throw new Error(`Pendle prepare not enabled for chainId ${chainId}`);
  return router;
}

function firstOutputAmount(result) {
  const amount = result?.routes?.[0]?.outputs?.[0]?.amount || result?.outputs?.[0]?.amount;
  if (!amount) throw new Error("Pendle convert response missing output amount");
  return amountString(amount, "pendle output amount");
}

function normalizeRequiredApprovals(requiredApprovals, spender) {
  const approvals = (Array.isArray(requiredApprovals) ? requiredApprovals : [])
    .filter((approval) => approval?.token && approval?.amount && !isNative(approval.token))
    .map((approval) => ({
      token: normal(approval.token, "pendle approval token"),
      spender: normal(spender, "pendle approval spender"),
      amount: amountString(approval.amount, "pendle approval amount"),
    }));
  if (!approvals.length) return null;
  return approvals.length === 1 ? approvals[0] : approvals;
}

export async function pendleMarkets(args = {}, opts = {}) {
  const chainId = Number(args.chainId || 42161);
  const p = new URLSearchParams({
    limit: String(Math.min(100, Math.max(1, Number(args.limit || 20)))),
    skip: String(Math.max(0, Number(args.skip || 0))),
  });
  if (args.isExpired != null) p.set("isExpired", String(Boolean(args.isExpired)));
  return httpJson(`${base(opts)}/v1/${chainId}/markets?${p}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

export async function pendleHealth(opts = {}) {
  const data = await pendleMarkets({ chainId: 42161, limit: 1 }, opts);
  return { ok: Array.isArray(data?.results), marketSample: data?.results?.length || 0 };
}

export async function pendlePrepare(q = {}, opts = {}) {
  const chainId = Number(q.chainId ?? 42161);
  const router = routerFor(chainId);
  const from = q.from || q.fromAddress || q.userAddress || q.taker || q.receiver;
  if (!from) throw new Error("pendlePrepare requires from/receiver");
  const receiver = checksum(q.receiver || from, "pendle receiver");
  const inputs = normalizeInputs(q.inputs);
  const outputs = normalizeOutputs(q.outputs);
  if (q.enableAggregator === true || (Array.isArray(q.aggregators) && q.aggregators.length)) {
    throw new Error("Pendle aggregator paths are disabled by policy; use direct convert only");
  }
  const selected = resolveAutoSlippage({
    liquidityUsd: q.liquidityUsd,
    priceChange5m: q.priceChange5m,
    requestedCapBps: q.maxSlippageBps ?? q.slippageBps,
  });
  if (!selected.executable) {
    throw new Error(`Pendle: route requires ${selected.requiredBps} bps above cap ${selected.capBps}`);
  }
  const body = {
    receiver,
    slippage: selected.selectedBps / 10_000,
    enableAggregator: false,
    useLimitOrder: false,
    inputs,
    outputs,
    ...(q.redeemRewards != null ? { redeemRewards: Boolean(q.redeemRewards) } : {}),
    ...(q.needScale != null ? { needScale: Boolean(q.needScale) } : {}),
    ...(q.additionalData ? { additionalData: String(q.additionalData) } : {}),
  };
  const raw = await httpJson(`${base(opts)}/v3/sdk/${chainId}/convert`, {
    method: "POST",
    body,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 25_000,
  });
  const route = raw?.routes?.[0];
  const tx = route?.tx;
  if (!tx?.to || !tx?.data) throw new Error("Pendle convert returned no executable tx");
  if (normal(tx.to, "pendle tx target") !== normal(router, "pendle router")) {
    throw new Error("Pendle convert returned unexpected router target");
  }
  if (tx.from && normal(tx.from, "pendle tx sender") !== normal(from, "pendle sender")) {
    throw new Error("Pendle convert transaction sender mismatch");
  }
  const amountOut = firstOutputAmount(raw);
  const quote = attachAutoSlippage(raw, {
    chainId,
    venue: tx.to,
    amountOut,
    liquidityUsd: q.liquidityUsd,
    priceChange5m: q.priceChange5m,
    requestedCapBps: q.maxSlippageBps ?? q.slippageBps,
  });
  return stampPrepared({
    provider: "pendle",
    calldataReady: true,
    // NOT executable authority. The bytes are assembled but nothing is signed:
    // the user's wallet is still the only thing that can authorize this. The
    // previous `executionReady: true` read as "cleared to execute" and trained
    // agents to treat a quote as permission.
    requiresUserSignature: true,
    signingReady: false,
    broadcastReady: false,
    chainId,
    action: raw.action || null,
    quote,
    autoSlippage: quote.autoSlippage,
    requiresApproval: normalizeRequiredApprovals(raw.requiredApprovals, tx.to),
    transaction: {
      chainId,
      from: tx.from || from,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? "0x0",
      slippageGuard: bindAutoSlippageGuardToCall(quote.autoSlippage, { chainId, venue: tx.to, data: tx.data }),
    },
  }, { provider: "pendle", kind: "pendle-swap" });
}

export async function pendleQuote(q = {}, opts = {}) {
  const prepared = await pendlePrepare(q, opts);
  const { transaction: _transaction, ...quote } = prepared;
  return quote;
}
