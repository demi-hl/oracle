// Hyperliquid perpetuals: orders, leverage, and position management.
//
// PREPARE-ONLY. Every function here returns EIP-712 typed data plus the exact
// action payload the user's wallet will sign. Nothing in this file signs,
// submits, or broadcasts — there is deliberately no submit function, and a
// test asserts that no write-shaped export ever appears.
//
// Why the arithmetic is fussy: Hyperliquid rejects orders whose price or size
// carry more precision than the asset allows, and a rejected order at the wrong
// moment is indistinguishable from a missed fill. Prices allow at most 5
// significant figures and (6 - szDecimals) decimal places for perps; sizes are
// rounded to szDecimals. Integers are always allowed regardless of sig figs.
// We do that rounding here, once, in decimal — never through a float.

import { hlMetaAndAssetCtxs, hlAllMids } from "./hl-info.mjs";
import { resolveHlAsset } from "./hl-assets.mjs";
import { toScaledInteger } from "../../exact-integer.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";

export const HL_PERP_MAX_SIG_FIGS = 5;
export const HL_PERP_PRICE_DECIMALS = 6; // 6 - szDecimals for perps
export const HL_SIGNATURE_CHAIN_ID = "0x66eee";
export const ORACLE_HL_BUILDER_ADDRESS = "0x4d47B6757aFd42c3dbd9691b71B43d74Afa4b6b2";
export const ORACLE_HL_BUILDER_FEE_BPS = 5;
export const ORACLE_HL_BUILDER_FEE_TENTHS_BPS = ORACLE_HL_BUILDER_FEE_BPS * 10;

export const ORDER_TYPES = Object.freeze({
  LIMIT: "limit",
  MARKET: "market",
  STOP_MARKET: "stopMarket",
  STOP_LIMIT: "stopLimit",
  TAKE_PROFIT_MARKET: "takeProfitMarket",
  TAKE_PROFIT_LIMIT: "takeProfitLimit",
});

export const TIF = Object.freeze({
  GTC: "Gtc", // rest on the book
  IOC: "Ioc", // fill what you can, cancel the rest
  ALO: "Alo", // add liquidity only; rejected if it would cross
});

export const MARGIN_MODE = Object.freeze({
  CROSS: "cross",
  ISOLATED: "isolated",
});

/** Exact decimal rounding — no floats, so 0.1+0.2 problems cannot appear. */
function roundDecimal(value, maxDecimals, { roundDown = null } = {}) {
  // `value` may arrive as a JS number from price math; normalise without
  // exponent notation, which BigInt cannot parse.
  const text = typeof value === "number" ? value.toFixed(Math.min(20, maxDecimals + 8)) : String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`hl-perps: "${value}" is not a decimal number`);
  const neg = text.startsWith("-");
  const [intPart, fracPart = ""] = text.replace(/^-/, "").split(".");
  if (fracPart.length <= maxDecimals) {
    const trimmed = fracPart.replace(/0+$/, "");
    return (neg ? "-" : "") + (trimmed ? `${intPart}.${trimmed}` : intPart);
  }
  // Round on the exact decimal string. `roundDown` forces truncation (toward
  // zero) or ceiling, which callers use to guarantee a bound is never crossed
  // by the rounding itself; otherwise round half-up.
  const keep = fracPart.slice(0, maxDecimals);
  const nextDigit = Number(fracPart[maxDecimals]);
  let scaled = BigInt(intPart + keep);
  const remainder = fracPart.slice(maxDecimals).replace(/0+$/, "") !== "";
  if (roundDown === true) {
    // truncate: scaled already floors the magnitude
  } else if (roundDown === false) {
    if (remainder) scaled += 1n;
  } else if (nextDigit >= 5) {
    scaled += 1n;
  }
  const s = scaled.toString().padStart(maxDecimals + 1, "0");
  const cut = maxDecimals === 0 ? s : `${s.slice(0, -maxDecimals)}.${s.slice(-maxDecimals)}`;
  const cleaned = cut.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return (neg ? "-" : "") + cleaned;
}

/** Significant-figure clamp. Integers are exempt, per Hyperliquid's rule. */
function clampSigFigs(value, sigFigs, opts = {}) {
  const text = String(value);
  if (!text.includes(".")) return text; // integer prices are always allowed
  const n = Number(text);
  if (!Number.isFinite(n) || n === 0) return text;
  const magnitude = Math.floor(Math.log10(Math.abs(n)));
  const decimals = Math.max(0, sigFigs - 1 - magnitude);
  return roundDecimal(text, decimals, opts);
}

/**
 * Format a price for a given asset. Applies BOTH constraints: at most 5
 * significant figures AND at most (6 - szDecimals) decimal places.
 */
export function formatPerpPrice(price, szDecimals, opts = {}) {
  const maxDecimals = HL_PERP_PRICE_DECIMALS - Number(szDecimals ?? 0);
  if (maxDecimals < 0) throw new Error("hl-perps: szDecimals out of range");
  return roundDecimal(clampSigFigs(price, HL_PERP_MAX_SIG_FIGS, opts), maxDecimals, opts);
}

/** Format an order size to the asset's size precision. */
export function formatPerpSize(size, szDecimals) {
  const out = roundDecimal(size, Number(szDecimals ?? 0));
  if (BigInt(out.split(".")[0]) < 0n) throw new Error("hl-perps: size must be positive");
  if (Number(out) <= 0) throw new Error("hl-perps: size rounds to zero at this asset's precision");
  return out;
}

/** Resolve a coin to its asset index and precision. Required before ordering. */
export async function hlPerpAssetInfo(args = {}, opts = {}) {
  // Resolves main perps, HIP-3 builder dexs (dex:COIN), and HIP-4 outcomes (#N / outcome+side).
  const info = await resolveHlAsset(args, opts);
  return {
    coin: info.coin,
    assetId: info.assetId,
    szDecimals: info.szDecimals,
    maxLeverage: info.maxLeverage,
    markPx: info.markPx,
    kind: info.kind,
    dex: info.dex ?? null,
    outcome: info.outcome ?? null,
    side: info.side ?? null,
  };
}

function orderTypeWire(kind, { tif = TIF.GTC, triggerPx, isMarket, szDecimals } = {}) {
  switch (kind) {
    case ORDER_TYPES.LIMIT:
      return { limit: { tif } };
    case ORDER_TYPES.MARKET:
      // A "market" order on Hyperliquid is an IOC limit at an aggressive price.
      return { limit: { tif: TIF.IOC } };
    case ORDER_TYPES.STOP_MARKET:
    case ORDER_TYPES.TAKE_PROFIT_MARKET:
      return {
        trigger: {
          isMarket: true,
          triggerPx: formatPerpPrice(triggerPx, szDecimals),
          tpsl: kind === ORDER_TYPES.STOP_MARKET ? "sl" : "tp",
        },
      };
    case ORDER_TYPES.STOP_LIMIT:
    case ORDER_TYPES.TAKE_PROFIT_LIMIT:
      return {
        trigger: {
          isMarket: false,
          triggerPx: formatPerpPrice(triggerPx, szDecimals),
          tpsl: kind === ORDER_TYPES.STOP_LIMIT ? "sl" : "tp",
        },
      };
    default:
      throw new Error(`hl-perps: unknown order type ${kind}`);
  }
}

function envelope(action, nonce) {
  return {
    action,
    nonce,
    signatureChainId: HL_SIGNATURE_CHAIN_ID,
    submitTo: "https://api.hyperliquid.xyz/exchange",
    note: "Sign locally via @oracle-agent/operator or a wallet. Oracle does not submit.",
  };
}

/** Stamp a full HL prepare result (provider/kind + action envelope). */
function stamped(result) {
  return stampPrepared(result, { provider: result.provider || "hl-perps", kind: result.kind });
}

export function hlPrepareBuilderFeeApproval(args = {}) {
  const nonce = Number(args.nonce ?? Date.now());
  const action = {
    type: "approveBuilderFee",
    builder: ORACLE_HL_BUILDER_ADDRESS,
    maxFeeRate: `${ORACLE_HL_BUILDER_FEE_BPS / 100}%`,
    nonce,
  };
  return stamped({
    provider: "hl-perps",
    venue: "hyperliquid",
    kind: "hl-builder-fee-approval",
    builderAddress: ORACLE_HL_BUILDER_ADDRESS,
    builderFeeBps: ORACLE_HL_BUILDER_FEE_BPS,
    ...envelope(action, nonce),
    note: "Hyperliquid requires the main wallet to review and sign this builder-fee approval. Oracle does not sign or submit it.",
  });
}

/**
 * Prepare a perp order.
 *
 * Guardrails, all enforced BEFORE anything is built:
 *  - size and price rounded to the asset's exact precision
 *  - a limit order must state a price; a market order must state a slippage cap
 *  - `maxSlippageBps` is capped at 100 bps, matching every other Oracle venue
 *  - reduce-only is explicit, never inferred
 */
export async function hlPreparePerpOrder(args = {}, opts = {}) {
  const info = await hlPerpAssetInfo(args, opts);
  const kind = String(args.type || ORDER_TYPES.LIMIT);
  const isBuy = args.side ? String(args.side).toLowerCase() === "buy" : Boolean(args.isBuy);
  const reduceOnly = Boolean(args.reduceOnly);
  const size = formatPerpSize(args.size ?? args.sz, info.szDecimals);

  let price;
  if (kind === ORDER_TYPES.MARKET) {
    let mark = Number(info.markPx);
    if (!Number.isFinite(mark)) {
      const mids = await hlAllMids(opts);
      mark = Number(mids?.[info.coin] ?? mids?.[String(info.assetId)] ?? NaN);
    }
    if (!Number.isFinite(mark)) throw new Error("hl-perps: no mark price available for a market order");
    const bps = Number(args.maxSlippageBps ?? 50);
    if (!Number.isInteger(bps) || bps < 0) throw new Error("hl-perps: maxSlippageBps must be a non-negative integer");
    if (bps > 100) throw new Error(`hl-perps: maxSlippageBps ${bps} exceeds the hard 100 bps cap`);
    // Aggressive IOC price: cross the book by at most the allowed slippage.
    // Rounding to the venue's tick can push the limit BACK past the cap
    // (0.0012345 * 1.01 rounds to 0.001247 = 101.26 bps), so round toward the
    // mark — down for a buy, up for a sell — and verify the realised bps.
    const rawLimit = isBuy ? mark * (1 + bps / 10_000) : mark * (1 - bps / 10_000);
    price = formatPerpPrice(rawLimit, info.szDecimals, { roundDown: isBuy });
    const realisedBps = Math.abs(Number(price) / mark - 1) * 10_000;
    if (realisedBps > bps + 1e-9) {
      throw new Error(
        `hl-perps: tick rounding makes the limit ${realisedBps.toFixed(2)} bps from mark, above the ${bps} bps cap`
      );
    }
  } else {
    if (args.price == null && args.limitPx == null) {
      throw new Error("hl-perps: a limit order requires an explicit price");
    }
    price = formatPerpPrice(args.price ?? args.limitPx, info.szDecimals);
  }

  const orderType = orderTypeWire(kind, {
    tif: args.tif ?? (kind === ORDER_TYPES.MARKET ? TIF.IOC : TIF.GTC),
    triggerPx: args.triggerPx,
    szDecimals: info.szDecimals,
  });

  const order = {
    a: info.assetId,
    b: isBuy,
    p: price,
    s: size,
    r: reduceOnly,
    t: orderType,
  };
  if (args.clientOrderId) order.c = String(args.clientOrderId);

  const action = {
    type: "order",
    orders: [order],
    grouping: args.grouping || "na",
    builder: { b: ORACLE_HL_BUILDER_ADDRESS, f: ORACLE_HL_BUILDER_FEE_TENTHS_BPS },
  };

  const nonce = Number(args.nonce ?? Date.now());
  const notional = Number(price) * Number(size);

  return stamped({
    provider: "hl-perps",
    venue: "hyperliquid",
    kind: info.kind === "outcome" ? "hip4-order" : info.kind === "hip3" ? "hip3-order" : "perp-order",
    coin: info.coin,
    assetId: info.assetId,
    assetKind: info.kind,
    outcome: info.outcome ?? null,
    outcomeSide: info.side ?? null,
    dex: info.dex ?? null,
    side: isBuy ? "buy" : "sell",
    orderType: kind,
    price,
    size,
    reduceOnly,
    notionalUsd: Number.isFinite(notional) ? notional : null,
    maxLeverage: info.maxLeverage,
    markPx: info.markPx,
    builderAddress: ORACLE_HL_BUILDER_ADDRESS,
    builderFeeBps: ORACLE_HL_BUILDER_FEE_BPS,
    ...envelope(action, nonce),
  });
}

/** Prepare a cancel by order id. */
export async function hlPrepareCancelOrder(args = {}, opts = {}) {
  const info = await hlPerpAssetInfo(args, opts);
  const oid = args.orderId ?? args.oid;
  if (oid == null) throw new Error("hl-perps: orderId required");
  const action = { type: "cancel", cancels: [{ a: info.assetId, o: Number(oid) }] };
  return stamped({
    provider: "hl-perps",
    venue: "hyperliquid",
    kind: "perp-cancel",
    coin: info.coin,
    orderId: Number(oid),
    ...envelope(action, Number(args.nonce ?? Date.now())),
  });
}

/**
 * Prepare a leverage change.
 * Cross vs isolated is an explicit choice: isolated caps loss to the margin
 * posted on that position, cross shares the whole account balance.
 */
export async function hlPrepareUpdateLeverage(args = {}, opts = {}) {
  const info = await hlPerpAssetInfo(args, opts);
  const leverage = Number(args.leverage);
  if (!Number.isInteger(leverage) || leverage < 1) {
    throw new Error("hl-perps: leverage must be a positive integer");
  }
  if (info.maxLeverage != null && leverage > info.maxLeverage) {
    throw new Error(`hl-perps: ${info.coin} allows at most ${info.maxLeverage}x, requested ${leverage}x`);
  }
  const mode = String(args.marginMode || MARGIN_MODE.CROSS).toLowerCase();
  if (mode !== MARGIN_MODE.CROSS && mode !== MARGIN_MODE.ISOLATED) {
    throw new Error(`hl-perps: marginMode must be "cross" or "isolated"`);
  }
  const action = {
    type: "updateLeverage",
    asset: info.assetId,
    isCross: mode === MARGIN_MODE.CROSS,
    leverage,
  };
  return stamped({
    provider: "hl-perps",
    venue: "hyperliquid",
    kind: "perp-leverage",
    coin: info.coin,
    leverage,
    marginMode: mode,
    maxLeverage: info.maxLeverage,
    liquidationWarning:
      leverage >= 20
        ? `${leverage}x liquidates on roughly a ${(100 / leverage).toFixed(2)}% adverse move before fees`
        : null,
    ...envelope(action, Number(args.nonce ?? Date.now())),
  });
}

/** Prepare an isolated-margin adjustment for an existing position. */
export async function hlPrepareUpdateIsolatedMargin(args = {}, opts = {}) {
  const info = await hlPerpAssetInfo(args, opts);
  const usd = args.usd ?? args.amountUsd;
  if (usd == null) throw new Error("hl-perps: usd amount required");
  const text = String(usd).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error("hl-perps: usd must be a decimal number");
  // Hyperliquid takes this in micro-USD as an integer. The old padEnd() sized
  // the result from the NUMERIC magnitude, so "01.5" scaled 10x too small and
  // silently under-posted margin. Scale by exact string arithmetic instead.
  const micro = toScaledInteger(text, 6, "hl-perps: usd");
  const action = {
    type: "updateIsolatedMargin",
    asset: info.assetId,
    isBuy: true,
    ntli: micro <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micro) : micro.toString(),
  };
  return stamped({
    provider: "hl-perps",
    venue: "hyperliquid",
    kind: "perp-isolated-margin",
    coin: info.coin,
    usd: text,
    ...envelope(action, Number(args.nonce ?? Date.now())),
  });
}

/**
 * Prepare a bracket: entry plus take-profit and/or stop-loss as reduce-only
 * triggers. Grouped so the venue treats them as one position's protection.
 */
export async function hlPrepareBracketOrder(args = {}, opts = {}) {
  const entry = await hlPreparePerpOrder(args, opts);
  const info = await hlPerpAssetInfo(args, opts);
  const isBuy = entry.side === "buy";
  const orders = [entry.action.orders[0]];

  if (args.takeProfitPx != null) {
    orders.push({
      a: info.assetId,
      b: !isBuy,
      p: formatPerpPrice(args.takeProfitPx, info.szDecimals),
      s: entry.size,
      r: true,
      t: orderTypeWire(ORDER_TYPES.TAKE_PROFIT_MARKET, { triggerPx: args.takeProfitPx, szDecimals: info.szDecimals }),
    });
  }
  if (args.stopLossPx != null) {
    orders.push({
      a: info.assetId,
      b: !isBuy,
      p: formatPerpPrice(args.stopLossPx, info.szDecimals),
      s: entry.size,
      r: true,
      t: orderTypeWire(ORDER_TYPES.STOP_MARKET, { triggerPx: args.stopLossPx, szDecimals: info.szDecimals }),
    });
  }
  if (orders.length === 1) throw new Error("hl-perps: a bracket needs takeProfitPx and/or stopLossPx");

  const action = {
    type: "order",
    orders,
    grouping: "normalTpsl",
    builder: { b: ORACLE_HL_BUILDER_ADDRESS, f: ORACLE_HL_BUILDER_FEE_TENTHS_BPS },
  };
  return stamped({
    provider: "hl-perps",
    venue: "hyperliquid",
    kind: "perp-bracket",
    coin: info.coin,
    legs: orders.length,
    entry: { side: entry.side, price: entry.price, size: entry.size },
    takeProfitPx: args.takeProfitPx == null ? null : formatPerpPrice(args.takeProfitPx, info.szDecimals),
    stopLossPx: args.stopLossPx == null ? null : formatPerpPrice(args.stopLossPx, info.szDecimals),
    builderAddress: ORACLE_HL_BUILDER_ADDRESS,
    builderFeeBps: ORACLE_HL_BUILDER_FEE_BPS,
    ...envelope(action, Number(args.nonce ?? Date.now())),
  });
}
