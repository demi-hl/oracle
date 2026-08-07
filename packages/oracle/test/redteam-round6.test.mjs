// Round-6 regressions (Opus 5 + Grok, both DO_NOT_SHIP).
//
// The CRITICAL here is a bug I INTRODUCED in the round-5 fix: the calldata
// binding I added to close a HIGH read the wrong ABI word, so it validated
// amountIn instead of amountOutMinimum. A fix that looks right and checks the
// wrong field is worse than no fix, because it reads as covered.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createAutoSlippageGuard, assertAutoSlippageGuard } from "../src/auto-slippage.mjs";
import { isApprovalCall } from "../src/approval-guard.mjs";

process.env.ORACLE_ROUTE_ATTESTATION_SECRET ||= "oracle-unit-test-secret";

const VENUE = "0x2626664c2603336E57B271c5C0b26F421741e481";
const w = (v) => BigInt(v).toString(16).padStart(64, "0");

function guard() {
  return createAutoSlippageGuard({
    chainId: 8453, venue: VENUE, quoteAmountOut: "1000",
    liquidityUsd: 5_000_000, volatilityBps: 10, nowMs: Date.now(), ttlMs: 15_000,
  });
}

test("exactInput cannot hide amountOutMinimum=0 behind a spoofed amountIn", () => {
  const g = guard();
  // exactInput's struct starts with `bytes path`, so the struct sits behind an
  // offset and amountOutMinimum is tail word 4, not head word 4. Setting
  // amountIn to the guard's expected value defeated a fixed-index read.
  const evil = "0xc04b8d59" + w(32) + w(160) + w(0) + w(0) + w(g.minAmountOut) + w(0) + w(0);
  assert.throws(
    () => assertAutoSlippageGuard(g, { chainId: 8453, venue: VENUE, tx: { chainId: 8453, to: VENUE, data: evil } }),
    /not bound to this call/
  );
});

test("a legitimate exactInput still passes", () => {
  const g = guard();
  const good = "0xc04b8d59" + w(32) + w(160) + w(0) + w(0) + w("1000") + w(g.minAmountOut) + w(0);
  assert.doesNotThrow(() =>
    assertAutoSlippageGuard(g, { chainId: 8453, venue: VENUE, tx: { chainId: 8453, to: VENUE, data: good } })
  );
});

test("every allowance-granting selector is guarded, not just approve()", () => {
  // increaseAllowance raises the same allowance; Permit2 and EIP-2612 permit
  // grant spend rights from a signature. Gating on approve() alone left each
  // of these unguarded.
  for (const sel of ["0x095ea7b3", "0x39509351", "0x87517c45", "0xd505accf", "0x8fcbaf0c"]) {
    assert.equal(isApprovalCall(sel + w(0)), true, `${sel} must be treated as an approval`);
  }
  // and a plain transfer must NOT be
  assert.equal(isApprovalCall("0xa9059cbb" + w(0)), false);
});

test("the slippage guard fails closed on an unusable clock", () => {
  const g = guard();
  for (const nowMs of [NaN, null, "later", -Infinity]) {
    assert.throws(
      () => assertAutoSlippageGuard(g, { chainId: 8453, venue: VENUE, nowMs }),
      /finite|expired/,
      `nowMs=${String(nowMs)} must not validate an expiry`
    );
  }
});

test("credential-shaped headers all participate in the dedupe fingerprint", async () => {
  // A fixed IDENTITY_HEADERS list silently failed for `0x-api-key`: two users'
  // requests hashed identically and the in-flight dedupe served user B a
  // response fetched with user A's key.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/data/http.mjs", import.meta.url), "utf8");
  assert.ok(src.includes('"0x-api-key"'), "0x-api-key must be an identity header");
  assert.ok(
    /credentialShaped/.test(src),
    "the fingerprint must match credential-shaped headers structurally, not only a fixed list"
  );
});

test("every allowance selector is derived from its real signature", async () => {
  // A hand-copied selector in a security list is a silent hole: it guards
  // nothing and reads as covered. My first pass had forceApprove and
  // safeApprove wrong. Derive them here so the list cannot drift.
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const sel = (s) => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(s))).subarray(0, 4).toString("hex");
  const pad = (x) => BigInt(x).toString(16).padStart(64, "0");

  const mustGuard = [
    "approve(address,uint256)",
    "increaseAllowance(address,uint256)",
    "forceApprove(address,address,uint256)",
    "safeApprove(address,address,uint256)",
    "safeIncreaseAllowance(address,address,uint256)",
    "approve(address,address,uint160,uint48)",
    "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
    "permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)",
  ];
  for (const sig of mustGuard) {
    assert.equal(isApprovalCall(sel(sig) + pad(0)), true, `${sig} (${sel(sig)}) must be guarded`);
  }
  for (const sig of ["transfer(address,uint256)", "transferFrom(address,address,uint256)", "decreaseAllowance(address,uint256)"]) {
    assert.equal(isApprovalCall(sel(sig) + pad(0)), false, `${sig} must NOT be treated as an approval`);
  }
});
