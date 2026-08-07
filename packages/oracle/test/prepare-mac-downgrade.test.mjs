// The prepared-envelope MAC must not be downgradeable.
//
// assertPreparedEnvelope enforced the keyed MAC only when a prepareMac was
// PRESENT or ORACLE_STAMP_REQUIRE_MAC=1. prepareHash is an unkeyed sha256 that
// an attacker can recompute through the exported computePrepareHash, so
// stripping prepareMac and recomputing the hash let a mutated payload through
// a default-posture verifier. Classic optional-MAC strip-and-downgrade.
//
// Found by the opus lane of the 2026-08-03 four-model review.

import { test } from "node:test";
import assert from "node:assert/strict";

const SECRET = "test-preparer-secret";

/** Load a fresh module copy under a specific env posture. */
async function withEnv({ secret, requireMac }, fn) {
  const prevSecret = process.env.ORACLE_STAMP_HMAC_SECRET;
  const prevRequire = process.env.ORACLE_STAMP_REQUIRE_MAC;

  if (secret) process.env.ORACLE_STAMP_HMAC_SECRET = secret;
  else delete process.env.ORACLE_STAMP_HMAC_SECRET;
  if (requireMac) process.env.ORACLE_STAMP_REQUIRE_MAC = "1";
  else delete process.env.ORACLE_STAMP_REQUIRE_MAC;

  try {
    // cache-bust so module-level env reads re-evaluate
    const mod = await import(`../src/prepare-envelope.mjs?mac=${Math.random()}`);
    return await fn(mod);
  } finally {
    if (prevSecret === undefined) delete process.env.ORACLE_STAMP_HMAC_SECRET;
    else process.env.ORACLE_STAMP_HMAC_SECRET = prevSecret;
    if (prevRequire === undefined) delete process.env.ORACLE_STAMP_REQUIRE_MAC;
    else process.env.ORACLE_STAMP_REQUIRE_MAC = prevRequire;
  }
}

const payload = { valueWei: "1000000000000000000", to: `0x${"1".repeat(40)}` };

test("stripping the MAC cannot downgrade a keyed verifier", async () => {
  await withEnv({ secret: SECRET }, ({ stampPrepared, assertPreparedEnvelope, computePrepareHash }) => {
    const env = stampPrepared({ ...payload }, { provider: "test", kind: "test-swap" });
    assert.ok(env.prepareMac, "a keyed preparer must emit a MAC");

    // Mutate, strip the MAC, recompute the unkeyed hash — the forgery path.
    const forged = { ...env, valueWei: "2" };
    delete forged.prepareMac;
    forged.prepareHash = computePrepareHash(forged);

    assert.throws(
      () => assertPreparedEnvelope(forged),
      /prepareMac mismatch/,
      "a MAC-stripped, hash-recomputed payload must not verify against a verifier holding the secret"
    );

    // Honest envelope still verifies.
    assert.doesNotThrow(() => assertPreparedEnvelope(env));
  });
});

test("mutation is caught even when the MAC is left in place", async () => {
  await withEnv({ secret: SECRET }, ({ stampPrepared, assertPreparedEnvelope, computePrepareHash }) => {
    const env = stampPrepared({ ...payload }, { provider: "test", kind: "test-swap" });
    const mutated = { ...env, valueWei: "2" };
    mutated.prepareHash = computePrepareHash(mutated);
    assert.throws(() => assertPreparedEnvelope(mutated), /prepareMac mismatch/);
  });
});

// `env` is a test/config override, not an opt-out switch. A caller must not be
// able to pass `{}` and silently ignore a process-owned signer secret.
test("an empty caller env cannot downgrade a process-keyed verifier", async () => {
  await withEnv({ secret: SECRET }, ({ stampPrepared, assertPreparedEnvelope, computePrepareHash }) => {
    const env = stampPrepared({ ...payload }, { provider: "test", kind: "test-swap" });
    const forged = { ...env, valueWei: "2" };
    delete forged.prepareMac;
    forged.prepareHash = computePrepareHash(forged);

    assert.throws(
      () => assertPreparedEnvelope(forged, { env: {} }),
      /prepareMac mismatch/,
      "env:{} cannot convert a keyed verifier into checksum-only mode",
    );
  });
});

// The no-secret posture is documented as checksum-only and must keep working;
// tightening the keyed path must not break verifiers that never configured a
// secret.
test("a verifier with no secret keeps its documented checksum-only behavior", async () => {
  await withEnv({ secret: null }, ({ stampPrepared, assertPreparedEnvelope }) => {
    const env = stampPrepared({ ...payload }, { provider: "test", kind: "test-swap" });
    assert.equal(env.prepareMac, undefined, "an unkeyed preparer emits no MAC");
    assert.doesNotThrow(() => assertPreparedEnvelope(env));

    // The checksum still detects a stale-hash mutation.
    assert.throws(() => assertPreparedEnvelope({ ...env, valueWei: "2" }), /prepareHash mismatch/);
  });
});
