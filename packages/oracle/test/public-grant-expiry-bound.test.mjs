import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleUnsignedGrant, SIGNING_SCHEME } from "../src/public-api/connect-agent.mjs";
import { validateGrant } from "../src/public-control/policy-schema.mjs";

const SECONDS_EXPIRY = 4102444800; // 2100-01-01, valid unix seconds
const OVERFLOW_EXPIRY = 9999999999000; // ms-shaped value; overflows JS Date when rendered as seconds

const baseGrant = {
  agentAddress: "0x00000000000000000000000000000000000A1ce5",
  accountAddress: "0x1111111111111111111111111111111111111111",
  chainId: 8453,
  actions: ["read:markets"],
  targets: [],
  maxValueWei: "0",
  maxGasWei: "1000000",
  maxSlippageBps: 50,
  nonce: "1",
  revocationKey: "0xabc123",
};

test("assembleUnsignedGrant renders a seconds-based expiry without throwing", () => {
  const out = assembleUnsignedGrant(
    { ...baseGrant, expiresAt: SECONDS_EXPIRY },
    { now: SECONDS_EXPIRY - 3600 },
  );
  assert.equal(out.signing.scheme, SIGNING_SCHEME);
  assert.match(out.render, /Expires:/);
  assert.match(out.render, new RegExp(String(SECONDS_EXPIRY)));
});

test("a millisecond expiry is rejected at validation, not at render (fail closed)", () => {
  const res = validateGrant({ ...baseGrant, expiresAt: OVERFLOW_EXPIRY });
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some((e) => e.field === "expiresAt" && /max unix-seconds|milliseconds/.test(e.message)),
    "expected an expiresAt ceiling error, got " + JSON.stringify(res.errors)
  );
});

test("assembleUnsignedGrant never throws on a would-be renderer-overflow expiry", () => {
  assert.throws(
    () => assembleUnsignedGrant(
      { ...baseGrant, expiresAt: OVERFLOW_EXPIRY },
      { now: SECONDS_EXPIRY - 3600 },
    ),
    /expiresAt|max unix-seconds|milliseconds/,
    "overflow expiry must be rejected as a validation error, not an opaque Date crash"
  );
});
