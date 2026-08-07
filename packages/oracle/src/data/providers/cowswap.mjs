// CoW Swap Order Book API — public, no key. Quotes are read-only. Order
// prepare returns a guarded EIP-712 intent; signing/submission is a separate
// executable artifact flow and must never be treated as normal tx prepare.

import { TypedDataEncoder, getAddress, isAddress, verifyTypedData } from "ethers";
import { httpJson } from "../http.mjs";
import { attachAutoSlippage } from "../../auto-slippage.mjs";
import { autonomousTradingEnabled } from "../../capability-posture.mjs";
import { QUOTE_PLACEHOLDER_ADDRESS, quoteAddress } from "../quote-placeholder.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";

export const COW_HOSTS = {
  1: "https://api.cow.fi/mainnet/api/v1",
  100: "https://api.cow.fi/xdai/api/v1",
  42161: "https://api.cow.fi/arbitrum_one/api/v1",
  8453: "https://api.cow.fi/base/api/v1",
};

export const COW_SETTLEMENT = Object.freeze({
  1: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
  100: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
  42161: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
  8453: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
});

export const COW_VAULT_RELAYER = Object.freeze({
  1: "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110",
  100: "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110",
  42161: "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110",
  8453: "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110",
});

const WETH = {
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  8453: "0x4200000000000000000000000000000000000006",
  42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
};
const USDC = {
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
};

export const COW_ORDER_TYPES = Object.freeze({
  Order: [
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "receiver", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "validTo", type: "uint32" },
    { name: "appData", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "kind", type: "string" },
    { name: "partiallyFillable", type: "bool" },
    { name: "sellTokenBalance", type: "string" },
    { name: "buyTokenBalance", type: "string" },
  ],
});

export const COW_CANCEL_TYPES = Object.freeze({
  OrderCancellations: [{ name: "orderUids", type: "bytes[]" }],
});

function host(chainId, opts = {}) {
  if (opts.baseUrl) return opts.baseUrl.replace(/\/$/, "");
  const h = COW_HOSTS[Number(chainId)];
  if (!h) throw new Error(`cowswap: unsupported chainId ${chainId}`);
  return h;
}

function apiHost(chainId, version = "v1", opts = {}) {
  const h = host(chainId, opts);
  if (version === "v1") return h;
  return h.replace(/\/api\/v1$/, `/api/${version}`);
}

function addr(value, label) {
  const text = String(value || "").trim();
  if (!isAddress(text)) throw new Error(`cowswap: ${label} must be an address`);
  return getAddress(text).toLowerCase();
}

function uintString(value, label) {
  try {
    const n = BigInt(String(value));
    if (n < 0n) throw new Error("negative");
    return n.toString();
  } catch {
    throw new Error(`cowswap: ${label} must be a non-negative integer string`);
  }
}

function bytes32(value, label) {
  const text = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) throw new Error(`cowswap: ${label} must be bytes32 hex`);
  return text.toLowerCase();
}

function orderUid(value, label = "uid") {
  const text = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{112}$/.test(text)) throw new Error(`cowswap: ${label} must be 56-byte order UID hex`);
  return text.toLowerCase();
}

/**
 * Market submission gate.
 *
 * Posture: submission is ARMED once the user has a signer wired up — that is
 * the authorization. `opts.execute === true` records that THIS placement was
 * asked for, so an order is never posted as a side effect of quoting. The
 * separate opt-in exists only for UNATTENDED trading, which is checked by the
 * autonomous flag, not here.
 */
function requireExecuteGate(opts = {}) {
  if (opts.execute !== true) throw new Error("cowswap execute gate required for order signing/submission/cancel");
  if (opts.autonomous === true && !autonomousTradingEnabled()) {
    throw new Error(
      "cowswap: autonomous order placement is off — set ORACLE_AUTONOMOUS_TRADING=1 to let Oracle trade unattended"
    );
  }
}

function assertCowOrderGuard(intent = {}, typedData = {}, owner, { nowMs = Date.now() } = {}) {
  const guard = intent.cowGuard;
  if (!guard || guard.mode !== "cow-order") throw new Error("cowswap: fresh cow order guard required");
  if (Number(guard.expiresAtMs) <= Number(nowMs)) throw new Error("cowswap: cow order guard expired");
  const chainId = Number(intent.chainId ?? typedData?.domain?.chainId);
  if (Number(guard.chainId) !== chainId) throw new Error("cowswap: cow order guard chain mismatch");
  if (addr(guard.owner, "guard owner") !== owner) throw new Error("cowswap: cow order guard owner mismatch");
  const domain = orderDomain(chainId);
  if (Number(typedData?.domain?.chainId) !== chainId) throw new Error("cowswap: typedData chain mismatch");
  if (addr(typedData?.domain?.verifyingContract, "settlement") !== domain.verifyingContract.toLowerCase()) {
    throw new Error("cowswap: typedData settlement mismatch");
  }
  if (addr(guard.settlement, "guard settlement") !== domain.verifyingContract.toLowerCase()) {
    throw new Error("cowswap: cow order guard settlement mismatch");
  }
  const message = typedData?.message;
  if (!message) throw new Error("cowswap: typedData order message required");
  const typedDataHash = TypedDataEncoder.hash(domain, COW_ORDER_TYPES, message);
  if (String(guard.typedDataHash || "").toLowerCase() !== typedDataHash.toLowerCase()) {
    throw new Error("cowswap: cow order guard typedData hash mismatch");
  }
  if (addr(guard.sellToken, "guard sellToken") !== addr(message.sellToken, "sellToken")) throw new Error("cowswap: cow order guard sellToken mismatch");
  if (addr(guard.buyToken, "guard buyToken") !== addr(message.buyToken, "buyToken")) throw new Error("cowswap: cow order guard buyToken mismatch");
  if (String(guard.sellAmount) !== uintString(message.sellAmount, "sellAmount")) throw new Error("cowswap: cow order guard sellAmount mismatch");
  if (String(guard.buyAmount) !== uintString(message.buyAmount, "buyAmount")) throw new Error("cowswap: cow order guard buyAmount mismatch");
  if (Number(guard.validTo) !== Number(message.validTo)) throw new Error("cowswap: cow order guard validTo mismatch");
  if (Number(message.validTo) * 1000 <= Number(nowMs)) throw new Error("cowswap: order expired");
  return true;
}

function toCowOrderUid({ digest, owner, validTo } = {}) {
  const d = bytes32(digest, "order digest").slice(2);
  const o = addr(owner, "owner").slice(2).toLowerCase();
  const v = Number(validTo);
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error("cowswap: validTo must fit uint32");
  return `0x${d}${o}${v.toString(16).padStart(8, "0")}`.toLowerCase();
}

function orderDomain(chainId) {
  const verifyingContract = COW_SETTLEMENT[Number(chainId)];
  if (!verifyingContract) throw new Error(`cowswap: settlement contract not registered for chain ${chainId}`);
  return {
    name: "Gnosis Protocol",
    version: "v2",
    chainId: Number(chainId),
    verifyingContract: getAddress(verifyingContract),
  };
}

function normalizeOrderQuote(q = {}, chainId, owner) {
  const sellToken = addr(q.sellToken, "sellToken");
  const buyToken = addr(q.buyToken, "buyToken");
  const receiver = addr(q.receiver || owner, "receiver");
  const validTo = Number(q.validTo);
  if (!Number.isInteger(validTo) || validTo <= 0) throw new Error("cowswap: quote.validTo required");
  const appData = bytes32(q.appData || q.appDataHash || `0x${"0".repeat(64)}`, "appData");
  return {
    sellToken,
    buyToken,
    receiver,
    sellAmount: uintString(q.sellAmount, "sellAmount"),
    buyAmount: uintString(q.buyAmount, "buyAmount"),
    validTo,
    appData,
    feeAmount: uintString(q.feeAmount ?? "0", "feeAmount"),
    kind: String(q.kind || "sell"),
    partiallyFillable: Boolean(q.partiallyFillable),
    sellTokenBalance: String(q.sellTokenBalance || "erc20"),
    buyTokenBalance: String(q.buyTokenBalance || "erc20"),
  };
}

export async function cowHealth(opts = {}) {
  try {
    const q = await cowQuote(
      {
        chainId: 1,
        sellToken: WETH[1],
        buyToken: USDC[1],
        sellAmountBeforeFee: "1000000000000000",
        from: QUOTE_PLACEHOLDER_ADDRESS,
      },
      opts
    );
    return { ok: true, buyAmount: q.quote?.buyAmount || q.buyAmount };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}

export async function cowQuote(q = {}, opts = {}) {
  const chainId = Number(q.chainId ?? 1);
  const from = quoteAddress(q.from || q.owner);
  let sellToken = q.sellToken || WETH[chainId];
  const buyToken = q.buyToken || USDC[chainId];
  const sellAmountBeforeFee = String(q.sellAmountBeforeFee || q.sellAmount || "0");
  if (!sellToken || !buyToken || sellAmountBeforeFee === "0") {
    throw new Error("cowQuote requires sellToken, buyToken, sellAmountBeforeFee");
  }
  // Cow rejects native ETH — map to WETH
  if (/eeeeeeee|native|^eth$/i.test(sellToken)) {
    sellToken = WETH[chainId];
    if (!sellToken) throw new Error("no WETH mapping for chain");
  }
  const body = {
    sellToken,
    buyToken,
    from,
    receiver: q.receiver || from,
    sellAmountBeforeFee,
    kind: q.kind || "sell",
    signingScheme: q.signingScheme || "eip1271",
  };
  const result = await httpJson(`${host(chainId, opts)}/quote`, {
    method: "POST",
    body,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
  const amountOut = result?.quote?.buyAmount || result?.buyAmount;
  if (!amountOut) return result;
  // A CoW sell order's signed buyAmount is itself the executable floor. The
  // attached guard keeps policy/reporting consistent with direct swap routes.
  return attachAutoSlippage(result, {
    chainId,
    venue: "cowswap-order",
    amountOut,
    liquidityUsd: q.liquidityUsd,
    priceChange5m: q.priceChange5m,
    requestedCapBps: q.maxSlippageBps ?? q.slippageBps,
  });
}

export async function cowPrepareOrder(q = {}, opts = {}) {
  const chainId = Number(q.chainId ?? 1);
  const owner = addr(quoteAddress(q.from || q.owner || q.signer), "owner");
  const quote = await cowQuote({ ...q, chainId, from: owner, signingScheme: q.signingScheme || "eip712" }, opts);
  const order = normalizeOrderQuote(quote?.quote || quote, chainId, owner);
  const domain = orderDomain(chainId);
  const typedData = { domain, types: COW_ORDER_TYPES, primaryType: "Order", message: order };
  const typedDataHash = TypedDataEncoder.hash(domain, COW_ORDER_TYPES, order);
  const relayer = COW_VAULT_RELAYER[chainId];
  if (!relayer) throw new Error(`cowswap: vault relayer not registered for chain ${chainId}`);
  return stampPrepared({
    provider: "cowswap",
    orderReady: true,
    executionReady: false,
    chainId,
    owner,
    signingScheme: "eip712",
    settlement: domain.verifyingContract.toLowerCase(),
    vaultRelayer: getAddress(relayer).toLowerCase(),
    quote,
    quoteId: quote?.id ?? q.quoteId ?? null,
    typedData,
    cowGuard: {
      mode: "cow-order",
      version: 1,
      provider: "cowswap",
      chainId,
      owner,
      settlement: domain.verifyingContract.toLowerCase(),
      vaultRelayer: getAddress(relayer).toLowerCase(),
      sellToken: order.sellToken,
      buyToken: order.buyToken,
      sellAmount: order.sellAmount,
      buyAmount: order.buyAmount,
      validTo: order.validTo,
      quoteId: quote?.id ?? q.quoteId ?? null,
      typedDataHash,
      issuedAtMs: Date.now(),
      expiresAtMs: Math.min(order.validTo * 1000, Date.now() + 20_000),
    },
    requiresApproval: {
      token: order.sellToken,
      spender: getAddress(relayer).toLowerCase(),
      amount: order.sellAmount,
    },
  }, { provider: "cowswap", kind: "cow-order" });
}

export async function cowOrderStatus(q = {}, opts = {}) {
  const chainId = Number(q.chainId ?? 1);
  const uid = String(q.uid || q.orderUid || "").trim();
  if (!uid) throw new Error("cowOrderStatus requires uid");
  return httpJson(`${host(chainId, opts)}/orders/${encodeURIComponent(uid)}/status`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
}

export async function cowOrder(q = {}, opts = {}) {
  const chainId = Number(q.chainId ?? 1);
  const uid = String(q.uid || q.orderUid || "").trim();
  if (!uid) throw new Error("cowOrder requires uid");
  return httpJson(`${host(chainId, opts)}/orders/${encodeURIComponent(uid)}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
}

export function cowOrderUid(intent = {}) {
  const typedData = intent.typedData || intent;
  const chainId = Number(intent.chainId ?? typedData?.domain?.chainId);
  const message = typedData?.message || intent.order || intent.message;
  if (!message) throw new Error("cowswap: typed order message required");
  const digest = intent.cowGuard?.typedDataHash || TypedDataEncoder.hash(orderDomain(chainId), COW_ORDER_TYPES, message);
  const owner = intent.owner || intent.from || intent.signer || message.receiver;
  return toCowOrderUid({ digest, owner, validTo: message.validTo });
}

export async function cowSignOrder(_a = {}, _o = {}) {
  throw new Error("cowswap.cowSignOrder refused: @oracle-agent/oracle is prepare-only. Sign with the user wallet; do not pass private keys here.");
}

export async function cowSubmitSignedOrder(_a = {}, _o = {}) {
  throw new Error("cowswap.cowSubmitSignedOrder refused: @oracle-agent/oracle is prepare-only. Submit signed orders from the user wallet or local operator.");
}

export function cowPrepareCancel(q = {}) {
  const chainId = Number(q.chainId ?? 1);
  const owner = addr(q.owner || q.from || q.signer, "owner");
  const orderUids = (q.orderUids || q.uids || [q.uid]).filter(Boolean).map((u, i) => orderUid(u, `orderUids[${i}]`));
  if (!orderUids.length) throw new Error("cowswap: orderUids required");
  const domain = orderDomain(chainId);
  const message = { orderUids };
  return stampPrepared({
    provider: "cowswap",
    chainId,
    owner,
    orderUids,
    signingScheme: "eip712",
    typedData: { domain, types: COW_CANCEL_TYPES, primaryType: "OrderCancellations", message },
    cancelReady: true,
    executableArtifact: true,
  }, { provider: "cowswap", kind: "cow-cancel" });
}

export async function cowSignCancel(_a = {}, _o = {}) {
  throw new Error("cowswap.cowSignCancel refused: @oracle-agent/oracle is prepare-only. Cancel-sign with the user wallet.");
}

export async function cowCancelOrders(_a = {}, _o = {}) {
  throw new Error("cowswap.cowCancelOrders refused: @oracle-agent/oracle is prepare-only. Cancel from the user wallet or local operator.");
}


function tradeBuyAmount(trade = {}) {
  return uintString(trade.buyAmount ?? trade.executedBuyAmount ?? "0", "trade.buyAmount");
}

export async function cowVerifyOrderFill(q = {}, opts = {}) {
  const chainId = Number(q.chainId ?? 1);
  const uid = orderUid(q.uid || q.orderUid);
  const order = opts.order || await cowOrder({ chainId, uid }, opts);
  const status = opts.status || order.status || await cowOrderStatus({ chainId, uid }, opts).catch(() => null);
  const trades = opts.trades || await httpJson(`${apiHost(chainId, "v2", opts)}/trades?orderUid=${encodeURIComponent(uid)}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
  const list = Array.isArray(trades) ? trades : [];
  const expectedOwner = q.expectedOwner ? addr(q.expectedOwner, "expectedOwner") : null;
  if (expectedOwner) {
    const owner = addr(order.owner || list[0]?.owner || expectedOwner, "owner");
    if (owner !== expectedOwner) return { ok: false, provider: "cowswap", chainId, uid, reason: "owner mismatch", order, status, trades: list };
  }
  let executedBuy = 0n;
  for (const t of list.filter((t) => String(t.orderUid || "").toLowerCase() === uid)) {
    executedBuy += BigInt(tradeBuyAmount(t));
  }
  if (executedBuy === 0n && order.executedBuyAmount != null) executedBuy = BigInt(uintString(order.executedBuyAmount, "executedBuyAmount"));
  const minBuy = q.minBuyAmount != null ? BigInt(uintString(q.minBuyAmount, "minBuyAmount")) : 0n;
  const ok = executedBuy >= minBuy && (String(order.status || status?.status || "").toLowerCase() !== "expired");
  return {
    ok,
    provider: "cowswap",
    chainId,
    uid,
    status: order.status || status?.status || null,
    executedBuyAmount: executedBuy.toString(),
    minBuyAmount: q.minBuyAmount ?? null,
    trades: list,
    settlementTxs: [...new Set(list.map((t) => t.txHash).filter(Boolean))],
    order,
    orderStatus: status,
    reason: ok ? null : "insufficient fill or expired order",
  };
}

export function cowChains() {
  return Object.keys(COW_HOSTS).map(Number);
}
