// Slice D — public connect-agent API contract tests.
//
// Proves: unsigned payload matches canonical policy bytes, the no-secret
// invariant fails closed, expired/revoked grants are excluded from active
// listings, and invalid inputs are rejected. No live chain, no signing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  buildConnectRequest,
  assembleUnsignedGrant,
  assertNoSecretMaterial,
  SecretLeakError,
  SIGNING_SCHEME,
  CONNECT_REQUEST_KIND,
  UNSIGNED_GRANT_KIND,
} from "../src/public-api/connect-agent.mjs";
import {
  listActiveGrants,
  getGrant,
  classifyGrant,
  GRANT_STATUS,
} from "../src/public-api/grants.mjs";
import {
  canonicalizeGrant,
  grantId,
  GrantValidationError,
  GRANT_VERSION,
} from "../src/public-control/policy-schema.mjs";

const NOW = 1_800_000_000; // fixed unix seconds — determinism, no wall clock

const AGENT = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";
const TARGET = "0x3333333333333333333333333333333333333333";

function baseInput(overrides = {}) {
  return {
    chainId: 8453,
    agentAddress: AGENT,
    accountAddress: ACCOUNT,
    actions: ["swap:exec", "read:balance"],
    targets: [TARGET],
    maxValueWei: "1000000000000000000",
    maxGasWei: "50000000000000000",
    maxSlippageBps: 50,
    expiresAt: NOW + 3600,
    nonce: "n-1",
    revocationKey: "revoke.n-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildConnectRequest / assembleUnsignedGrant
// ---------------------------------------------------------------------------

test("buildConnectRequest returns a normalized canonical grant, never a signature", () => {
  const req = buildConnectRequest(baseInput(), { now: NOW });
  assert.equal(req.kind, CONNECT_REQUEST_KIND);
  assert.equal(req.version, GRANT_VERSION);
  assert.equal(req.grant.agentAddress, AGENT);
  assert.deepEqual(req.grant.actions, ["read:balance", "swap:exec"]); // sorted
  assert.ok(Object.isFrozen(req) && Object.isFrozen(req.grant));
  assert.ok(!("signature" in req) && !("signature" in req.grant));
});

test("public grant construction requires an explicit reference time", () => {
  assert.throws(() => buildConnectRequest(baseInput()), /opts.now.*required/);
  assert.throws(() => assembleUnsignedGrant(baseInput()), /opts.now.*required/);
});

test("buildConnectRequest supports ttlSeconds only with explicit now, not with expiresAt", () => {
  const { expiresAt, ...noExpiry } = baseInput();
  const req = buildConnectRequest({ ...noExpiry, ttlSeconds: 3600 }, { now: NOW });
  assert.equal(req.grant.expiresAt, NOW + 3600);
  assert.throws(() => buildConnectRequest({ ...noExpiry, ttlSeconds: 3600 }), GrantValidationError);
  assert.throws(
    () => buildConnectRequest({ ...baseInput(), ttlSeconds: 3600 }, { now: NOW }),
    GrantValidationError
  );
});

test("unsigned payload matches canonical policy bytes exactly", () => {
  const input = baseInput();
  const out = assembleUnsignedGrant(input, { now: NOW });

  const expectedCanonical = canonicalizeGrant(input, { now: NOW });
  const expectedId = grantId(input, { now: NOW });
  const expectedBytes = Buffer.from(expectedCanonical, "utf8");

  assert.equal(out.kind, UNSIGNED_GRANT_KIND);
  assert.equal(out.unsigned, true);
  assert.equal(out.payload.canonical, expectedCanonical);
  assert.equal(out.payload.grantId, expectedId);
  assert.equal(out.signing.scheme, SIGNING_SCHEME);
  assert.equal(out.signing.message, expectedCanonical);
  assert.equal(out.signing.bytesHex, `0x${expectedBytes.toString("hex")}`);
  assert.equal(out.signing.byteLength, expectedBytes.length);
  // sha256 over the exact signable bytes equals the public grant id.
  const digest = createHash("sha256").update(Buffer.from(out.signing.bytesHex.slice(2), "hex")).digest("hex");
  assert.equal(digest, expectedId);
  assert.equal(out.signing.sha256, expectedId);
});

test("assembly is deterministic across key order, address casing, numeric representation", () => {
  const a = assembleUnsignedGrant(baseInput(), { now: NOW });
  const shuffled = {
    revocationKey: "revoke.n-1",
    nonce: "n-1",
    expiresAt: String(NOW + 3600),
    maxSlippageBps: "50",
    maxGasWei: 50000000000000000n,
    maxValueWei: 1000000000000000000n,
    targets: [TARGET.toUpperCase().replace("0X", "0x")],
    actions: ["read:balance", "swap:exec"],
    accountAddress: ACCOUNT.toUpperCase().replace("0X", "0x"),
    agentAddress: AGENT,
    chainId: 8453n,
  };
  const b = assembleUnsignedGrant(shuffled, { now: NOW });
  assert.equal(a.payload.canonical, b.payload.canonical);
  assert.equal(a.signing.bytesHex, b.signing.bytesHex);
  assert.equal(a.payload.grantId, b.payload.grantId);
  assert.equal(a.render, b.render);
});

test("assembleUnsignedGrant accepts the output of buildConnectRequest", () => {
  const req = buildConnectRequest(baseInput(), { now: NOW });
  const out = assembleUnsignedGrant(req, { now: NOW });
  assert.equal(out.payload.grantId, grantId(baseInput(), { now: NOW }));
});

test("render surfaces the grant id and never a signing capability", () => {
  const out = assembleUnsignedGrant(baseInput(), { now: NOW });
  assert.ok(out.render.includes(out.payload.grantId));
  assert.ok(out.render.includes("UNSIGNED"));
  assert.ok(!/private key|bearer|keystore/i.test(out.render));
});

// ---------------------------------------------------------------------------
// Invalid inputs rejected (fail closed)
// ---------------------------------------------------------------------------

test("invalid inputs are rejected", () => {
  const cases = [
    null,
    "not-an-object",
    baseInput({ chainId: 0 }),
    baseInput({ agentAddress: "0x123" }),
    baseInput({ actions: [] }),
    baseInput({ actions: ["*"] }),
    baseInput({ actions: ["swap:*"] }), // wildcard rejected by default
    baseInput({ targets: [] }), // state-changing actions require targets
    baseInput({ maxValueWei: "-1" }),
    baseInput({ maxSlippageBps: 10_001 }),
    baseInput({ expiresAt: NOW - 1 }), // already expired vs now
    baseInput({ nonce: "" }),
    baseInput({ smuggled: true }), // unknown field
  ];
  for (const input of cases) {
    assert.throws(
      () => assembleUnsignedGrant(input, { now: NOW }),
      GrantValidationError,
      `expected rejection for ${JSON.stringify(input)}`
    );
    assert.throws(() => buildConnectRequest(input, { now: NOW }), GrantValidationError);
  }
});

// ---------------------------------------------------------------------------
// No-secret invariant (grep the output object, fail closed)
// ---------------------------------------------------------------------------

const SECRET_KEY_GREP =
  /(private[_-]?key|secret|bearer|keystore|mnemonic|seed[_-]?phrase|passphrase|password|api[_-]?key|access[_-]?token|auth[_-]?token|session[_-]?token|signer[_-]?url|signature)/i;
const SECRET_VALUE_GREPS = [
  /^0x[0-9a-fA-F]{64}$/, // raw 32-byte hex key / session-key secret shape
  /bearer\s+[A-Za-z0-9._~+/=-]+/i,
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/,
  /keystore/i,
  /https?:\/\/\S*sign/i,
];

/** Independent recursive grep over a returned object (does NOT reuse the
 *  module's own scanner, so a bug there cannot hide a leak here). */
function grepForSecrets(value, path = "$", hits = [], seen = new Set()) {
  if (value == null) return hits;
  if (typeof value === "string") {
    for (const re of SECRET_VALUE_GREPS) if (re.test(value)) hits.push(`${path} ~ ${re}`);
    return hits;
  }
  if (typeof value !== "object" || seen.has(value)) return hits;
  seen.add(value);
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_GREP.test(k)) hits.push(`${path}.${k} (key name)`);
    grepForSecrets(v, `${path}.${k}`, hits, seen);
  }
  return hits;
}

test("no-secret invariant: assembled output contains zero secret-shaped material", () => {
  const out = assembleUnsignedGrant(baseInput(), { now: NOW });
  assert.deepEqual(grepForSecrets(out), []);
  const req = buildConnectRequest(baseInput(), { now: NOW });
  assert.deepEqual(grepForSecrets(req), []);
});

test("no-secret invariant fails closed: poisoned objects throw SecretLeakError", () => {
  const poisons = [
    { privateKey: "anything" },
    { private_key: "anything" },
    { sessionSecret: "x" },
    { bearerToken: "x" },
    { keystorePath: "/x" },
    { signerUrl: "http://x" },
    { signature: "0xdead" },
    { nested: { deep: { apiKey: "x" } } },
    { list: [{ mnemonic: "twelve words" }] },
    { value: "0x" + "ab".repeat(32) }, // raw 32-byte hex key shape
    { value: "Bearer abc.def.ghi" },
    { value: "-----BEGIN EC PRIVATE KEY-----" },
    { value: "/home/operator/.oracle/keystore/main.json" },
    { value: "https://internal.example/signer/sign" },
  ];
  for (const p of poisons) {
    assert.throws(() => assertNoSecretMaterial(p), SecretLeakError, JSON.stringify(p));
  }
  // Clean objects pass through unchanged.
  const clean = { hello: "world", addr: AGENT };
  assert.equal(assertNoSecretMaterial(clean), clean);
});

test("no-secret invariant scans Maps and Sets too", () => {
  assert.throws(() => assertNoSecretMaterial(new Map([["bearerToken", "x"]])), SecretLeakError);
  assert.throws(() => assertNoSecretMaterial(new Set(["0x" + "cd".repeat(32)])), SecretLeakError);
});

// ---------------------------------------------------------------------------
// listActiveGrants / getGrant
// ---------------------------------------------------------------------------

function storeFixture() {
  const active = baseInput();
  const activeOther = baseInput({
    agentAddress: "0x4444444444444444444444444444444444444444",
    nonce: "n-2",
    revocationKey: "revoke.n-2",
  });
  const expired = baseInput({ expiresAt: NOW - 10, nonce: "n-exp", revocationKey: "revoke.exp" });
  const revoked = baseInput({ nonce: "n-rev", revocationKey: "revoke.rev" });
  const invalid = { chainId: 1 }; // missing everything else
  return { active, activeOther, expired, revoked, invalid };
}

test("listActiveGrants excludes expired, revoked, and invalid records", () => {
  const f = storeFixture();
  const store = [
    f.active,
    f.activeOther,
    f.expired,
    { grant: f.revoked, revoked: true },
    f.invalid,
  ];
  const out = listActiveGrants(store, { now: NOW });
  assert.equal(out.length, 2);
  const ids = out.map((r) => r.id).sort();
  assert.deepEqual(ids, [grantId(f.active), grantId(f.activeOther)].sort());
  assert.deepEqual(out.map((r) => r.id), [...ids]); // deterministic id order
  assert.deepEqual(grepForSecrets(out), []);
});

test("listActiveGrants honors out-of-band revocation by id and by revocationKey", () => {
  const f = storeFixture();
  const store = [f.active, f.activeOther];
  const byId = listActiveGrants(store, { now: NOW, revoked: new Set([grantId(f.active)]) });
  assert.deepEqual(byId.map((r) => r.id), [grantId(f.activeOther)]);
  const byKey = listActiveGrants(store, { now: NOW, revoked: ["revoke.n-2"] });
  assert.deepEqual(byKey.map((r) => r.id), [grantId(f.active)]);
  const byFn = listActiveGrants(store, { now: NOW, revoked: () => true });
  assert.equal(byFn.length, 0);
});

test("listActiveGrants filters by agent/account/chain and accepts a Map store", () => {
  const f = storeFixture();
  const store = new Map([
    ["a", f.active],
    ["b", f.activeOther],
  ]);
  const only = listActiveGrants(store, { now: NOW, agentAddress: AGENT.toUpperCase().replace("0X", "0x") });
  assert.equal(only.length, 1);
  assert.equal(only[0].grant.agentAddress, AGENT);
  assert.equal(listActiveGrants(store, { now: NOW, chainId: 1 }).length, 0);
});

test("listActiveGrants and getGrant require an explicit now (no wall-clock fallback)", () => {
  assert.throws(() => listActiveGrants([baseInput()], {}), TypeError);
  assert.throws(() => getGrant([baseInput()], grantId(baseInput()), {}), TypeError);
});

test("a grant expiring exactly at now is NOT active (fail closed at the boundary)", () => {
  const g = baseInput({ expiresAt: NOW });
  assert.equal(listActiveGrants([g], { now: NOW }).length, 0);
  assert.equal(classifyGrant(g, { now: NOW }).status, GRANT_STATUS.EXPIRED);
});

test("getGrant surfaces status for expired/revoked, null for unknown/invalid ids", () => {
  const f = storeFixture();
  const store = [f.active, f.expired, { grant: f.revoked, revoked: true }, f.invalid];

  const hitActive = getGrant(store, grantId(f.active), { now: NOW });
  assert.equal(hitActive.status, GRANT_STATUS.ACTIVE);
  assert.equal(hitActive.id, grantId(f.active));

  const hitExpired = getGrant(store, grantId(f.expired), { now: NOW });
  assert.equal(hitExpired.status, GRANT_STATUS.EXPIRED);

  const hitRevoked = getGrant(store, grantId(f.revoked), { now: NOW });
  assert.equal(hitRevoked.status, GRANT_STATUS.REVOKED);

  assert.equal(getGrant(store, "ff".repeat(32), { now: NOW }), null);
  assert.equal(getGrant(store, "not-a-grant-id", { now: NOW }), null);
  assert.deepEqual(grepForSecrets(hitActive), []);
});

test("revocation takes precedence over expiry", () => {
  const f = storeFixture();
  const store = [{ grant: f.expired, revoked: true }];
  const hit = getGrant(store, grantId(f.expired), { now: NOW });
  assert.equal(hit.status, GRANT_STATUS.REVOKED);
});

test("end-to-end: assembled unsigned grant round-trips into the active list", () => {
  const out = assembleUnsignedGrant(baseInput(), { now: NOW });
  const active = listActiveGrants([out.payload.grant], { now: NOW });
  assert.equal(active.length, 1);
  assert.equal(active[0].id, out.payload.grantId);
  const hit = getGrant([out.payload.grant], out.payload.grantId, { now: NOW });
  assert.equal(hit.status, GRANT_STATUS.ACTIVE);
});
