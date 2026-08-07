import test from "node:test";
import assert from "node:assert/strict";
import {
  stampPrepared,
  assertPreparedEnvelope,
  computePrepareHash,
  computePrepareMac,
} from "../src/prepare-envelope.mjs";

test("integrity stamp still works without HMAC secret", () => {
  const stamped = stampPrepared({ action: { type: "order" } }, { provider: "t", kind: "k", env: {} });
  assert.equal(stamped.oraclePrepared, true);
  assert.ok(stamped.prepareHash);
  assert.equal(stamped.prepareMac, undefined);
  assert.equal(assertPreparedEnvelope(stamped, { env: {} }), true);
});

test("HMAC stamp verifies when secret shared", () => {
  const env = { ORACLE_STAMP_HMAC_SECRET: "test-secret-16chars-min" };
  const stamped = stampPrepared({ action: { type: "order" } }, { provider: "t", kind: "k", env });
  assert.ok(stamped.prepareMac);
  assert.equal(assertPreparedEnvelope(stamped, { env }), true);
});

test("HMAC stamp fails with wrong secret", () => {
  const env = { ORACLE_STAMP_HMAC_SECRET: "test-secret-16chars-min" };
  const stamped = stampPrepared({ action: { type: "order" } }, { provider: "t", kind: "k", env });
  assert.throws(
    () => assertPreparedEnvelope(stamped, { env: { ORACLE_STAMP_HMAC_SECRET: "other-secret-16chars!!" } }),
    /prepareMac mismatch/,
  );
});

test("REQUIRE_MAC refuses bare integrity stamps", () => {
  const stamped = stampPrepared({ action: { type: "order" } }, { provider: "t", kind: "k", env: {} });
  assert.throws(
    () =>
      assertPreparedEnvelope(stamped, {
        env: { ORACLE_STAMP_REQUIRE_MAC: "1", ORACLE_STAMP_HMAC_SECRET: "test-secret-16chars-min" },
      }),
    /prepareMac/,
  );
});

test("tamper breaks hash before mac", () => {
  const env = { ORACLE_STAMP_HMAC_SECRET: "test-secret-16chars-min" };
  const stamped = stampPrepared({ action: { type: "order", x: 1 } }, { provider: "t", kind: "k", env });
  const bad = { ...stamped, action: { type: "order", x: 2 } };
  assert.throws(() => assertPreparedEnvelope(bad, { env }), /prepareHash mismatch/);
});
