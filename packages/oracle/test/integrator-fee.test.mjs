// Integrator fee policy.
//
// Verified against the LIVE ParaSwap API 2026-08-06:
//   non-holder -> partner "oracle", partnerFee 0.25
//   holder     -> partner "anon",   partnerFee 0.01  (ParaSwap's own default)
// ParaSwap needs no registration. LI.FI does: an unregistered fee request
// returns 400 "Integrator oracle is not configured for collecting fees",
// while the same quote WITHOUT the fee param returns 200 and already carries
// feeCosts [{ name: "LIFI Fixed Fee", percentage: "0.0025" }] — i.e. LI.FI
// takes 25 bps on Oracle's routes today and keeps all of it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FEE_BPS,
  FEE_TIERS,
  tierBps,
  resolveFee,
  resolveVerifiedFee,
  describeFee,
  lifiFeeParams,
  paraswapFeeParams,
} from "../src/router/integrator-fee.mjs";

const RECIP = "0x1111111111111111111111111111111111111111";
const configured = { ORACLE_INTEGRATOR_FEE_BPS: "3", ORACLE_INTEGRATOR_FEE_RECIPIENT: RECIP };

test("no fee unless explicitly configured", () => {
  const fee = resolveFee({ env: {} });
  assert.equal(fee.applies, false);
  assert.equal(fee.bps, 0);
  assert.equal(fee.reason, "not-configured");
});

test("a fee with no recipient fails closed", () => {
  // Otherwise the bps would be charged and silently kept by the aggregator,
  // which is the exact situation this module exists to end.
  const fee = resolveFee({ env: { ORACLE_INTEGRATOR_FEE_BPS: "25" } });
  assert.equal(fee.applies, false);
  assert.equal(fee.reason, "no-recipient");
});

test("a malformed recipient fails closed", () => {
  const fee = resolveFee({ env: { ...configured, ORACLE_INTEGRATOR_FEE_RECIPIENT: "0xnope" } });
  assert.equal(fee.applies, false);
  assert.equal(fee.reason, "no-recipient");
});

test("verified Locals Only holders are never charged", async () => {
  const fee = await resolveVerifiedFee({
    wallet: RECIP,
    env: configured,
    holderCheck: { balanceOf: async () => 1n },
  });
  assert.equal(fee.applies, false, "a holder must never carry an Oracle fee");
  assert.equal(fee.bps, 0);
  assert.equal(fee.reason, "locals-only-holder");
  assert.match(describeFee(fee), /Locals Only holder/);
  // And nothing fee-shaped may reach either provider.
  assert.deepEqual(lifiFeeParams(fee), {});
  assert.deepEqual(paraswapFeeParams(fee), {});
});

test("a configured non-holder carries the fee", () => {
  const fee = resolveFee({ env: configured });
  assert.equal(fee.applies, true);
  assert.equal(fee.bps, 3, "an explicit lower bps value must win over the default");
  assert.equal(fee.recipient, RECIP);
});

test("the house default is 5 bps once a recipient is set", () => {
  // Setting a recipient is the opt-in; the operator should not have to restate
  // the house number in every deployment.
  const fee = resolveFee({ env: { ORACLE_INTEGRATOR_FEE_RECIPIENT: RECIP } });
  assert.equal(fee.applies, true);
  assert.equal(fee.bps, DEFAULT_FEE_BPS);
  assert.equal(DEFAULT_FEE_BPS, 5);
});

test("the default never applies without a recipient", () => {
  // No recipient means the fee would be charged and kept by the aggregator.
  const fee = resolveFee({ env: {} });
  assert.equal(fee.applies, false);
  assert.equal(fee.bps, 0);
});

test("a verified holder pays nothing even under the default", async () => {
  const fee = await resolveVerifiedFee({
    wallet: RECIP,
    env: { ORACLE_INTEGRATOR_FEE_RECIPIENT: RECIP },
    holderCheck: { balanceOf: async () => 1n },
  });
  assert.equal(fee.bps, 0);
  assert.equal(fee.reason, "locals-only-holder");
});

test("configuration can lower but never raise an action's product tier", () => {
  const high = { ...configured, ORACLE_INTEGRATOR_FEE_BPS: "9999" };
  assert.equal(resolveFee({ env: high, action: "swap" }).bps, FEE_TIERS.swap);
  assert.equal(resolveFee({ env: high, action: "bridge" }).bps, FEE_TIERS.bridge);
  assert.equal(resolveFee({ env: high, action: "perps" }).bps, 0);
  assert.equal(resolveFee({ env: high, action: "nft" }).bps, 0);
  assert.equal(resolveFee({ env: configured, action: "swap" }).bps, 3);
});

test("negative and garbage bps resolve to no fee", () => {
  for (const bad of ["-50", "abc", "", "0"]) {
    const fee = resolveFee({ env: { ...configured, ORACLE_INTEGRATOR_FEE_BPS: bad } });
    assert.equal(fee.applies, false, `${bad} must not produce a fee`);
  }
});

test("every fee is disclosable before signing", () => {
  // Oracle's pitch is "decoded before you sign". A fee the user cannot see
  // would cost more credibility than the basis points are worth.
  const fee = resolveFee({ env: configured });
  const text = describeFee(fee);
  assert.match(text, /3 bps/);
  assert.match(text, /0\.03%/);
  assert.match(text, new RegExp(RECIP));
});

test("provider params match each API's documented shape", () => {
  const fee = resolveFee({ env: configured });
  // LI.FI wants a decimal fraction; ParaSwap wants integer bps.
  assert.deepEqual(lifiFeeParams(fee), { integrator: "oracle", fee: "0.0003" });
  const psp = paraswapFeeParams(fee);
  assert.equal(psp.partnerFeeBps, "3");
  assert.equal(psp.partner, "oracle");
  assert.equal(psp.partnerAddress, RECIP);
});

test("each action carries its own price", () => {
  // A same-chain swap is the most price-shopped action in crypto, so it stays
  // cheapest. Bridges do more work. Perps use their separate builder-fee path,
  // and NFT marketplaces are already expensive.
  const env = { ORACLE_INTEGRATOR_FEE_RECIPIENT: RECIP };
  assert.equal(resolveFee({ env, action: "swap" }).bps, 5);
  assert.equal(resolveFee({ env, action: "bridge" }).bps, 15);
  assert.equal(resolveFee({ env, action: "perps" }).bps, 0);
  assert.equal(resolveFee({ env, action: "nft" }).bps, 0);
});

test("swap stays below comparison routes and never stacks onto perps", () => {
  assert.ok(FEE_TIERS.swap <= FEE_TIERS.bridge, "swap must not cost more than a bridge");
  assert.ok(FEE_TIERS.swap < 15, "swap must stay under Matcha's 15 bps");
  assert.equal(FEE_TIERS.perps, 0, "routed fees must not stack onto Hyperliquid builder fees");
  assert.ok(FEE_TIERS.nft === 0, "NFT marketplaces already take enough");
});

test("an unknown action falls back to the default, never to a guess", () => {
  assert.equal(tierBps("something-new"), DEFAULT_FEE_BPS);
  assert.equal(tierBps(undefined), FEE_TIERS.swap);
});

test("verified holders pay zero on every tier", async () => {
  const env = { ORACLE_INTEGRATOR_FEE_RECIPIENT: RECIP };
  for (const action of Object.keys(FEE_TIERS)) {
    const fee = await resolveVerifiedFee({
      wallet: RECIP,
      env,
      action,
      holderCheck: { balanceOf: async () => 1n },
    });
    assert.equal(fee.bps, 0, `holder must pay nothing on ${action}`);
    assert.equal(fee.reason, "locals-only-holder");
  }
});

test("caller-supplied holder booleans cannot waive routed fees", () => {
  const fee = resolveFee({ env: configured, isHolder: true });
  assert.equal(fee.applies, true);
  assert.equal(fee.bps, 3);
});

test("an unavailable holder lookup keeps the standard routed fee", async () => {
  const fee = await resolveVerifiedFee({
    wallet: RECIP,
    env: configured,
    holderCheck: { balanceOf: async () => { throw new Error("rpc unavailable"); } },
  });
  assert.equal(fee.applies, true);
  assert.equal(fee.bps, 3);
  assert.equal(fee.holderVerificationStatus, "unavailable");
});
