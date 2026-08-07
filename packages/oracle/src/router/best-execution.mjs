// Best-execution router.
//
// The naive version of this picks the biggest amountOut and calls it a day. That is
// wrong often enough to matter, for three reasons:
//
//   1. GAS IS PART OF THE PRICE. A route that returns 0.2% more but costs $14 more
//      in gas is worse on a $500 swap and better on a $50k one. The crossover point
//      depends on trade size, so a fixed preference for "best quote" is wrong on one
//      side of it. We convert gas to the destination asset and subtract.
//
//   2. QUOTES ARE NOT COMMITMENTS. Aggregators return an expected output that moves
//      with the block. What protects you is minOut, so a route with a tight quote and
//      a hard guarantee can beat a fatter quote with a loose one.
//
//   3. SOURCES DISAGREE ABOUT WHAT THEY MEAN. Some return amounts net of fees, some
//      gross; some price gas in native, some in USD, some not at all. Comparing raw
//      fields across them is comparing different things wearing the same name.
//
// So: normalize every source to one shape, mark what is MEASURED vs MISSING, and rank
// on net output. Where a cost is unknown we say so rather than treating it as zero --
// silently scoring an unknown as free is how the worst route wins a comparison.

import { EVIDENCE } from "../scanner/contract.mjs";

/** How a route's numbers were obtained. Drives both ranking and disclosure. */
export const QUALITY = Object.freeze({
  // Output and gas both measured. Directly comparable.
  FULL: "FULL",
  // Output measured, gas unknown. Comparable only with the caveat stated.
  NO_GAS: "NO_GAS",
  // Source errored or returned nothing usable.
  FAILED: "FAILED",
});

/** Chain -> the coingecko-ish key DefiLlama uses for the native asset. */
const NATIVE_PRICE_KEY = {
  1: "coingecko:ethereum",
  10: "coingecko:ethereum",
  56: "coingecko:binancecoin",
  137: "coingecko:matic-network",
  8453: "coingecko:ethereum",
  42161: "coingecko:ethereum",
  43114: "coingecko:avalanche-2",
  999: "coingecko:ethereum",
};

const bn = (v) => {
  try {
    if (v == null || v === "") return null;
    return BigInt(String(v).split(".")[0]);
  } catch {
    return null;
  }
};

/**
 * Normalize one source's response into the shape the ranker consumes.
 *
 * Every field is explicit about whether it was measured. `gasUsd: null` means "we do
 * not know", never "free".
 */
export function normalizeRoute(raw) {
  const {
    source,
    amountOut,
    minOut = null,
    gasUsd = null,
    feeUsd = null,
    estimatedGas = null,
    error = null,
    executionReady = false,
    meta = {},
  } = raw || {};

  if (error || amountOut == null) {
    return {
      source,
      quality: QUALITY.FAILED,
      amountOut: null,
      error: error || "no amountOut returned",
    };
  }

  const out = bn(amountOut);
  if (out == null || out <= 0n) {
    return { source, quality: QUALITY.FAILED, amountOut: null, error: "non-positive amountOut" };
  }

  return {
    source,
    quality: gasUsd == null ? QUALITY.NO_GAS : QUALITY.FULL,
    amountOut: out.toString(),
    minOut: bn(minOut)?.toString() ?? null,
    gasUsd,
    feeUsd,
    estimatedGas: estimatedGas == null ? null : String(estimatedGas),
    executionReady,
    meta,
  };
}

/**
 * Measure how badly a route's price decays with size.
 *
 * WHY THIS EXISTS: a quote against a drained pool is indistinguishable, in shape,
 * from a quote against a deep one -- same fields, no error, just a smaller number.
 * Verified on Robinhood 2026-08-02: a dead Uniswap V3 SQUEEZE pool holding 7.03
 * USDG happily quoted a 205,374-token sell, and every layer downstream treated
 * that as truth. `minOut` does NOT protect against this: it guards the price
 * MOVING between quote and fill, so against a garbage quote it faithfully locks
 * in the garbage.
 *
 * The probe: quote a small slice of the same trade, compare per-unit prices. Real
 * slippage decays smoothly with size; a drained pool falls off a cliff.
 *
 * `probeFn(amountIn) -> amountOut | null`. Returns null when the comparison could
 * not be made, which callers MUST treat as unproven rather than as a pass.
 */
export async function measurePriceImpact(probeFn, amountIn, { divisor = 1000n } = {}) {
  const full = bn(amountIn);
  if (full == null || full <= 0n) return null;

  const probeAmt = full / divisor > 0n ? full / divisor : 1n;
  if (probeAmt >= full) return null; // too small to compare against itself

  let smallOut;
  let fullOut;
  try {
    [smallOut, fullOut] = await Promise.all([probeFn(probeAmt), probeFn(full)]);
  } catch {
    return null;
  }

  const s = bn(smallOut);
  const f = bn(fullOut);
  if (s == null || f == null || s <= 0n) return null;

  // Scale to compare per-unit prices without floating point until the last step.
  const smallPx = Number(s) / Number(probeAmt);
  const fullPx = Number(f) / Number(full);
  if (!Number.isFinite(smallPx) || !Number.isFinite(fullPx) || smallPx <= 0) return null;

  return {
    impactPct: (1 - fullPx / smallPx) * 100,
    probeAmountIn: probeAmt.toString(),
    probeAmountOut: s.toString(),
    fullAmountOut: f.toString(),
  };
}

/**
 * Reject routes whose price impact exceeds a ceiling.
 *
 * Applied AFTER ranking so the rejection is visible: a caller can see that the
 * nominal winner was dropped and why, rather than silently receiving second place.
 * A route with no impact measurement is NOT dropped here -- absence of evidence is
 * surfaced through `unmeasured` so the caller decides, but it is never presented
 * as a passing measurement.
 */
export function applyImpactCeiling(ranked, impacts, { maxImpactPct = 25 } = {}) {
  const rejected = [];
  const unmeasured = [];

  const kept = (ranked.routes ?? []).filter((r) => {
    const m = impacts?.[r.source];
    if (!m) {
      unmeasured.push(r.source);
      return true;
    }
    if (m.impactPct > maxImpactPct) {
      rejected.push({
        source: r.source,
        impactPct: Number(m.impactPct.toFixed(2)),
        reason:
          `price impact ${m.impactPct.toFixed(1)}% exceeds ${maxImpactPct}% ceiling -- ` +
          "the venue cannot absorb this size near the quoted price",
      });
      return false;
    }
    return true;
  });

  const warnings = [...(ranked.warnings ?? [])];
  if (rejected.length) {
    warnings.push(
      `dropped ${rejected.length} route(s) on price impact: ` +
        rejected.map((r) => `${r.source} (${r.impactPct}%)`).join(", "),
    );
  }
  if (unmeasured.length) {
    warnings.push(
      `price impact NOT measured for: ${unmeasured.join(", ")}. These are unproven ` +
        "against thin liquidity, not proven safe.",
    );
  }

  return {
    ...ranked,
    routes: kept,
    best: kept[0] ?? null,
    impactRejected: rejected,
    impactUnmeasured: unmeasured,
    warnings,
  };
}

/**
 * Rank normalized routes by NET output.
 *
 * net = amountOut - (gasUsd + feeUsd converted into the destination asset)
 *
 * Requires the destination asset's USD price and decimals to do the conversion. When
 * those are unavailable we fall back to gross ranking and SAY SO in the result, so a
 * caller is never left believing gas was accounted for when it was not.
 */
export function rankRoutes(routes, { destPriceUsd = null, destDecimals = null } = {}) {
  const usable = routes.filter((r) => r.quality !== QUALITY.FAILED);
  const failed = routes.filter((r) => r.quality === QUALITY.FAILED);

  const canNet =
    destPriceUsd != null && destPriceUsd > 0 && destDecimals != null && destDecimals >= 0;

  const scored = usable.map((r) => {
    const gross = BigInt(r.amountOut);
    let costInDest = 0n;
    let costAccounted = false;

    if (canNet) {
      const totalCostUsd = (r.gasUsd ?? 0) + (r.feeUsd ?? 0);
      if (totalCostUsd > 0) {
        // usd -> destination units
        const units = (totalCostUsd / destPriceUsd) * 10 ** destDecimals;
        if (Number.isFinite(units) && units >= 0) {
          costInDest = BigInt(Math.floor(units));
          costAccounted = true;
        }
      } else if (r.gasUsd === 0) {
        costAccounted = true; // genuinely gasless (e.g. an intent filled by a solver)
      }
    }

    const net = gross > costInDest ? gross - costInDest : 0n;
    return {
      ...r,
      grossOut: gross.toString(),
      netOut: net.toString(),
      costInDest: costInDest.toString(),
      costAccounted,
    };
  });

  // Sort by net desc. A route whose gas we could not measure sorts on gross, which
  // flatters it -- hence the explicit warning below rather than a silent ordering.
  scored.sort((a, b) => (BigInt(b.netOut) > BigInt(a.netOut) ? 1 : -1));

  const unaccounted = scored.filter((r) => !r.costAccounted).map((r) => r.source);
  const warnings = [];
  if (!canNet) {
    warnings.push(
      "destination price/decimals unavailable: ranked on GROSS output. Gas is not " +
        "included, so a cheap-looking route may cost more to execute.",
    );
  } else if (unaccounted.length) {
    warnings.push(
      `gas not reported by: ${unaccounted.join(", ")}. These are ranked on gross ` +
        "output and may be overstated relative to gas-measured routes.",
    );
  }

  // Spread between the winner and the runner-up -- but ONLY when that comparison is
  // apples to apples.
  //
  // Subtle trap worth naming: computing this from the two best COST-ACCOUNTED routes
  // while the actual winner has unknown gas produces a number that reads as "the
  // winner beats second place by X" when it is really "third beats fourth by X".
  // When the top route's cost is unmeasured, the honest answer is null.
  let improvementBps = null;
  let spreadBasis = null;
  if (scored.length >= 2 && scored[0].costAccounted && scored[1].costAccounted) {
    const best = BigInt(scored[0].netOut);
    const next = BigInt(scored[1].netOut);
    if (next > 0n) {
      improvementBps = Number(((best - next) * 10_000n) / next);
      spreadBasis = `${scored[0].source} vs ${scored[1].source}`;
    }
  }

  return {
    best: scored[0] ?? null,
    routes: scored,
    failed,
    improvementBps,
    spreadBasis,
    rankedOn: canNet ? "net-of-cost" : "gross",
    warnings,
  };
}

/**
 * Run every candidate source concurrently, tolerating individual failures.
 *
 * One aggregator being down, rate-limited, or missing an API key must never sink the
 * comparison -- that would make the router less reliable than calling a single venue
 * directly, which defeats the purpose.
 */
export async function gatherRoutes(candidates, { timeoutMs = 12_000 } = {}) {
  const withTimeout = (p, source) =>
    Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${source}: timeout`)), timeoutMs)),
    ]);

  const settled = await Promise.allSettled(
    candidates.map((c) => withTimeout(Promise.resolve().then(c.run), c.source)),
  );

  return settled.map((s, i) => {
    const source = candidates[i].source;
    if (s.status === "rejected") {
      return normalizeRoute({ source, error: String(s.reason?.message || s.reason) });
    }
    return normalizeRoute({ source, ...s.value });
  });
}

export { NATIVE_PRICE_KEY };
