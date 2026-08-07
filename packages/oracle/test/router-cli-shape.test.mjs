import { test } from "node:test";
import assert from "node:assert/strict";

import { bestSwapRoute } from "../src/router/index.mjs";

// Both bugs below were found by recording the CLI for the marketing site: the
// terminal printed "sources: undefined/undefined answered" and a bare
// "undefined" note, then claimed "0.00% better than the runner-up" on a real
// edge. Nothing in the suite covered the shape the CLI actually renders.

const BASE = 8453;
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

test("swap result always carries the provenance fields the CLI renders", async () => {
  // maxImpactPct: null takes the non-guarded return path.
  const plain = await bestSwapRoute(
    {
      chainId: BASE,
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: (10n ** 18n).toString(),
      decimalsIn: 18,
      decimalsOut: 6,
    },
    { maxImpactPct: null, timeoutMs: 20_000 },
  );

  for (const field of ["sourcesTried", "sourcesAnswered", "note"]) {
    assert.ok(field in plain, `missing ${field}`);
    assert.notEqual(plain[field], undefined, `${field} must not be undefined`);
  }
  assert.equal(typeof plain.sourcesTried, "number");
  assert.equal(typeof plain.sourcesAnswered, "number");
  assert.equal(typeof plain.note, "string");
  assert.ok(plain.note.length > 0);
  assert.doesNotMatch(plain.note, /undefined/);
});

test("the impact-guarded path carries the same provenance fields", async () => {
  // The default path measures price impact and returns EARLY. That early return
  // used to drop sourcesTried/sourcesAnswered/note entirely, so the CLI printed
  // "undefined" on exactly the swaps that were most carefully checked.
  const guarded = await bestSwapRoute(
    {
      chainId: BASE,
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: (10n ** 18n).toString(),
      decimalsIn: 18,
      decimalsOut: 6,
    },
    { timeoutMs: 20_000 },
  );

  for (const field of ["sourcesTried", "sourcesAnswered", "note"]) {
    assert.ok(field in guarded, `guarded path missing ${field}`);
    assert.notEqual(guarded[field], undefined, `guarded ${field} must not be undefined`);
  }
  assert.doesNotMatch(guarded.note, /undefined/);
  assert.ok(guarded.sourcesTried >= guarded.sourcesAnswered);
});

test("a sub-basis-point edge is never reported as 0.00%", async () => {
  // Rounding a real edge to "0.00% better" reads as "no edge". On size that is
  // money. This cannot be tested against live quotes because the real margin
  // varies per run, so drive the formatter with a pinned sub-bp improvement.
  const { formatComparisonNote } = await import("../src/router/index.mjs");

  // Near-zero: claiming an edge in ANY unit is false precision.
  const tied = formatComparisonNote({
    best: { source: "paraswap" },
    routes: [{}, {}],
    rankedOn: "net-of-cost",
    improvementBps: 0.004,
    spreadBasis: "paraswap vs cow",
  }, 5);
  assert.doesNotMatch(tied, /\b0\.00(%|bps) better\b/, "must not claim a 0.00 edge in any unit");
  assert.match(tied, /effectively tied with the runner-up/);
  assert.match(tied, /inside quote noise/);

  // Sub-bp but real: report bps, do not round to 0.00%.
  const subBp = formatComparisonNote({
    best: { source: "paraswap" },
    routes: [{}, {}],
    rankedOn: "net-of-cost",
    improvementBps: 0.78,
    spreadBasis: "paraswap vs cow",
  }, 5);
  assert.doesNotMatch(subBp, /\b0\.00% better\b/, "sub-bp edge must not round to 0.00%");
  assert.match(subBp, /0\.78bps better than the runner-up/);

  const wide = formatComparisonNote({
    best: { source: "paraswap" },
    routes: [{}, {}],
    rankedOn: "net-of-cost",
    improvementBps: 29,
    spreadBasis: "paraswap vs cow",
  }, 5);
  assert.match(wide, /0\.29% better than the runner-up/, "normal edges still read as %");
});
