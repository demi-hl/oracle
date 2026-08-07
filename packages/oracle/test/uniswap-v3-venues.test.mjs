import test from "node:test";
import assert from "node:assert/strict";
import { UNI_V3_CHAINS, UNI_V3_VENUES, uniV3QuoteExactIn } from "../src/data/providers/uniswap-v3.mjs";

const WHYPE = "0x5555555555555555555555555555555555555555";
const USDT0 = "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb";
const AMOUNT = (10n ** 17n).toString();

// A chain with no canonical Uniswap v3 deployment must never quote against an
// undefined router. HyperEVM has HyperSwap, not Uniswap -- naming the fork as the
// chain default would label it canonical.
test("venue-required chain refuses a bare quote", async () => {
  assert.equal(UNI_V3_CHAINS[999].quoter, undefined);
  await assert.rejects(
    () => uniV3QuoteExactIn({ chainId: 999, tokenIn: WHYPE, tokenOut: USDT0, amountIn: AMOUNT }),
    /no canonical Uniswap v3 deployment/,
  );
});

test("unknown venue fails closed and does not advertise unselectable names", async () => {
  await assert.rejects(
    () => uniV3QuoteExactIn({ chainId: 999, venue: "ghostdex", tokenIn: WHYPE, tokenOut: USDT0, amountIn: AMOUNT }),
    (err) => {
      assert.match(err.message, /unknown venue "ghostdex"/);
      // "hyperevm" is not selectable on a venue-required chain, so offering it
      // in the known list would send the caller straight into another refusal.
      assert.doesNotMatch(err.message, /known:[^)]*hyperevm/);
      return true;
    },
  );
});

// Guards the mislabel that nearly shipped: 0xb88339CB answers symbol() as "USDC",
// not USDT0. Only the verified USD-T0 address belongs in the chain config.
test("hyperevm stable is the verified USDT0 address", () => {
  assert.equal(UNI_V3_CHAINS[999].usdc, USDT0);
  assert.notEqual(
    UNI_V3_CHAINS[999].usdc.toLowerCase(),
    "0xb88339cb7199b77e23db6e890353e22632ba630f",
  );
});

test("registered forks carry their own quoter and router", () => {
  const hs = UNI_V3_VENUES[999]?.hyperswap;
  assert.ok(hs, "hyperswap must be registered on 999");
  assert.match(hs.quoter, /^0x[a-fA-F0-9]{40}$/);
  assert.match(hs.router, /^0x[a-fA-F0-9]{40}$/);
  assert.notEqual(hs.quoter.toLowerCase(), hs.router.toLowerCase());
});

// Every existing caller passes no venue. That path must be untouched.
test("canonical chains still resolve with no venue", () => {
  for (const id of [1, 8453, 42161]) {
    assert.match(UNI_V3_CHAINS[id].quoter, /^0x[a-fA-F0-9]{40}$/);
    assert.match(UNI_V3_CHAINS[id].router, /^0x[a-fA-F0-9]{40}$/);
  }
});

// PancakeSwap V3's middle tier is 2500 and fee 3000 REVERTS. A global tier list
// would skip its real pools and make a live venue look dead, so the fork carries
// its own tiers and 3000 must never appear in them.
test("pancakeswap venues carry their own fee tiers without 3000", () => {
  for (const chainId of [56, 8453, 42161]) {
    const v = UNI_V3_VENUES[chainId]?.pancakeswap;
    assert.ok(v, `pancakeswap must be registered on ${chainId}`);
    assert.ok(Array.isArray(v.feeTiers) && v.feeTiers.length, "must define feeTiers");
    assert.ok(v.feeTiers.includes(2500), "2500 is pancakeswap's middle tier");
    assert.ok(!v.feeTiers.includes(3000), "3000 reverts on pancakeswap");
  }
});

// Venues are only registered after a functional probe checked against an
// independent spot price. Pharaoh on Avalanche had 4,842 bytes of quoter code and
// returned a number -- 24x off spot -- so bytecode plus a return value is not
// evidence, and it stays out.
test("rejected venues are not registered", () => {
  assert.equal(UNI_V3_VENUES[43114]?.pharaoh, undefined);
  assert.equal(UNI_V3_VENUES[137]?.quickswap, undefined);
  assert.equal(UNI_V3_VENUES[42161]?.camelot, undefined);
});
