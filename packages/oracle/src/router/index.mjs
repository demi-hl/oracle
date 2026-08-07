// Public entry point: find the best swap or bridge route.
//
// Returns a ranked comparison, not just a winner. Showing the runners-up and the
// spread is what lets a caller sanity-check the result instead of trusting it -- and
// a one-source "best route" is not a comparison at all, so that case is labelled
// rather than presented as if it beat something.

import {
  gatherRoutes, rankRoutes, QUALITY, measurePriceImpact, applyImpactCeiling,
} from "./best-execution.mjs";
import { swapCandidates, bridgeCandidates, nativeUsd } from "./route-sources.mjs";
import { llamaPrices } from "../data/providers/defillama.mjs";

/** DefiLlama key for an ERC-20 on a given chain. */
const LLAMA_CHAIN = {
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  137: "polygon",
  8453: "base",
  42161: "arbitrum",
  43114: "avax",
};

async function destPrice(chainId, token, opts) {
  const chain = LLAMA_CHAIN[Number(chainId)];
  if (!chain) return { priceUsd: null, decimals: null };
  const key = `${chain}:${token}`;
  try {
    const res = await llamaPrices([key], opts);
    const hit = res?.coins?.[key];
    const p = Number(hit?.price);
    const d = Number(hit?.decimals);
    return {
      priceUsd: Number.isFinite(p) ? p : null,
      decimals: Number.isFinite(d) ? d : null,
    };
  } catch {
    return { priceUsd: null, decimals: null };
  }
}

/**
 * Best same-chain swap route.
 *
 * @param {object} p
 * @param {number} p.chainId
 * @param {string} p.tokenIn
 * @param {string} p.tokenOut
 * @param {string|bigint} p.amountIn  raw units of tokenIn
 * @param {string} [p.taker]          address used for quoting only
 * @param {number} [p.decimalsIn]     enables ParaSwap
 * @param {number} [p.decimalsOut]    enables ParaSwap + net ranking
 */
export async function bestSwapRoute(p, opts = {}) {
  const { chainId, tokenIn, tokenOut, amountIn } = p;
  if (chainId == null || !tokenIn || !tokenOut || amountIn == null) {
    throw new Error("bestSwapRoute requires chainId, tokenIn, tokenOut, amountIn");
  }

  // Prices and quotes run CONCURRENTLY, not one after the other.
  //
  // The obvious shape -- await the prices, then fan out the quotes -- adds the price
  // latency to every single comparison. Measured on Base: ~890ms of DefiLlama in
  // front of ~3.3s of quotes, for 4.7s total when the true floor is 3.3s.
  //
  // Neither price is needed to ASK for a quote:
  //   * destPrice is only used at RANK time, after every quote has returned
  //   * nativePriceUsd is only used by the 0x adapter to convert its native-wei gas
  //     figure, so it is passed as a PROMISE and awaited inside that one adapter
  //
  // So the whole price fetch hides behind the slowest quote instead of preceding it.
  const nativePricePromise = nativeUsd(chainId, opts);
  const destPromise = destPrice(chainId, tokenOut, opts);

  const candidates = swapCandidates({
    ...p,
    nativePriceUsd: nativePricePromise,
    decimalsOut: p.decimalsOut,
    destDecimalsPromise: destPromise,
    opts,
  });

  const [routes, dest] = await Promise.all([
    gatherRoutes(candidates, { timeoutMs: opts.timeoutMs ?? 12_000 }),
    destPromise,
  ]);

  // Swallow an unused rejection so a failed price lookup cannot surface as an
  // unhandled rejection when no adapter happened to await it.
  nativePricePromise.catch(() => {});

  const ranked = rankRoutes(routes, {
    destPriceUsd: dest.priceUsd,
    destDecimals: p.decimalsOut ?? dest.decimals,
  });

  // Liquidity check. Ranking alone will happily crown a quote taken against a
  // drained pool, because a thin venue returns a well-formed number rather than
  // an error. Re-quote the winner at 1/1000th size and compare per-unit price:
  // real slippage decays smoothly, a dead pool falls off a cliff.
  //
  // Opt out with `maxImpactPct: null` for callers that genuinely want the raw
  // ranking (analytics, spread display) rather than an executable route.
  const maxImpactPct = opts.maxImpactPct === undefined ? 25 : opts.maxImpactPct;
  if (maxImpactPct != null && ranked.best) {
    const winner = ranked.best.source;
    const probe = async (amt) => {
      const sub = swapCandidates({
        ...p,
        amountIn: amt.toString(),
        nativePriceUsd: nativePricePromise,
        decimalsOut: p.decimalsOut,
        destDecimalsPromise: destPromise,
        opts,
      }).filter((c) => c.source === winner);
      if (!sub.length) return null;
      const got = await gatherRoutes(sub, { timeoutMs: opts.timeoutMs ?? 12_000 });
      return got?.[0]?.amountOut ?? null;
    };

    const impact = await measurePriceImpact(probe, amountIn);
    if (impact) {
      const guarded = applyImpactCeiling(ranked, { [winner]: impact }, { maxImpactPct });
      return {
        kind: "swap",
        chainId,
        tokenIn,
        tokenOut,
        amountIn: String(amountIn),
        ...guarded,
        // Provenance travels with the guarded result too. Omitting it here made
        // the CLI print "sources: undefined/undefined answered" and a bare
        // "undefined" note on exactly the swaps that DID get impact-measured.
        sourcesTried: candidates.length,
        sourcesAnswered: routes.filter((r) => r.quality !== QUALITY.FAILED).length,
        note: describe(guarded, candidates.length),
        priceImpact: { [winner]: Number(impact.impactPct.toFixed(2)) },
      };
    }
  }

  return {
    kind: "swap",
    chainId,
    tokenIn,
    tokenOut,
    amountIn: String(amountIn),
    ...ranked,
    sourcesTried: candidates.length,
    sourcesAnswered: routes.filter((r) => r.quality !== QUALITY.FAILED).length,
    note: describe(ranked, candidates.length),
  };
}

/**
 * Best cross-chain bridge route.
 *
 * Duration is reported, never folded into the score. A route that saves $2 and takes
 * 30 minutes is not strictly better than one costing $2 more that lands in 20
 * seconds -- that trade-off belongs to the caller, and burying it in a single number
 * would hide the only thing distinguishing two similar quotes.
 */
export async function bestBridgeRoute(p, opts = {}) {
  const { fromChainId, toChainId, tokenIn, tokenOut, amountIn } = p;
  if (fromChainId == null || toChainId == null || !tokenIn || !tokenOut || amountIn == null) {
    throw new Error(
      "bestBridgeRoute requires fromChainId, toChainId, tokenIn, tokenOut, amountIn",
    );
  }
  if (Number(fromChainId) === Number(toChainId)) {
    throw new Error("bestBridgeRoute is for cross-chain; use bestSwapRoute for same-chain");
  }

  // Same concurrency rule as swaps: the destination price is only needed at RANK
  // time, so fetching it before the quotes would add its latency to every bridge
  // comparison for no reason.
  const destPromise = destPrice(toChainId, tokenOut, opts);
  const candidates = bridgeCandidates({ ...p, opts });
  const [routes, dest] = await Promise.all([
    gatherRoutes(candidates, { timeoutMs: opts.timeoutMs ?? 15_000 }),
    destPromise,
  ]);
  const ranked = rankRoutes(routes, {
    destPriceUsd: dest.priceUsd,
    destDecimals: p.decimalsOut ?? dest.decimals,
  });

  const durations = ranked.routes
    .map((r) => ({ source: r.source, seconds: r.meta?.durationSeconds ?? null }))
    .filter((d) => d.seconds != null);

  return {
    kind: "bridge",
    fromChainId,
    toChainId,
    tokenIn,
    tokenOut,
    amountIn: String(amountIn),
    ...ranked,
    durations,
    sourcesTried: candidates.length,
    sourcesAnswered: routes.filter((r) => r.quality !== QUALITY.FAILED).length,
    note: describe(ranked, candidates.length),
  };
}

function describe(ranked, tried) {
  if (!ranked.best) return "no source returned a usable route";
  const answered = ranked.routes.length;
  if (answered === 1) {
    return (
      `only 1 of ${tried} sources answered, so this is the ONLY route, not a proven ` +
      "best one. Treat it as unbenchmarked."
    );
  }
  if (ranked.improvementBps != null) {
    const bps = ranked.improvementBps;
    const pct = bps / 100;
    // Below 0.01bps the winner is a coin flip against quote noise, so claiming
    // an edge in ANY unit is a false precision claim. Say they are tied.
    if (bps < 0.01) {
      return (
        `best of ${answered} routes, ranked on ${ranked.rankedOn}: ` +
        `effectively tied with the runner-up (${ranked.spreadBasis}), ` +
        "inside quote noise. Re-quote before you size up."
      );
    }
    // A sub-bp edge is still an edge and on size it is real money, so report it
    // in bps rather than letting the percentage round it away to 0.00%.
    const margin = pct >= 0.01 ? `${pct.toFixed(2)}%` : `${bps.toFixed(2)}bps`;
    return (
      `best of ${answered} routes, ranked on ${ranked.rankedOn}: ` +
      `${margin} better than the runner-up ` +
      `(${ranked.spreadBasis})`
    );
  }
  // No spread claim when the top two are not measured the same way. Saying "X% better"
  // off a mismatched pair is worse than saying nothing.
  return (
    `best of ${answered} routes, ranked on ${ranked.rankedOn}. No spread quoted: the ` +
    "top routes report cost differently, so the margin is not comparable."
  );
}

export { QUALITY };

// Exported for tests: the note text is a user-facing claim about execution
// quality, so it needs deterministic coverage independent of live quotes.
export { describe as formatComparisonNote };
