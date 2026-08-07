// Best-execution router tests.
//
// The router's whole reason to exist is that "biggest amountOut wins" is wrong. So
// the tests target the ways a comparison lies: unknown costs scored as zero, a
// spread quoted off a mismatched pair, one source's outage sinking the batch, and a
// single answer presented as if it beat something.
//
// All deterministic -- no network.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  QUALITY,
  normalizeRoute,
  rankRoutes,
  gatherRoutes,
  measurePriceImpact,
  applyImpactCeiling,
} from "../src/router/best-execution.mjs";

const route = (source, amountOut, gasUsd = null, extra = {}) =>
  normalizeRoute({ source, amountOut, gasUsd, ...extra });

// --- normalization ------------------------------------------------------------

test("a failed or empty source is FAILED, never a zero-output route", () => {
  // A route that "returned 0" and a route that "did not answer" are different facts.
  // Collapsing them would let an outage look like a terrible price.
  assert.equal(normalizeRoute({ source: "x", error: "timeout" }).quality, QUALITY.FAILED);
  assert.equal(normalizeRoute({ source: "x", amountOut: null }).quality, QUALITY.FAILED);
  assert.equal(normalizeRoute({ source: "x", amountOut: "0" }).quality, QUALITY.FAILED);
});

test("a route without gas is NO_GAS, not FULL", () => {
  assert.equal(route("a", "100").quality, QUALITY.NO_GAS);
  assert.equal(route("a", "100", 1.5).quality, QUALITY.FULL);
  // Zero is a MEASURED value (a solver-executed intent), not missing data.
  assert.equal(route("a", "100", 0).quality, QUALITY.FULL);
});

// --- the core claim -----------------------------------------------------------

test("a smaller gross quote wins when it costs less gas", () => {
  // The entire point. 1000 units out costing $50 loses to 995 out costing $1,
  // at a destination price of $1/unit with 0 decimals... use realistic scaling:
  // dest price $1, 6 decimals -> $50 = 50_000_000 units.
  const routes = [
    route("expensive", "1000000000", 50), // 1000.000000 gross
    route("cheap", "995000000", 1), //  995.000000 gross
  ];
  const r = rankRoutes(routes, { destPriceUsd: 1, destDecimals: 6 });
  assert.equal(r.best.source, "cheap", "net-of-gas must beat headline quote");
  assert.equal(r.rankedOn, "net-of-cost");
});

test("a gasless intent beats a slightly larger gas-paying quote", () => {
  // CoW-style: solver eats the gas. Naive ranking hands this to the loser.
  const routes = [
    route("amm", "1000000000", 12), // 1000 gross, $12 gas
    route("intent", "998000000", 0), //  998 gross, gasless
  ];
  const r = rankRoutes(routes, { destPriceUsd: 1, destDecimals: 6 });
  assert.equal(r.best.source, "intent");
});

test("trade size flips the answer, which is why a fixed preference is wrong", () => {
  const cheapGas = (out) => route("cheap", out, 1);
  const richGas = (out) => route("rich", out, 40);

  // Small trade: the $40 gas dominates a 0.5% edge.
  const small = rankRoutes([richGas("1005000000"), cheapGas("1000000000")], {
    destPriceUsd: 1,
    destDecimals: 6,
  });
  assert.equal(small.best.source, "cheap");

  // Large trade: the same 0.5% edge is worth far more than $39.
  const large = rankRoutes([richGas("100500000000"), cheapGas("100000000000")], {
    destPriceUsd: 1,
    destDecimals: 6,
  });
  assert.equal(large.best.source, "rich");
});

// --- honesty about what was measured ------------------------------------------

test("unknown gas is never silently scored as zero", () => {
  const r = rankRoutes([route("nogas", "1000000000"), route("known", "999000000", 1)], {
    destPriceUsd: 1,
    destDecimals: 6,
  });
  const nogas = r.routes.find((x) => x.source === "nogas");
  assert.equal(nogas.costAccounted, false);
  assert.ok(
    r.warnings.some((w) => /gas not reported by: nogas/.test(w)),
    "an unmeasured cost must be disclosed, since it flatters that route",
  );
});

test("no spread is quoted when the top two measure cost differently", () => {
  // Regression: computing the spread from the two best COST-ACCOUNTED routes while
  // the actual winner had unknown gas produced a number that read as
  // "winner beats runner-up by X" when it really compared third and fourth.
  const r = rankRoutes(
    [route("unmeasured", "1000000000"), route("a", "999000000", 1), route("b", "990000000", 1)],
    { destPriceUsd: 1, destDecimals: 6 },
  );
  assert.equal(r.best.source, "unmeasured");
  assert.equal(r.improvementBps, null, "a mismatched pair must not produce a spread claim");
  assert.equal(r.spreadBasis, null);
});

test("a spread IS quoted when the top two are comparable, and names its basis", () => {
  const r = rankRoutes([route("a", "1000000000", 1), route("b", "990000000", 1)], {
    destPriceUsd: 1,
    destDecimals: 6,
  });
  assert.ok(r.improvementBps > 0);
  assert.match(r.spreadBasis, /a vs b/);
});

test("without a destination price, ranking falls back to gross and says so", () => {
  const r = rankRoutes([route("a", "1000", 99), route("b", "999", 0)], {});
  assert.equal(r.rankedOn, "gross");
  assert.equal(r.best.source, "a"); // gross ordering
  assert.ok(
    r.warnings.some((w) => /GROSS output/.test(w)),
    "must warn that gas was not included",
  );
});

// --- resilience ---------------------------------------------------------------

test("a drained venue is rejected when its per-unit price collapses with size", async () => {
  const impact = await measurePriceImpact(async (amountIn) => amountIn <= 1000n ? amountIn * 10n : 100n, 1_000_000n);
  assert.ok(impact.impactPct > 99);
  const ranked = rankRoutes([route("drained", "1000000", 0)], { destPriceUsd: 1, destDecimals: 6 });
  const guarded = applyImpactCeiling(ranked, { drained: impact }, { maxImpactPct: 25 });
  assert.equal(guarded.best, null);
  assert.equal(guarded.impactRejected[0].source, "drained");
});

test("an unmeasured venue is disclosed instead of marked safe", () => {
  const ranked = rankRoutes([route("unknown", "1000000", 0)], { destPriceUsd: 1, destDecimals: 6 });
  const guarded = applyImpactCeiling(ranked, {}, { maxImpactPct: 25 });
  assert.equal(guarded.best.source, "unknown");
  assert.deepEqual(guarded.impactUnmeasured, ["unknown"]);
  assert.ok(guarded.warnings.some((warning) => /NOT measured/.test(warning)));
});

test("one source failing does not sink the comparison", async () => {
  // A router that is less reliable than calling one venue directly is pointless.
  const routes = await gatherRoutes([
    { source: "good", run: async () => ({ amountOut: "100", gasUsd: 1 }) },
    {
      source: "broken",
      run: async () => {
        throw new Error("HTTP 410 Gone");
      },
    },
  ]);
  const r = rankRoutes(routes, { destPriceUsd: 1, destDecimals: 0 });
  assert.equal(r.best.source, "good");
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].error, /410/);
});

test("a hung source is timed out rather than blocking forever", async () => {
  const routes = await gatherRoutes(
    [
      { source: "fast", run: async () => ({ amountOut: "100", gasUsd: 0 }) },
      { source: "hung", run: () => new Promise(() => {}) },
    ],
    { timeoutMs: 50 },
  );
  const hung = routes.find((r) => r.source === "hung");
  assert.equal(hung.quality, QUALITY.FAILED);
  assert.match(hung.error, /timeout/);
});

test("all sources failing yields no winner rather than a fabricated one", () => {
  const r = rankRoutes(
    [normalizeRoute({ source: "a", error: "down" }), normalizeRoute({ source: "b", error: "down" })],
    { destPriceUsd: 1, destDecimals: 6 },
  );
  assert.equal(r.best, null);
  assert.equal(r.failed.length, 2);
});
