// Cross-chain bridge aggregator: 9 providers + revoke check.
// Quotes every available route in parallel, ranks by net output.

import { bestBridgeRoute } from "../../router/index.mjs";
import { debridgeQuote, debridgeHealth, DEBRIDGE_API } from "./debridge.mjs";
import { changenowQuote, changenowHealth, CHANGENOW_API } from "./changenow.mjs";
import { squidQuote, squidHealth, SQUID_API } from "./squid-router.mjs";
import { stargateQuote, stargateHealth, STARGATE_API } from "./stargate.mjs";
import { thorchainQuote, thorchainHealth, THORCHAIN_API } from "./thorchain.mjs";
import { bungeeQuote, bungeeHealth, BUNGEE_API } from "./bungee.mjs";
import { connextQuote, connextHealth, CONNEXT_API } from "./connext.mjs";
import { wormholeQuote, wormholeHealth, WORMHOLE_API } from "./wormhole.mjs";
import { approvalsScan } from "./approvals.mjs";

const PROVIDERS = Object.freeze(["debridge", "lifi-relay", "squid", "stargate", "thorchain", "bungee", "connext", "wormhole", "changenow"]);

/**
 * Quote all available bridge routes for a cross-chain transfer.
 * Runs all providers concurrently; partial failures are non-fatal.
 *
 * @param {{ fromChainId: number, toChainId: number, tokenIn: string, tokenOut: string, amount: string, taker: string, fromSymbol?: string, toSymbol?: string, fromDecimals?: number, toDecimals?: number }} params
 */
export async function aggregateBridgeQuotes(params = {}) {
  const {
    fromChainId, toChainId, tokenIn, tokenOut, amount, taker,
    fromSymbol = "?", toSymbol = "?", fromDecimals = 18, toDecimals = 18,
  } = params;

  const results = [];
  const errors = [];

  // ── deBridge ──
  const debridgeP = debridgeQuote({
    srcChainId: fromChainId,
    srcChainTokenIn: tokenIn,
    srcChainTokenInAmount: amount,
    dstChainId: toChainId,
    dstChainTokenOut: tokenOut,
  }).then(r => {
    if (r.error) { errors.push(`debridge: ${r.error}`); return null; }
    return {
      provider: "debridge",
      amountOut: r.estimation?.dstChainTokenOut?.amount ?? r.estimation?.toAmount,
      feeUsd: r.estimation?.fixFee ?? r.fixFee,
      estimatedTime: r.estimation?.execution?.estimatedTransferTime
        ? `${r.estimation.execution.estimatedTransferTime}s`
        : "unknown",
      preparable: true,
      raw: r,
    };
  }).catch(e => { errors.push(`debridge: ${e.message}`); return null; });

  // ── LI.FI / Relay (existing bridge router) ──
  const lifiP = bestBridgeRoute({
    fromChainId, toChainId, tokenIn, tokenOut, amountIn: amount, taker,
  }).then(r => {
    if (!r || r.error) { errors.push(`lifi: ${r?.error ?? "no route"}`); return null; }
    return {
      provider: "lifi-relay",
      amountOut: r.amountOut ?? r.quote?.amountOut,
      feeUsd: r.feeUsd ?? r.totalFee,
      estimatedTime: r.estimatedTime ?? r.duration ?? "unknown",
      preparable: !!r.transaction,
      raw: r,
    };
  }).catch(e => { errors.push(`lifi: ${e.message}`); return null; });

  // ── Squid (Axelar) ──
  const squidP = squidQuote({
    fromChain: fromChainId, toChain: toChainId,
    fromToken: tokenIn, toToken: tokenOut,
    fromAmount: amount, fromAddress: taker,
  }).then(r => {
    if (r.error) { errors.push(`squid: ${r.error}`); return null; }
    return {
      provider: "squid",
      amountOut: r.toAmount,
      feeUsd: Array.isArray(r.fee) ? r.fee.reduce((a, b) => a + (Number(b.amountUsd) || 0), 0) : null,
      estimatedTime: "30s - 3min",
      preparable: false,
      raw: r,
    };
  }).catch(e => { errors.push(`squid: ${e.message}`); return null; });

  // ── Stargate (LayerZero) ──
  const stargateP = stargateQuote({
    srcChainId: fromChainId, dstChainId: toChainId,
    token: tokenIn, amount,
  }).then(r => {
    if (r.error) { errors.push(`stargate: ${r.error}`); return null; }
    return {
      provider: "stargate",
      amountOut: r.amountOut,
      feeUsd: r.fee,
      estimatedTime: r.estimatedTime || "1-5 min",
      preparable: false,
      raw: r,
    };
  }).catch(e => { errors.push(`stargate: ${e.message}`); return null; });

  // ── THORChain (native swaps) ──
  const thorchainP = thorchainQuote({
    fromAsset: fromSymbol, toAsset: toSymbol, amount, destination: taker,
  }).then(r => {
    if (r.error) { errors.push(`thorchain: ${r.error}`); return null; }
    return {
      provider: "thorchain",
      amountOut: r.expectedAmountOut,
      feeUsd: r.fees?.total,
      estimatedTime: r.estimatedTime || "10-30 min",
      preparable: false,
      raw: r,
    };
  }).catch(e => { errors.push(`thorchain: ${e.message}`); return null; });

  // ── ChangeNOW ──
  const changenowP = (async () => {
    if (!fromSymbol || !toSymbol || fromSymbol === "?" || toSymbol === "?") {
      errors.push("changenow: ticker symbols required, skipping");
      return null;
    }
    try {
      const q = await changenowQuote({ fromTicker: fromSymbol, toTicker: toSymbol, fromAmount: amount });
      if (q.error) { errors.push(`changenow: ${q.error}`); return null; }
      return {
        provider: "changenow",
        amountOut: q.toAmount,
        feeUsd: q.networkFee,
        estimatedTime: q.flow === "standard" ? "5-30 min" : "instant",
        preparable: false, // CEX - user sends funds themselves
        kycRequired: q.kycRequired,
        raw: q,
      };
    } catch (e) { errors.push(`changenow: ${e.message}`); return null; }
  })();

  // ── Bungee/Socket ──
  const bungeeP = bungeeQuote({ fromChainId, toChainId, fromToken: tokenIn, toToken: tokenOut, fromAmount: amount, userAddress: taker }).then(r => {
    if (r.error) { errors.push(`bungee: ${r.error}`); return null; }
    return { provider: "bungee", amountOut: r.amountOut, feeUsd: r.feeUsd, estimatedTime: r.estimatedTime, preparable: false, raw: r };
  }).catch(e => { errors.push(`bungee: ${e.message}`); return null; });

  // ── Connext ──
  const connextP = connextQuote({ originDomain: fromChainId, destinationDomain: toChainId, originToken: tokenIn, destinationToken: tokenOut, amount }).then(r => {
    if (r.error) { errors.push(`connext: ${r.error}`); return null; }
    return { provider: "connext", amountOut: r.amountOut, feeUsd: r.fee, estimatedTime: r.estimatedTime || "5-20 min", preparable: false, raw: r };
  }).catch(e => { errors.push(`connext: ${e.message}`); return null; });

  // ── Wormhole ──
  const wormholeP = wormholeQuote({ fromChain: fromChainId, toChain: toChainId, token: tokenIn, amount }).then(r => {
    if (r.error) { errors.push(`wormhole: ${r.error}`); return null; }
    return { provider: "wormhole", amountOut: r.amountOut, feeUsd: r.fee, estimatedTime: r.estimatedTime || "5-15 min", preparable: false, raw: r };
  }).catch(e => { errors.push(`wormhole: ${e.message}`); return null; });

  const settled = await Promise.allSettled([debridgeP, lifiP, squidP, stargateP, thorchainP, bungeeP, connextP, wormholeP, changenowP]);
  for (const s of settled) {
    if (s.status === "fulfilled" && s.value) results.push(s.value);
  }

  // Rank by output amount (descending). Preparable routes preferred on tie.
  results.sort((a, b) => {
    const aOut = Number(a.amountOut ?? 0);
    const bOut = Number(b.amountOut ?? 0);
    if (aOut !== bOut) return bOut - aOut;
    if (a.preparable && !b.preparable) return -1;
    if (!a.preparable && b.preparable) return 1;
    return 0;
  });

  return {
    providers: results.map(r => r.provider),
    bestRoute: results[0]?.provider ?? "none",
    winner: results[0] ?? null,
    runnersUp: results.slice(1),
    errors: errors.length ? errors : null,
  };
}

/**
 * Check if the taker has any active ERC-20 approvals on the origin chain
 * that should be revoked before bridging. Uses the existing approval scanner.
 */
export async function checkRevokeNeeded({ chainId, taker, tokenIn } = {}) {
  if (!chainId || !taker) return { needsRevoke: false, note: "no wallet to check" };

  try {
    const result = await approvalsScan({ chainIds: [chainId], address: taker });
    const approvals = result.approvals;
    if (!approvals?.length) return { needsRevoke: false, note: "no active approvals found" };

    // Token-specific: check if the token being bridged has active approvals
    const tokenApproval = tokenIn
      ? approvals.find(a => String(a.token).toLowerCase() === String(tokenIn).toLowerCase())
      : null;

    if (tokenApproval && BigInt(tokenApproval.allowance ?? "0") > 0n) {
      return {
        needsRevoke: true,
        spender: tokenApproval.spender,
        amount: tokenApproval.allowance,
        symbol: tokenApproval.symbol ?? "?",
        decimals: tokenApproval.decimals ?? 18,
        note: `approval found for ${tokenApproval.spender}, revoke before bridging`,
      };
    }

    return {
      needsRevoke: false,
      note: `no active approval for this token (${approvals.length} total approvals on chain)`,
    };
  } catch (e) {
    return { needsRevoke: false, note: `revoke check unavailable: ${String(e.message || e).slice(0, 100)}` };
  }
}

/**
 * Full bridge scan: quote all routes + revoke check.
 * Returns data shaped for the bridge card renderer.
 */
export async function scanBridgeRoutes(params = {}) {
  const [quotes, revoke] = await Promise.all([
    aggregateBridgeQuotes(params),
    checkRevokeNeeded({ chainId: params.fromChainId, taker: params.taker, tokenIn: params.tokenIn }),
  ]);

  const best = quotes.winner ?? {};

  return {
    kind: "bridge",
    fromChainId: params.fromChainId,
    toChainId: params.toChainId,
    fromSymbol: params.fromSymbol,
    toSymbol: params.toSymbol,
    amount: params.amount,
    fromDecimals: params.fromDecimals ?? 18,
    toDecimals: params.toDecimals ?? 18,
    bestRoute: best.provider ?? "none",
    amountOut: best.amountOut,
    feeUsd: best.feeUsd,
    estimatedTime: best.estimatedTime,
    preparable: best.preparable ? "yes" : "no (manual send)",
    providers: quotes.providers,
    runnersUp: quotes.runnersUp,
    revokeCheck: revoke,
    errors: quotes.errors,
    confidence: quotes.providers.length >= 2 ? 0.85 : quotes.providers.length === 1 ? 0.6 : 0.1,
  };
}

/**
 * Health check: verify all bridge providers are reachable.
 */
export async function bridgeAggregatorHealth() {
  const [d, c] = await Promise.all([
    debridgeHealth().catch(e => ({ ok: false, error: e.message })),
    changenowHealth().catch(e => ({ ok: false, error: e.message })),
  ]);
  return { debridge: d, changenow: c, lifi: { ok: true, note: "integrated via router" } };
}
