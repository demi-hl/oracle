import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_SLIPPAGE_MAX_BPS,
  resolveAutoSlippage,
  createAutoSlippageGuard,
  assertAutoSlippageGuard,
  signAutoSlippageGuard,
} from "../src/auto-slippage.mjs";

// Fresh installs and CI isolate secrets — pin a test secret so create/assert
// can sign. Production requires a real ORACLE_ROUTE_ATTESTATION_SECRET.
process.env.ORACLE_ROUTE_ATTESTATION_SECRET ||= "oracle-unit-test-secret";

const CHAINS = [1, 10, 56, 137, 988, 999, 2741, 4663, 8453, 42161, 43114];

test("deep liquid routes select a tight automatic guard", () => {
  const out = resolveAutoSlippage({ liquidityUsd: 250_000, priceChange5m: 0 });
  assert.deepEqual(out, {
    mode: "auto",
    requiredBps: 25,
    selectedBps: 25,
    capBps: 100,
    executable: true,
  });
});

test("automatic slippage adapts but never widens past one percent", () => {
  const moving = resolveAutoSlippage({ liquidityUsd: 250_000, priceChange5m: 10 });
  assert.equal(moving.selectedBps, 45);
  assert.equal(moving.executable, true);

  const unsafe = resolveAutoSlippage({ liquidityUsd: 5_000, priceChange5m: 40 });
  assert.equal(unsafe.requiredBps, 150);
  assert.equal(unsafe.selectedBps, AUTO_SLIPPAGE_MAX_BPS);
  assert.equal(unsafe.executable, false);
});

test("numeric caller slippage is a cap, never a fixed tolerance", () => {
  const out = resolveAutoSlippage({ liquidityUsd: 250_000, requestedCapBps: 80 });
  assert.equal(out.selectedBps, 25);
  assert.equal(out.capBps, 80);
  assert.equal(out.executable, true);
});

test("the same quote guard is valid on every supported EVM chain", () => {
  for (const chainId of CHAINS) {
    const guard = createAutoSlippageGuard({
      chainId,
      venue: "unit-test",
      quoteAmountOut: "2000000",
      liquidityUsd: 250_000,
      quotedAtMs: 1_000_000,
      ttlMs: 20_000,
    });
    assert.equal(guard.minAmountOut, "1995000");
    assert.doesNotThrow(() => assertAutoSlippageGuard(guard, { nowMs: 1_010_000 }));
  }
});

test("stale, over-cap, and under-protected guards fail closed", () => {
  const base = createAutoSlippageGuard({
    chainId: 8453,
    venue: "unit-test",
    quoteAmountOut: "2000000",
    liquidityUsd: 250_000,
    quotedAtMs: 1_000_000,
    ttlMs: 20_000,
  });
  assert.throws(() => assertAutoSlippageGuard(base, { nowMs: 1_020_001 }), /expired/);
  // Re-sign each mutation so we exercise the BOUNDS check, not the signature
  // check. A tampered-but-unsigned guard is covered separately below.
  assert.throws(
    () => assertAutoSlippageGuard(signAutoSlippageGuard({ ...base, selectedBps: 101 }), { nowMs: 1_010_000 }),
    /100 bps/
  );
  assert.throws(
    () => assertAutoSlippageGuard(signAutoSlippageGuard({ ...base, minAmountOut: "1900000" }), { nowMs: 1_010_000 }),
    /under-protected/
  );
});

test("a guard mutated after issue is rejected when a secret is configured", () => {
  const saved = process.env.ORACLE_ROUTE_ATTESTATION_SECRET;
  process.env.ORACLE_ROUTE_ATTESTATION_SECRET = "unit-test-secret";
  try {
    const guard = createAutoSlippageGuard({
      chainId: 8453,
      venue: "unit-test",
      quoteAmountOut: "2000000",
      liquidityUsd: 250_000,
      quotedAtMs: 1_000_000,
    });
    assert.ok(guard.signature, "a guard must be signed when a secret exists");
    // Widen the floor without re-signing: the classic self-attestation attack.
    const forged = { ...guard, quoteAmountOut: "1", minAmountOut: "1" };
    assert.throws(() => assertAutoSlippageGuard(forged, { nowMs: 1_010_000 }), /signature/);
  } finally {
    if (saved === undefined) delete process.env.ORACLE_ROUTE_ATTESTATION_SECRET;
    else process.env.ORACLE_ROUTE_ATTESTATION_SECRET = saved;
  }
});
