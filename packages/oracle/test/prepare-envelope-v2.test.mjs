import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PREPARE_VERSION,
  assertPreparedEnvelope,
  computePrepareHash,
  stampPrepared,
} from "../src/prepare-envelope.mjs";

function prepared() {
  return stampPrepared(
    { provider: "hl-perps", kind: "perp-order", action: { type: "cancel", cancels: [] } },
    { provider: "hl-perps", kind: "perp-order" },
  );
}

test("prepare envelope v2 binds preparedAt and expiresAt", () => {
  assert.equal(PREPARE_VERSION, 2);
  const value = prepared();
  assert.equal(typeof value.expiresAt, "number");
  assert.ok(value.expiresAt > value.preparedAt);
  assert.equal(assertPreparedEnvelope(value), true);

  const refreshed = { ...value, preparedAt: value.preparedAt + 1 };
  assert.notEqual(computePrepareHash(refreshed), value.prepareHash);
  assert.throws(() => assertPreparedEnvelope(refreshed), /prepareHash mismatch/);

  const extended = { ...value, expiresAt: value.expiresAt + 60_000 };
  assert.notEqual(computePrepareHash(extended), value.prepareHash);
  assert.throws(() => assertPreparedEnvelope(extended), /prepareHash mismatch/);
});

test("prepare envelope v2 rejects expired bound expiry", () => {
  const value = prepared();
  assert.throws(
    () => assertPreparedEnvelope(value, { nowMs: value.expiresAt + 1 }),
    /expired/,
  );
});
