import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDERS,
  PROVIDER_IDS,
  SESSION_STATUS,
  computeSessionId,
  canonicalJson,
  createSessionGrant,
  createRevocationRegistry,
  sessionStatus,
  isSessionActive,
  assertSessionAuthorized,
  checkSessionAuthorized,
  toAuditRecord,
} from "../src/public-control/session-key-model.mjs";

const OWNER = "0x1111111111111111111111111111111111111111";
const AGENT = "0x2222222222222222222222222222222222222222";
const TARGET = "0x3333333333333333333333333333333333333333";
const OTHER_TARGET = "0x4444444444444444444444444444444444444444";
const NOW = 1_700_000_000_000;

function baseGrant(overrides = {}) {
  return createSessionGrant({
    provider: PROVIDERS.SAFE,
    owner: OWNER,
    agent: AGENT,
    chainId: 8453,
    actions: ["erc20:transfer"],
    targets: [TARGET],
    maxValueWei: "1000",
    issuedAtMs: NOW,
    expiresAtMs: NOW + 60_000,
    nonce: 1,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// provider list / canonicalJson
// ---------------------------------------------------------------------------

test("PROVIDER_IDS covers all four target AA stacks", () => {
  assert.deepEqual(
    [...PROVIDER_IDS].sort(),
    ["biconomy-nexus", "kernel-zerodev", "permissionless-viem", "safe"]
  );
});

test("canonicalJson sorts keys recursively and is order-independent", () => {
  const a = canonicalJson({ z: 1, a: 2, m: { y: 1, b: 2 } });
  const b = canonicalJson({ a: 2, m: { b: 2, y: 1 }, z: 1 });
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// deterministic ids
// ---------------------------------------------------------------------------

test("computeSessionId is deterministic for identical fields", () => {
  const fields = { a: 1, b: [3, 2, 1] };
  assert.equal(computeSessionId(fields), computeSessionId({ b: [3, 2, 1], a: 1 }));
});

test("two grants with identical inputs produce the same id", () => {
  const g1 = baseGrant();
  const g2 = baseGrant();
  assert.equal(g1.id, g2.id);
  assert.match(g1.id, /^0x[0-9a-f]{64}$/);
});

test("grants differing only by nonce produce different ids", () => {
  const g1 = baseGrant({ nonce: 1 });
  const g2 = baseGrant({ nonce: 2 });
  assert.notEqual(g1.id, g2.id);
});

test("action/target ordering does not change the id (canonicalized)", () => {
  const g1 = createSessionGrant({
    provider: PROVIDERS.SAFE,
    owner: OWNER,
    agent: AGENT,
    chainId: 1,
    actions: ["swap:exec", "erc20:transfer"],
    targets: [OTHER_TARGET, TARGET],
    issuedAtMs: NOW,
    expiresAtMs: NOW + 1000,
  });
  const g2 = createSessionGrant({
    provider: PROVIDERS.SAFE,
    owner: OWNER,
    agent: AGENT,
    chainId: 1,
    actions: ["erc20:transfer", "swap:exec"],
    targets: [TARGET, OTHER_TARGET],
    issuedAtMs: NOW,
    expiresAtMs: NOW + 1000,
  });
  assert.equal(g1.id, g2.id);
});

// ---------------------------------------------------------------------------
// createSessionGrant validation (fail-closed)
// ---------------------------------------------------------------------------

test("createSessionGrant returns a frozen record", () => {
  const g = baseGrant();
  assert.ok(Object.isFrozen(g));
  assert.throws(() => {
    g.maxValueWei = "999999999";
  });
});

test("rejects unknown provider", () => {
  assert.throws(() => baseGrant({ provider: "totally-custodial-inc" }), /provider must be one of/);
});

for (const provider of PROVIDER_IDS) {
  test(`accepts provider ${provider}`, () => {
    const g = baseGrant({ provider });
    assert.equal(g.provider, provider);
  });
}

test("rejects agent equal to owner", () => {
  assert.throws(() => baseGrant({ agent: OWNER }), /agent key must differ from owner/);
});

test("rejects malformed owner/agent address", () => {
  assert.throws(() => baseGrant({ owner: "not-an-address" }), /owner must be a 0x-prefixed/);
  assert.throws(() => baseGrant({ agent: "0xdead" }), /agent must be a 0x-prefixed/);
});

test("rejects non-positive chainId", () => {
  assert.throws(() => baseGrant({ chainId: 0 }), /chainId must be a positive integer/);
  assert.throws(() => baseGrant({ chainId: -1 }), /chainId must be a positive integer/);
});

test("rejects empty actions array", () => {
  assert.throws(() => baseGrant({ actions: [] }), /actions must be a non-empty array/);
});

test("rejects empty targets for a non-read action (fail-closed)", () => {
  assert.throws(
    () => baseGrant({ targets: [] }),
    /empty target allowlist is only allowed when every action is read\/simulate/
  );
});

test("allows empty targets when every action is read/simulate", () => {
  const g = baseGrant({ actions: ["read:balance", "simulate:swap"], targets: [] });
  assert.deepEqual(g.targets, []);
});

test("rejects expiresAtMs at or before issuedAtMs", () => {
  assert.throws(() => baseGrant({ expiresAtMs: NOW }), /expiresAtMs must be after issuedAtMs/);
  assert.throws(() => baseGrant({ expiresAtMs: NOW - 1 }), /expiresAtMs must be after issuedAtMs/);
});

test("rejects session grants longer than the hard 24-hour TTL", () => {
  assert.doesNotThrow(() => baseGrant({ expiresAtMs: NOW + 86_400_000 }));
  assert.throws(
    () => baseGrant({ expiresAtMs: NOW + 86_400_001 }),
    /24-hour TTL/,
  );
});

test("rejects negative maxValueWei / maxGasWei", () => {
  assert.throws(() => baseGrant({ maxValueWei: "-1" }), /maxValueWei must not be negative/);
  assert.throws(() => baseGrant({ maxGasWei: "-1" }), /maxGasWei must not be negative/);
});

test("dedupes actions and targets", () => {
  const g = baseGrant({ actions: ["erc20:transfer", "erc20:transfer"], targets: [TARGET, TARGET] });
  assert.deepEqual(g.actions, ["erc20:transfer"]);
  assert.deepEqual(g.targets, [TARGET]);
});

// ---------------------------------------------------------------------------
// sessionStatus / isSessionActive (expiry + revocation)
// ---------------------------------------------------------------------------

test("sessionStatus is active before expiry, expired at/after expiry", () => {
  const g = baseGrant();
  assert.equal(sessionStatus(g, { nowMs: NOW + 1 }), SESSION_STATUS.ACTIVE);
  assert.equal(sessionStatus(g, { nowMs: g.expiresAtMs }), SESSION_STATUS.EXPIRED);
  assert.equal(sessionStatus(g, { nowMs: g.expiresAtMs + 1 }), SESSION_STATUS.EXPIRED);
  assert.equal(isSessionActive(g, { nowMs: NOW + 1 }), true);
  assert.equal(isSessionActive(g, { nowMs: g.expiresAtMs }), false);
});

test("revocation registry: revoke() takes precedence over active window", () => {
  const g = baseGrant();
  const registry = createRevocationRegistry();
  assert.equal(registry.isRevoked(g.id), false);
  registry.revoke(g.id, { nowMs: NOW + 10 });
  assert.equal(registry.isRevoked(g.id), true);
  assert.equal(sessionStatus(g, { nowMs: NOW + 20, revocation: registry }), SESSION_STATUS.REVOKED);
});

test("revocation takes precedence over expiry (revoked-then-expired still reports revoked)", () => {
  const g = baseGrant();
  const registry = createRevocationRegistry();
  registry.revoke(g.id, { nowMs: NOW + 10 });
  assert.equal(
    sessionStatus(g, { nowMs: g.expiresAtMs + 1000, revocation: registry }),
    SESSION_STATUS.REVOKED
  );
});

test("revocation also accepts a plain Set or array of ids", () => {
  const g = baseGrant();
  assert.equal(sessionStatus(g, { nowMs: NOW + 1, revocation: new Set([g.id]) }), SESSION_STATUS.REVOKED);
  assert.equal(sessionStatus(g, { nowMs: NOW + 1, revocation: [g.id] }), SESSION_STATUS.REVOKED);
  assert.equal(sessionStatus(g, { nowMs: NOW + 1, revocation: [] }), SESSION_STATUS.ACTIVE);
});

test("revoking twice is idempotent (keeps first revokedAt)", () => {
  const registry = createRevocationRegistry();
  const r1 = registry.revoke("0xsession1", { nowMs: 100 });
  const r2 = registry.revoke("0xsession1", { nowMs: 200 });
  assert.equal(r1.revokedAtMs, 100);
  assert.equal(r2.revokedAtMs, 100);
  assert.equal(registry.size, 1);
});

// ---------------------------------------------------------------------------
// assertSessionAuthorized — the core "valid sessions pass, bad ones fail" gate
// ---------------------------------------------------------------------------

test("valid in-policy request passes", () => {
  const g = baseGrant();
  assert.equal(
    assertSessionAuthorized(g, { action: "erc20:transfer", chainId: 8453, target: TARGET, valueWei: "500" }, { nowMs: NOW + 1 }),
    true
  );
});

test("expired session fails", () => {
  const g = baseGrant();
  assert.throws(
    () => assertSessionAuthorized(g, { action: "erc20:transfer", chainId: 8453, target: TARGET, valueWei: "1" }, { nowMs: g.expiresAtMs + 1 }),
    /session .* expired/
  );
});

test("revoked session fails even if not yet expired", () => {
  const g = baseGrant();
  const registry = createRevocationRegistry();
  registry.revoke(g.id, { nowMs: NOW + 5 });
  assert.throws(
    () =>
      assertSessionAuthorized(
        g,
        { action: "erc20:transfer", chainId: 8453, target: TARGET, valueWei: "1" },
        { nowMs: NOW + 10, revocation: registry }
      ),
    /session .* is revoked/
  );
});

test("out-of-policy: wrong chain fails", () => {
  const g = baseGrant();
  assert.throws(
    () => assertSessionAuthorized(g, { action: "erc20:transfer", chainId: 1, target: TARGET, valueWei: "1" }, { nowMs: NOW + 1 }),
    /chain mismatch/
  );
});

test("out-of-policy: action not granted fails", () => {
  const g = baseGrant();
  assert.throws(
    () => assertSessionAuthorized(g, { action: "swap:exec", chainId: 8453, target: TARGET, valueWei: "1" }, { nowMs: NOW + 1 }),
    /not permitted by session/
  );
});

test("out-of-policy: target not in allowlist fails", () => {
  const g = baseGrant();
  assert.throws(
    () => assertSessionAuthorized(g, { action: "erc20:transfer", chainId: 8453, target: OTHER_TARGET, valueWei: "1" }, { nowMs: NOW + 1 }),
    /target .* not permitted/
  );
});

test("out-of-policy: missing target for a non-read action fails", () => {
  const g = baseGrant();
  assert.throws(
    () => assertSessionAuthorized(g, { action: "erc20:transfer", chainId: 8453, valueWei: "1" }, { nowMs: NOW + 1 }),
    /target required/
  );
});

test("out-of-policy: value over cap fails", () => {
  const g = baseGrant({ maxValueWei: "100" });
  assert.throws(
    () => assertSessionAuthorized(g, { action: "erc20:transfer", chainId: 8453, target: TARGET, valueWei: "101" }, { nowMs: NOW + 1 }),
    /value .* exceeds session cap/
  );
});

test("value exactly at cap passes", () => {
  const g = baseGrant({ maxValueWei: "100" });
  assert.equal(
    assertSessionAuthorized(g, { action: "erc20:transfer", chainId: 8453, target: TARGET, valueWei: "100" }, { nowMs: NOW + 1 }),
    true
  );
});

test("out-of-policy: gas over cap fails when maxGasWei is set", () => {
  const g = baseGrant({ maxGasWei: "1000" });
  assert.throws(
    () =>
      assertSessionAuthorized(
        g,
        { action: "erc20:transfer", chainId: 8453, target: TARGET, valueWei: "1", gasWei: "1001" },
        { nowMs: NOW + 1 }
      ),
    /gas fee .* exceeds session cap/
  );
});

test("gas cap is not enforced when grant has no maxGasWei", () => {
  const g = baseGrant(); // no maxGasWei
  assert.equal(
    assertSessionAuthorized(
      g,
      { action: "erc20:transfer", chainId: 8453, target: TARGET, valueWei: "1", gasWei: "999999999" },
      { nowMs: NOW + 1 }
    ),
    true
  );
});

test("read-only action does not require a target", () => {
  const g = baseGrant({ actions: ["read:balance"], targets: [] });
  assert.equal(
    assertSessionAuthorized(g, { action: "read:balance", chainId: 8453 }, { nowMs: NOW + 1 }),
    true
  );
});

test("read-only action with no target still respects expiry/revocation", () => {
  const g = baseGrant({ actions: ["read:balance"], targets: [] });
  assert.throws(
    () => assertSessionAuthorized(g, { action: "read:balance", chainId: 8453 }, { nowMs: g.expiresAtMs + 1 }),
    /expired/
  );
});

test("checkSessionAuthorized returns {ok:false, reason} instead of throwing", () => {
  const g = baseGrant();
  const result = checkSessionAuthorized(g, { action: "erc20:transfer", chainId: 999, target: TARGET }, { nowMs: NOW + 1 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /chain mismatch/);

  const ok = checkSessionAuthorized(g, { action: "erc20:transfer", chainId: 8453, target: TARGET, valueWei: "1" }, { nowMs: NOW + 1 });
  assert.equal(ok.ok, true);
});

// ---------------------------------------------------------------------------
// audit record
// ---------------------------------------------------------------------------

test("toAuditRecord exposes only stable public fields", () => {
  const g = baseGrant();
  const rec = toAuditRecord(g);
  assert.equal(rec.id, g.id);
  assert.deepEqual(Object.keys(rec).sort(), [
    "actions",
    "agent",
    "chainId",
    "expiresAtMs",
    "id",
    "issuedAtMs",
    "maxGasWei",
    "maxValueWei",
    "nonce",
    "owner",
    "provider",
    "targets",
  ]);
});

test("invalid grant object is rejected by sessionStatus/assertSessionAuthorized/toAuditRecord", () => {
  assert.throws(() => sessionStatus({ not: "a grant" }), /invalid session grant/);
  assert.throws(() => assertSessionAuthorized({ not: "a grant" }, {}), /invalid session grant/);
  assert.throws(() => toAuditRecord(null), /invalid session grant/);
});
