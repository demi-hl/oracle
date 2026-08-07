// Prepare a cross-chain bridge route.
//
// Bridging differs from swapping in ways that matter for a signable artifact:
//
//   1. IT IS OFTEN MULTIPLE TRANSACTIONS. Relay can return an approval and a deposit
//      as separate items. A caller handed a bare "transaction" would sign the first
//      and believe they were done, leaving funds approved but not bridged. So the
//      artifact is always a LIST, and its length is stated.
//
//   2. THE DESTINATION CHAIN IS PART OF THE TRUST DECISION. Every transaction here
//      executes on the ORIGIN chain, but the value lands elsewhere. Signing an
//      origin-chain tx that credits the wrong destination is unrecoverable, so
//      toChainId is echoed alongside the destination address.
//
//   3. TIME IS A REAL COST. A bridge that saves $2 and takes 30 minutes is not
//      obviously better than one costing $2 more that lands in 20 seconds. Duration
//      is surfaced, never folded into a score.
//
//   4. FINALITY IS NOT ATOMIC. The origin transaction succeeding does NOT mean funds
//      arrived. That gap is where users panic, so it is stated explicitly rather than
//      left implied.
//
// Custody is unchanged: artifacts only. This module cannot sign or broadcast.

import { bestBridgeRoute } from "./index.mjs";
import { stampPrepared } from "../prepare-envelope.mjs";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Placeholder addresses: fine for quoting, never for preparing.
 * Same reasoning as the swap path -- some venues catch this and some do not.
 */
const NON_TAKER_ADDRESSES = new Set(
  [
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000000001",
    "0x00000000000000000000000000000000000a1ce5",
  ].map((a) => a.toLowerCase()),
);

const DEFAULT_DRIFT_TOLERANCE_BPS = 100;

const PREPARERS = {
  relay: async ({ fromChainId, toChainId, tokenIn, tokenOut, amountIn, taker }, opts) => {
    const { relayPrepare } = await import("../data/providers/bridges.mjs");
    const p = await relayPrepare(
      {
        user: taker,
        originChainId: fromChainId,
        destinationChainId: toChainId,
        originCurrency: tokenIn,
        destinationCurrency: tokenOut,
        amount: String(amountIn),
      },
      opts,
    );
    return {
      transactions: p.transactions || [],
      amountOut: p.quote?.details?.currencyOut?.amount ?? null,
      minOut: p.quote?.details?.currencyOut?.minimumAmount ?? null,
      durationSeconds: p.quote?.details?.timeEstimate ?? null,
    };
  },

  lifi: async ({ fromChainId, toChainId, tokenIn, tokenOut, amountIn, taker, isHolder }, opts) => {
    const { lifiPrepare } = await import("../data/providers/lifi.mjs");
    const p = await lifiPrepare(
      {
        fromChain: fromChainId,
        toChain: toChainId,
        fromToken: tokenIn,
        toToken: tokenOut,
        fromAmount: amountIn,
        fromAddress: taker,
        // A bridge is not a same-chain swap: more routing, longer settlement,
        // more failure modes. Priced on its own tier.
        isHolder,
        feeAction: "bridge",
      },
      opts,
    );
    // LI.FI returns a single transactionRequest. Normalized into a list so callers
    // handle one shape regardless of source -- a single-item list is honest, a bare
    // object next to Relay's list is a trap.
    return {
      transactions: p.transaction ? [p.transaction] : [],
      requiresApproval: p.requiresApproval ?? null,
      amountOut: p.quote?.estimate?.toAmount ?? null,
      minOut: p.quote?.estimate?.toAmountMin ?? null,
      durationSeconds: p.quote?.estimate?.executionDuration ?? null,
    };
  },
};

export function supportedBridgePreparers() {
  return Object.keys(PREPARERS);
}

/**
 * Compare bridge routes, then prepare the winner.
 *
 * @param {object} p same shape as bestBridgeRoute, plus:
 * @param {string} p.taker the real wallet that will sign
 * @param {string} [p.source] force a specific source
 * @param {number} [p.driftToleranceBps]
 */
export async function prepareBestBridgeRoute(p, opts = {}) {
  const { taker, fromChainId, toChainId } = p;

  if (!taker) {
    throw new Error(
      "prepareBestBridgeRoute requires taker: bridge transactions are built FOR an " +
        "address, and the quote-only placeholder must never end up in one",
    );
  }
  if (!ADDRESS_RE.test(taker)) {
    throw new Error(`taker must be a valid 20-byte address, got "${taker}"`);
  }
  if (NON_TAKER_ADDRESSES.has(taker.toLowerCase())) {
    throw new Error(
      `taker "${taker}" is a placeholder/burn address. Bridging to it would send ` +
        "funds to an address nobody controls, on a chain where you cannot undo it.",
    );
  }

  const comparison = await bestBridgeRoute(p, opts);
  if (!comparison.best) {
    return { ok: false, reason: "no source returned a usable bridge route", comparison };
  }

  const chosenSource = p.source || comparison.best.source;
  const chosen = comparison.routes.find((r) => r.source === chosenSource);
  if (!chosen) {
    return { ok: false, reason: `source "${chosenSource}" returned no usable route`, comparison };
  }

  const prepare = PREPARERS[chosenSource];
  if (!prepare) {
    const alt = comparison.routes.find((r) => PREPARERS[r.source] && r.source !== chosenSource);
    return {
      ok: false,
      reason:
        `${chosenSource} won the comparison but has no bridge prepare path in this ` +
        `build. ` +
        (alt
          ? `Next preparable route is ${alt.source}; pass source:"${alt.source}".`
          : "No route in this comparison can be prepared."),
      // Machine-readable siblings of the message above. A caller should not have to
      // regex prose to find the fallback -- and the CLI/agent path reads these.
      failureKind: "no-prepare-path",
      ...(alt ? { alternative: alt.source } : {}),
      winner: chosenSource,
      comparison,
    };
  }

  let prepared;
  try {
    prepared = await prepare(p, opts);
  } catch (err) {
    const detail =
      typeof err?.body === "string" ? err.body : err?.body ? JSON.stringify(err.body) : "";
    const msg = [String(err?.message || err), detail].filter(Boolean).join(" :: ");

    const allowanceIssue = /allowance/i.test(msg);
    const balanceIssue = !allowanceIssue && /not enough|insufficient|balance/i.test(msg);
    const alt = comparison.routes.find((r) => PREPARERS[r.source] && r.source !== chosenSource);

    return {
      ok: false,
      reason: allowanceIssue
        ? `${chosenSource} will not build calldata until the token approval exists ` +
          `on-chain. Approve first, then prepare again. Underlying: ${msg}`
        : balanceIssue
          ? `${chosenSource} refused to build: ${msg}. Quoting works for any address; ` +
            `preparing needs the real funded wallet on chain ${fromChainId}.`
          : `${chosenSource} bridge prepare failed: ${msg}`,
      failureKind: allowanceIssue
        ? "approval-required-first"
        : balanceIssue
          ? "taker-not-funded"
          : "provider-error",
      ...(alt ? { alternative: alt.source } : {}),
      comparison,
    };
  }

  const txs = prepared.transactions || [];
  if (!txs.length) {
    return {
      ok: false,
      reason: `${chosenSource} returned no executable transaction for this route`,
      failureKind: "provider-error",
      comparison,
    };
  }

  // Every transaction must execute on the ORIGIN chain. A wrong chainId here means a
  // wallet could be prompted on the wrong network, and the user would be signing
  // something they cannot reason about.
  const wrongChain = txs.filter(
    (t) => t.chainId != null && Number(t.chainId) !== Number(fromChainId),
  );
  if (wrongChain.length) {
    return {
      ok: false,
      reason:
        `${chosenSource} returned a transaction for chain ${wrongChain[0].chainId} but ` +
        `the origin chain is ${fromChainId}. Refusing to hand over a mismatched ` +
        `artifact.`,
      failureKind: "chain-mismatch",
      comparison,
    };
  }

  // Drift against the comparison. Same reasoning as swaps: the comparison is stale.
  const tolerance = p.driftToleranceBps ?? DEFAULT_DRIFT_TOLERANCE_BPS;
  let driftBps = null;
  let driftWarning = null;
  if (prepared.amountOut != null && chosen.grossOut != null) {
    try {
      const then = BigInt(chosen.grossOut);
      const now = BigInt(prepared.amountOut);
      if (then > 0n) {
        driftBps = Number(((now - then) * 10_000n) / then);
        if (driftBps < -tolerance) {
          driftWarning =
            `route moved ${(driftBps / 100).toFixed(2)}% against you since the ` +
            `comparison (tolerance ${(tolerance / 100).toFixed(2)}%). Re-compare ` +
            `before signing.`;
        }
      }
    } catch {
      /* no fabricated drift */
    }
  }

  const warnings = [
    ...(driftWarning ? [driftWarning] : []),
    ...(comparison.warnings || []),
    // The single most common bridging surprise.
    `Bridging is NOT atomic: the origin transaction succeeding does not mean funds ` +
      `arrived on chain ${toChainId}. Expect ~${
        prepared.durationSeconds != null ? `${prepared.durationSeconds}s` : "minutes"
      } before the destination credits, and do not re-send if it is pending.`,
  ];

  if (txs.length > 1) {
    warnings.push(
      `This route needs ${txs.length} transactions signed IN ORDER. Signing only the ` +
        `first leaves funds approved but not bridged.`,
    );
  }

  return stampPrepared({
    ok: true,
    chosen: {
      source: chosenSource,
      wasWinner: chosenSource === comparison.best.source,
      netOut: chosen.netOut,
      grossOut: chosen.grossOut,
      gasUsd: chosen.gasUsd,
    },
    artifactKind: "unsigned-transaction-sequence",
    fromChainId: Number(fromChainId),
    toChainId: Number(toChainId),
    transactionCount: txs.length,
    transactions: txs,
    requiresApproval: prepared.requiresApproval ?? null,
    minOut: prepared.minOut ?? null,
    durationSeconds: prepared.durationSeconds ?? null,
    // Where value goes on the origin chain. The first destination is the bridge entry.
    destination: txs[0]?.to ?? null,
    unsigned: true,
    signedBy: "user-wallet",
    driftBps,
    warnings,
    runnersUp: comparison.routes
      .filter((r) => r.source !== chosenSource)
      .map((r) => ({ source: r.source, netOut: r.netOut, gasUsd: r.gasUsd })),
    comparison: {
      rankedOn: comparison.rankedOn,
      sourcesAnswered: comparison.sourcesAnswered,
      sourcesTried: comparison.sourcesTried,
      improvementBps: comparison.improvementBps,
    },
    note:
      `UNSIGNED. ${txs.length} transaction(s) on chain ${fromChainId}, crediting ` +
      `chain ${toChainId}. Verify every destination address before signing.`,
  }, { provider: "router", kind: "best-bridge" });
}
