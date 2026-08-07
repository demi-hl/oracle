// deBridge DLN cross-chain bridge provider.
//
// deBridge operates a decentralized liquidity network (DLN) for native
// cross-chain value transfer. This module is read/prepare only — it quotes
// routes and prepares unsigned transaction artifacts.
//
// Public API: https://dln.debridge.finance/v1.0
// Docs: https://docs.dln.debridge.finance
//
// Never signs, never broadcasts, never holds keys.

import { httpJson } from "../http.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";

export const DEBRIDGE_API = "https://dln.debridge.finance/v1.0";

const SUPPORTED_CHAIN_IDS = new Set([
  1, 10, 56, 137, 8453, 42161, 43114, 59144, 534352, 7777777, 324, 5000, 1101, 81457,
]);

/**
 * Quote a cross-chain route through deBridge DLN.
 * @returns {{ estimation: object, order: object, fixFee: string } | { error: string }}
 */
export async function debridgeQuote({
  srcChainId,
  srcChainTokenIn,
  srcChainTokenInAmount,
  dstChainId,
  dstChainTokenOut,
  slippage = 100, // bps, default 1%
  affiliateFeePercent = "0",
} = {}) {
  if (!srcChainId || !dstChainId || !srcChainTokenIn || !dstChainTokenOut || !srcChainTokenInAmount) {
    return { error: "debridge quote requires srcChainId, dstChainId, srcChainTokenIn, dstChainTokenOut, srcChainTokenInAmount" };
  }
  if (!SUPPORTED_CHAIN_IDS.has(Number(srcChainId)) || !SUPPORTED_CHAIN_IDS.has(Number(dstChainId))) {
    return { error: `debridge: unsupported chain pair ${srcChainId} -> ${dstChainId}` };
  }

  try {
    const body = {
      srcChainId: String(srcChainId),
      srcChainTokenIn,
      srcChainTokenInAmount: String(srcChainTokenInAmount),
      dstChainId: String(dstChainId),
      dstChainTokenOut,
      slippage,
      affiliateFeePercent,
    };

    const data = await httpJson(`${DEBRIDGE_API}/dln/order/quote`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });

    if (data.error) return { error: String(data.error) };

    return {
      estimation: data.estimation ?? {},
      order: data.order ?? {},
      fixFee: data.fixFee ?? "0",
    };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

/**
 * Check deBridge API health and supported chain pairs.
 */
export async function debridgeHealth() {
  try {
    const chains = await httpJson(`${DEBRIDGE_API}/supported-chains-info`);
    return { ok: true, chainCount: chains?.chains?.length ?? 0 };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}

/**
 * Prepare an unsigned deBridge transaction for a quoted order.
 * Follows the same custody contract: requiresWalletSignature, backendSigner false.
 */
export async function debridgePrepare(quote, { taker } = {}) {
  if (!taker) throw new Error("debridge prepare requires taker address");

  try {
    const body = {
      srcChainId: quote.order?.srcChainId ?? quote.srcChainId,
      dstChainId: quote.order?.dstChainId ?? quote.dstChainId,
      srcChainTokenIn: quote.order?.srcChainTokenIn ?? quote.srcChainTokenIn,
      dstChainTokenOut: quote.order?.dstChainTokenOut ?? quote.dstChainTokenOut,
      srcChainTokenInAmount: quote.order?.srcChainTokenInAmount ?? quote.srcChainTokenInAmount,
      order: quote.order,
    };

    const data = await httpJson(`${DEBRIDGE_API}/dln/order/create-tx`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });

    return stampPrepared(data.tx ?? data, { taker, source: "debridge" });
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}
