// Prepare the winning route.
//
// The gap this closes: the router says "paraswap wins" and the user then has to
// rebuild that transaction through a completely different path, by hand, hoping they
// pick the same venue and parameters. That handoff is where the value of a
// comparison leaks away.
//
// Three things make this more than a thin wrapper:
//
//   1. QUOTES DECAY. The comparison ran at a past block. Preparing against that
//      number would carry a stale minOut into a signature -- the exact failure the
//      guard exists to prevent. So we RE-QUOTE, and if the fresh number is materially
//      worse we say so rather than quietly preparing a worse trade than the one the
//      user agreed to.
//
//   2. NOT EVERY WINNER IS A TRANSACTION. CoW returns EIP-712 typed data for an
//      off-chain order; LI.FI/ParaSwap/0x return an unsigned EVM transaction. These
//      are different artifacts requiring different wallet actions, and collapsing
//      them into one "prepared" shape would hand someone typed data where they
//      expected a tx. The artifact kind is explicit and always stated.
//
//   3. THE DESTINATION IS THE ATTACK SURFACE. A prepared transaction is a `to` plus
//      opaque calldata. If that address is wrong, nothing downstream saves you. It is
//      echoed prominently and checked against the quoting venue.
//
// Custody is unchanged: this returns artifacts to sign. It cannot sign or broadcast.

import { bestSwapRoute } from "./index.mjs";
import { stampPrepared } from "../prepare-envelope.mjs";

export const ARTIFACT = Object.freeze({
  /** Unsigned EVM transaction: wallet signs and broadcasts it. */
  TRANSACTION: "unsigned-transaction",
  /** EIP-712 payload: wallet signs data; a solver settles on-chain. No broadcast. */
  TYPED_DATA_ORDER: "typed-data-order",
});

/**
 * How much the re-quote may fall below the comparison before we refuse.
 *
 * Not zero: prices move between blocks and a hard-zero tolerance would make prepare
 * fail constantly for no safety benefit. But bounded, because "the route you picked
 * is now 4% worse" is a decision the user should get to make again.
 */
const DEFAULT_DRIFT_TOLERANCE_BPS = 100;

const PREPARERS = {
  // On-chain Uniswap V3. Unlike the aggregators below, this builds calldata from the
  // chain's own router rather than an API's transaction payload — which is what makes
  // chains no aggregator indexes (e.g. Robinhood 4663) preparable at all.
  //
  // The provider stamps requiresUserSignature:true / signingReady:false /
  // broadcastReady:false. Preparing is NOT permission to execute: the wallet is still
  // the only thing that can authorize this, and the unattended daemon surface list
  // (hl, poly) is deliberately unchanged by adding this.
  "uniswap-v3": async ({ chainId, tokenIn, tokenOut, amountIn, taker }, opts) => {
    const { uniV3PrepareExactIn } = await import("../data/providers/uniswap-v3.mjs");
    const p = await uniV3PrepareExactIn(
      { chainId, tokenIn, tokenOut, amountIn, recipient: taker },
      opts,
    );
    return {
      artifactKind: ARTIFACT.TRANSACTION,
      transaction: p.transaction,
      requiresApproval: p.requiresApproval ?? null,
      amountOut: p.quote?.amountOut ?? null,
      minOut: p.quote?.amountOutMinimum ?? null,
    };
  },

  "uniswap-v4": async ({ chainId, tokenIn, tokenOut, amountIn, taker, slippageBps, fee, tickSpacing, hooks }, opts) => {
    const { uniV4PrepareExactIn } = await import("../data/providers/uniswap-v4.mjs");
    const p = await uniV4PrepareExactIn(
      { chainId, tokenIn, tokenOut, amountIn, recipient: taker, slippageBps, fee, tickSpacing, hooks },
      opts,
    );
    return {
      artifactKind: ARTIFACT.TRANSACTION,
      transaction: p.transaction,
      requiresApproval: p.requiresApproval,
      amountOut: p.quote?.amountOut ?? null,
      minOut: p.quote?.amountOutMinimum ?? null,
      prepareReady: true,
      executionReady: false,
    };
  },

  lifi: async ({ chainId, tokenIn, tokenOut, amountIn, taker }, opts) => {
    const { lifiPrepare } = await import("../data/providers/lifi.mjs");
    const p = await lifiPrepare(
      { fromChain: chainId, toChain: chainId, fromToken: tokenIn, toToken: tokenOut, fromAmount: amountIn, fromAddress: taker },
      opts,
    );
    return {
      artifactKind: ARTIFACT.TRANSACTION,
      transaction: p.transaction,
      requiresApproval: p.requiresApproval ?? null,
      amountOut: p.quote?.estimate?.toAmount ?? null,
      minOut: p.quote?.estimate?.toAmountMin ?? null,
    };
  },

  paraswap: async ({ chainId, tokenIn, tokenOut, amountIn, taker, decimalsIn, decimalsOut }, opts) => {
    const { paraswapPrepare } = await import("../data/providers/paraswap.mjs");
    const p = await paraswapPrepare(
      { chainId, srcToken: tokenIn, destToken: tokenOut, amount: amountIn, srcDecimals: decimalsIn, destDecimals: decimalsOut, userAddress: taker, side: "SELL" },
      opts,
    );
    return {
      artifactKind: ARTIFACT.TRANSACTION,
      transaction: p.transaction,
      requiresApproval: p.requiresApproval ?? null,
      amountOut: p.quote?.priceRoute?.destAmount ?? null,
      minOut: p.quote?.amountOutMinimum ?? null,
    };
  },

  "0x": async ({ chainId, tokenIn, tokenOut, amountIn, taker }, opts) => {
    const { zeroxPrepare } = await import("../data/providers/zerox.mjs");
    const p = await zeroxPrepare(
      { chainId, sellToken: tokenIn, buyToken: tokenOut, sellAmount: amountIn, taker },
      opts,
    );
    return {
      artifactKind: ARTIFACT.TRANSACTION,
      transaction: p.transaction,
      requiresApproval: p.requiresApproval ?? null,
      amountOut: p.quote?.buyAmount ?? null,
      minOut: p.quote?.minBuyAmount ?? null,
    };
  },

  cow: async ({ chainId, tokenIn, tokenOut, amountIn, taker }, opts) => {
    const { cowPrepareOrder } = await import("../data/providers/cowswap.mjs");
    const p = await cowPrepareOrder(
      { chainId, sellToken: tokenIn, buyToken: tokenOut, sellAmountBeforeFee: String(amountIn), from: taker },
      opts,
    );
    return {
      // Deliberately NOT a transaction. The wallet signs typed data and a solver
      // settles it; there is nothing to broadcast, and treating this as a tx would
      // produce a confusing failure at signing time.
      artifactKind: ARTIFACT.TYPED_DATA_ORDER,
      typedData: p.typedData,
      // The relayer is what needs the ERC-20 allowance for CoW, NOT the settlement
      // contract. Approving the wrong one produces an order that can never fill.
      requiresApproval: {
        token: tokenIn,
        spender: p.vaultRelayer,
        amount: String(amountIn),
        note: "CoW pulls funds via the vault relayer, not the settlement contract",
      },
      settlement: p.settlement,
      amountOut: p.quote?.quote?.buyAmount ?? null,
      minOut: null,
      submission: "sign the typed data, then submit the order to the CoW API",
    };
  },
};

export function supportedPreparers() {
  return Object.keys(PREPARERS);
}

/**
 * Addresses that are fine for QUOTING but must never reach a prepare call.
 *
 * The quote placeholder exists so aggregators that demand a `from` will price a route
 * for an anonymous caller. Passing it to prepare is a category error: you would be
 * building a transaction for the burn address.
 *
 * Some venues catch this and some do not, which is the dangerous part. ParaSwap
 * rejects it with "userAddress must be a valid address" (verified live), while other
 * venues will happily build a transaction addressed to nobody. Relying on the venue
 * to notice is relying on the least careful one.
 */
const NON_TAKER_ADDRESSES = new Set(
  [
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000000001",
    "0x00000000000000000000000000000000000a1ce5",
  ].map((a) => a.toLowerCase()),
);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Compare routes, then prepare the winner.
 *
 * @param {object} p same shape as bestSwapRoute, plus:
 * @param {string} [p.source] force a specific source instead of the winner
 * @param {number} [p.driftToleranceBps]
 */
export async function prepareBestRoute(p, opts = {}) {
  const { taker } = p;
  if (!taker) {
    throw new Error(
      "prepareBestRoute requires taker: a prepared transaction is built FOR an " +
        "address, and the quote-only placeholder must never end up in one",
    );
  }
  if (!ADDRESS_RE.test(taker)) {
    throw new Error(`taker must be a valid 20-byte address, got "${taker}"`);
  }
  if (NON_TAKER_ADDRESSES.has(taker.toLowerCase())) {
    throw new Error(
      `taker "${taker}" is a placeholder/burn address. It is valid for quoting but ` +
        "not for preparing -- that would build a transaction for an address nobody " +
        "controls. Pass the real wallet that will sign.",
    );
  }

  const comparison = await bestSwapRoute(p, opts);
  if (!comparison.best) {
    // A liquidity rejection is a DIFFERENT failure from "nobody answered", and
    // conflating them hides the reason a live venue was refused.
    const blocked = comparison.impactRejected ?? [];
    return {
      ok: false,
      reason: blocked.length
        ? blocked[0].reason
        : "no source returned a usable route",
      priceImpactBlocked: blocked.length > 0,
      impactRejected: blocked,
      comparison,
    };
  }

  // Honour an explicit override, but never silently: picking a non-winner is a
  // legitimate choice (a user may distrust a venue) and it should be visible.
  const chosenSource = p.source || comparison.best.source;
  const chosen = comparison.routes.find((r) => r.source === chosenSource);
  if (!chosen) {
    return {
      ok: false,
      reason: `source "${chosenSource}" did not return a usable route`,
      comparison,
    };
  }

  const prepare = PREPARERS[chosenSource];
  if (!prepare) {
    // Honest failure beats a fabricated transaction. Name the fallback.
    const alt = comparison.routes.find((r) => PREPARERS[r.source] && r.source !== chosenSource);
    return {
      ok: false,
      reason:
        `${chosenSource} won the comparison but has no prepare path in this build. ` +
        (alt
          ? `Next preparable route is ${alt.source}; pass source:"${alt.source}" to use it.`
          : "No route in this comparison can be prepared."),
      comparison,
      winner: chosenSource,
    };
  }

  let prepared;
  try {
    prepared = await prepare(p, opts);
  } catch (err) {
    // Read the API's actual complaint, not just the HTTP status line.
    //
    // httpJson throws `HTTP 400 POST <url>` and attaches the parsed response to
    // err.body. Matching only err.message would classify every venue rejection as a
    // generic "provider-error", which is how a fixable user-side problem ("you have
    // not approved yet") gets reported as an opaque failure.
    const detail =
      typeof err?.body === "string"
        ? err.body
        : err?.body
          ? JSON.stringify(err.body)
          : "";
    const msg = [String(err?.message || err), detail].filter(Boolean).join(" :: ");

    // Translate the two failures that will confuse people most.
    //
    // Several venues validate on-chain state before building calldata:
    //   * "Not enough WETH balance"   -- the taker does not hold the input token
    //   * "Not enough WETH allowance" -- the approval does not exist YET
    //
    // The allowance case is the important one, and it is a genuine ordering
    // constraint rather than a bug: ParaSwap will not build swap calldata until the
    // TokenTransferProxy is already approved. So the honest flow is approve first,
    // then prepare -- which is exactly why requiresApproval is a separate step in
    // this API instead of being bundled into one "just sign this" blob.
    //
    // Reporting the raw HTTP 400 would read as "the router is broken" when the user
    // simply has not approved yet.
    const allowanceIssue = /allowance/i.test(msg);
    const balanceIssue = !allowanceIssue && /not enough|insufficient|balance/i.test(msg);

    let reason;
    let failureKind;
    if (allowanceIssue) {
      failureKind = "approval-required-first";
      reason =
        `${chosenSource} will not build swap calldata until the token approval ` +
        `exists on-chain. Approve the spender first, then prepare again. ` +
        `Underlying: ${msg}`;
    } else if (balanceIssue) {
      failureKind = "taker-not-funded";
      reason =
        `${chosenSource} refused to build the transaction: ${msg}. This venue ` +
        `verifies the taker holds the input token. Quoting works for any address; ` +
        `preparing needs the real funded wallet.`;
    } else {
      failureKind = "provider-error";
      reason = `${chosenSource} prepare failed: ${msg}`;
    }

    // Name a preparable alternative so a blocked winner is not a dead end.
    const alt = comparison.routes.find(
      (r) => PREPARERS[r.source] && r.source !== chosenSource,
    );

    return {
      ok: false,
      reason,
      failureKind,
      ...(alt ? { alternative: alt.source } : {}),
      comparison,
    };
  }

  // Drift check. The comparison is already stale; this is the number that will
  // actually be signed against.
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
            `route moved ${(driftBps / 100).toFixed(2)}% against you between the ` +
            `comparison and this prepare (tolerance ${(tolerance / 100).toFixed(2)}%). ` +
            "The ranking may no longer hold -- re-run the comparison before signing.";
        }
      }
    } catch {
      /* leave null rather than invent a drift figure */
    }
  }

  const runnersUp = comparison.routes
    .filter((r) => r.source !== chosenSource)
    .map((r) => ({ source: r.source, netOut: r.netOut, gasUsd: r.gasUsd }));

  return stampPrepared({
    ok: true,
    chosen: {
      source: chosenSource,
      wasWinner: chosenSource === comparison.best.source,
      netOut: chosen.netOut,
      grossOut: chosen.grossOut,
      gasUsd: chosen.gasUsd,
    },
    // Carry the liquidity measurement through to the caller. Without this the
    // guard runs but its result is invisible, so a consumer cannot tell a route
    // that PASSED the ceiling from one that was never measured at all.
    priceImpact: comparison.priceImpact ?? null,
    impactUnmeasured: comparison.impactUnmeasured ?? [],
    ...prepared,
    unsigned: true,
    signedBy: "user-wallet",
    // The single most security-relevant field: where value goes.
    destination:
      prepared.artifactKind === ARTIFACT.TRANSACTION
        ? prepared.transaction?.to ?? null
        : prepared.settlement ?? null,
    driftBps,
    warnings: [
      ...(driftWarning ? [driftWarning] : []),
      ...(comparison.warnings || []),
      ...(prepared.artifactKind === ARTIFACT.TYPED_DATA_ORDER
        ? [
            "This is an ORDER to sign, not a transaction to broadcast. Signing it " +
              "authorizes a solver to settle on your behalf.",
          ]
        : []),
    ],
    runnersUp,
    comparison: {
      rankedOn: comparison.rankedOn,
      sourcesAnswered: comparison.sourcesAnswered,
      sourcesTried: comparison.sourcesTried,
      improvementBps: comparison.improvementBps,
    },
    note:
      "UNSIGNED. Verify the destination address and minOut against a fresh quote " +
      "immediately before signing -- a quote-time minimum is not a minimum at " +
      "broadcast time.",
  }, { provider: "router", kind: "best-route" });
}
