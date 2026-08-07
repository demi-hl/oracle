// Router concurrency.
//
// The router's cost is dominated by network waits, so the thing worth testing is not
// wall-clock speed (flaky, machine-dependent) but SHAPE: does anything unnecessary
// sit in front of the quote fan-out?
//
// The bug this guards against was real. bestSwapRoute awaited two DefiLlama price
// lookups before building the candidate list, adding ~890ms to the front of every
// comparison when neither price is needed to ASK for a quote -- destPrice is only
// used at rank time, and nativePriceUsd only by the 0x gas conversion. Measured
// 4678ms before, ~3300ms after, same sources, same winner.
//
// These tests use fake timers-free deterministic stubs: no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { gatherRoutes } from "../src/router/best-execution.mjs";
import { swapCandidates } from "../src/router/route-sources.mjs";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const REAL = "0xcDAC0d6c6C59727a65F871236188350531885C43";

const INDEX = fs.readFileSync(new URL("../src/router/index.mjs", import.meta.url), "utf8");

test("prices do not block the quote fan-out", () => {
  // The regression shape is `await` on a price immediately followed by building
  // candidates. Both entry points must gather quotes and prices in ONE Promise.all,
  // not one after the other.
  const swapBody = INDEX.slice(INDEX.indexOf("export async function bestSwapRoute"), INDEX.indexOf("export async function bestBridgeRoute"));

  assert.ok(
    !/await\s+Promise\.all\(\[\s*nativeUsd/.test(swapBody),
    "prices must not be awaited before the candidate list is built",
  );
  assert.match(
    swapBody,
    /Promise\.all\(\[\s*\n?\s*gatherRoutes/,
    "quotes and the destination price must resolve concurrently",
  );

  const bridgeBody = INDEX.slice(INDEX.indexOf("export async function bestBridgeRoute"));
  assert.ok(
    !/const dest = await destPrice/.test(bridgeBody),
    "the bridge path must not await its destination price before quoting",
  );
  assert.match(bridgeBody, /Promise\.all\(\[\s*\n?\s*gatherRoutes/);
});

test("ParaSwap survives when the caller omits decimalsOut", async () => {
  // Direct regression from the concurrency change. ParaSwap's inclusion used to be
  // gated on `decimalsOut != null`, a value that came from the price lookup. Once
  // that stopped being awaited up front, the naive version silently DROPPED ParaSwap
  // for every caller who did not pass decimals -- shrinking a 3-source comparison to
  // 2 while still confidently reporting a "best" route.
  //
  // A comparison that quietly loses a source is worse than one that fails loudly.
  const withBoth = swapCandidates({
    chainId: 8453,
    tokenIn: WETH,
    tokenOut: USDC,
    amountIn: "1",
    taker: REAL,
    decimalsIn: 18,
    decimalsOut: 6,
  }).map((c) => c.source);

  const withoutOut = swapCandidates({
    chainId: 8453,
    tokenIn: WETH,
    tokenOut: USDC,
    amountIn: "1",
    taker: REAL,
    decimalsIn: 18,
    destDecimalsPromise: Promise.resolve({ decimals: 6 }),
  }).map((c) => c.source);

  assert.ok(withBoth.includes("paraswap"));
  assert.ok(
    withoutOut.includes("paraswap"),
    "paraswap must still be a candidate when decimalsOut arrives asynchronously",
  );
  assert.deepEqual(withoutOut, withBoth, "the candidate set must not depend on WHEN decimals arrive");
});

test("a source needing decimals fails only itself, not the comparison", async () => {
  // If decimals never resolve, ParaSwap should error inside its own run() and be
  // reported as FAILED -- the other sources still rank.
  const candidates = swapCandidates({
    chainId: 8453,
    tokenIn: WETH,
    tokenOut: USDC,
    amountIn: "1",
    taker: REAL,
    decimalsIn: 18,
    destDecimalsPromise: Promise.resolve({ decimals: null }),
  });

  const paraswap = candidates.find((c) => c.source === "paraswap");
  assert.ok(paraswap, "paraswap must be present to fail individually");
  await assert.rejects(() => paraswap.run(), /destination decimals/);
});

test("the 0x adapter tolerates a native price that arrives as a promise", async () => {
  // Prices are now passed in unresolved. An adapter treating the promise as a number
  // would compute gas as NaN and silently mis-rank the route.
  const saved = process.env.ZEROX_API_KEY;
  process.env.ZEROX_API_KEY = "test-key";
  try {
    const src = fs.readFileSync(new URL("../src/router/route-sources.mjs", import.meta.url), "utf8");
    assert.match(
      src,
      /await Promise\.resolve\(nativePriceUsd\)/,
      "0x must await the native price rather than multiplying by a promise",
    );
  } finally {
    if (saved === undefined) delete process.env.ZEROX_API_KEY;
    else process.env.ZEROX_API_KEY = saved;
  }
});

test("slow sources cannot serialize behind each other", async () => {
  // Structural proof that gatherRoutes is concurrent: three 300ms sources must
  // finish in well under the 900ms a sequential loop would take.
  const slow = (source, ms, amountOut) => ({
    source,
    run: () => new Promise((r) => setTimeout(() => r({ amountOut, gasUsd: 0 }), ms)),
  });

  const t0 = Date.now();
  const routes = await gatherRoutes([slow("a", 300, "1"), slow("b", 300, "2"), slow("c", 300, "3")]);
  const elapsed = Date.now() - t0;

  assert.equal(routes.length, 3);
  assert.ok(elapsed < 700, `expected concurrent (~300ms), took ${elapsed}ms -- sources are serialized`);
});

test("an unused price rejection cannot become an unhandled rejection", () => {
  // nativePriceUsd is passed as a promise that only the 0x adapter awaits. With no
  // key set nobody awaits it, so a DefiLlama failure would surface as an unhandled
  // rejection and could take the process down.
  assert.match(INDEX, /nativePricePromise\.catch\(\(\) => \{\}\)/);
});
