import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRANT_EVENT_TYPES,
  GRANT_STATUS,
  reconstructGrantIndex,
  isGrantActive,
  getGrantRecord,
} from "../src/public-control/grant-indexer.mjs";
import { grantId as computeGrantId } from "../src/public-control/policy-schema.mjs";

const NOW = 1_700_000_000;

function rawGrant(overrides = {}) {
  return {
    chainId: 8453,
    agentAddress: "0x2222222222222222222222222222222222222222",
    accountAddress: "0x1111111111111111111111111111111111111111",
    actions: ["swap:exec"],
    targets: ["0x3333333333333333333333333333333333333333"],
    maxValueWei: "1000",
    maxGasWei: "500",
    maxSlippageBps: 50,
    expiresAt: NOW + 100_000,
    nonce: "n-1",
    revocationKey: "rk-1",
    ...overrides,
  };
}

function idOf(grant) {
  return computeGrantId(grant);
}

// ---------------------------------------------------------------------------
// basic reconstruction
// ---------------------------------------------------------------------------

test("grantCreated + grantActivated => active", () => {
  const g = rawGrant();
  const id = idOf(g);
  const events = [
    { type: "grantCreated", at: NOW - 100, grant: g },
    { type: "grantActivated", at: NOW - 50, grantId: id },
  ];
  const { active, historical } = reconstructGrantIndex(events, { now: NOW });
  assert.equal(active.length, 1);
  assert.equal(active[0].grantId, id);
  assert.equal(active[0].status, GRANT_STATUS.ACTIVE);
  assert.equal(historical.length, 0);
});

test("grantCreated without activation is pending, not active", () => {
  const g = rawGrant({ nonce: "n-pending" });
  const id = idOf(g);
  const events = [{ type: "grantCreated", at: NOW - 100, grant: g }];
  const { active, historical } = reconstructGrantIndex(events, { now: NOW });
  assert.equal(active.length, 0);
  assert.equal(historical.length, 1);
  assert.equal(historical[0].status, GRANT_STATUS.PENDING);
});

// ---------------------------------------------------------------------------
// revoked / expired never appear active
// ---------------------------------------------------------------------------

test("revoked grant is excluded from active even though activated", () => {
  const g = rawGrant({ nonce: "n-revoked" });
  const id = idOf(g);
  const events = [
    { type: "grantCreated", at: NOW - 300, grant: g },
    { type: "grantActivated", at: NOW - 200, grantId: id },
    { type: "grantRevoked", at: NOW - 100, grantId: id, reason: "user-initiated" },
  ];
  const { active, historical } = reconstructGrantIndex(events, { now: NOW });
  assert.equal(active.length, 0);
  assert.equal(historical.length, 1);
  assert.equal(historical[0].status, GRANT_STATUS.REVOKED);
  assert.equal(historical[0].reason, "user-initiated");
});

test("explicit grantExpired event excludes from active", () => {
  const g = rawGrant({ nonce: "n-expired-event", expiresAt: NOW + 1_000_000 });
  const id = idOf(g);
  const events = [
    { type: "grantCreated", at: NOW - 300, grant: g },
    { type: "grantActivated", at: NOW - 200, grantId: id },
    { type: "grantExpired", at: NOW - 100, grantId: id },
  ];
  const { active, historical } = reconstructGrantIndex(events, { now: NOW });
  assert.equal(active.length, 0);
  assert.equal(historical[0].status, GRANT_STATUS.EXPIRED);
});

test("grant past its own expiresAt is excluded from active even with no explicit expired event", () => {
  const g = rawGrant({ nonce: "n-schema-expired", expiresAt: NOW - 10 });
  const id = idOf(g);
  const events = [
    { type: "grantCreated", at: NOW - 300, grant: g },
    { type: "grantActivated", at: NOW - 200, grantId: id },
  ];
  const { active, historical } = reconstructGrantIndex(events, { now: NOW });
  assert.equal(active.length, 0);
  assert.equal(historical[0].status, GRANT_STATUS.EXPIRED);
});

test("revocation takes precedence over expiry (matches session-key-model precedence)", () => {
  const g = rawGrant({ nonce: "n-both", expiresAt: NOW - 10 });
  const id = idOf(g);
  const events = [
    { type: "grantCreated", at: NOW - 300, grant: g },
    { type: "grantActivated", at: NOW - 200, grantId: id },
    { type: "grantRevoked", at: NOW - 150, grantId: id },
  ];
  const { historical } = reconstructGrantIndex(events, { now: NOW });
  assert.equal(historical[0].status, GRANT_STATUS.REVOKED);
});

// ---------------------------------------------------------------------------
// restart-safety: reconstruction is a pure function of (events, now)
// ---------------------------------------------------------------------------

test("restart-safe: calling twice on the same events/now yields identical active set", () => {
  const g1 = rawGrant({ nonce: "n-a" });
  const g2 = rawGrant({ nonce: "n-b", expiresAt: NOW - 1 }); // will be expired
  const id1 = idOf(g1);
  const id2 = idOf(g2);
  const events = [
    { type: "grantCreated", at: NOW - 300, grant: g1 },
    { type: "grantActivated", at: NOW - 200, grantId: id1 },
    { type: "grantCreated", at: NOW - 300, grant: g2 },
    { type: "grantActivated", at: NOW - 200, grantId: id2 },
  ];

  // Simulate a process "restart": fresh call, no shared state, from a freshly
  // cloned copy of the same raw event array.
  const run1 = reconstructGrantIndex(JSON.parse(JSON.stringify(events)), { now: NOW });
  const run2 = reconstructGrantIndex(JSON.parse(JSON.stringify(events)), { now: NOW });

  assert.deepEqual(run1.active, run2.active);
  assert.deepEqual(run1.historical, run2.historical);
  assert.deepEqual(run1.all, run2.all);
  assert.equal(run1.active.length, 1);
  assert.equal(run1.active[0].grantId, id1);
});

test("no in-memory state leaks across independent calls (module holds no globals)", () => {
  const g = rawGrant({ nonce: "n-isolated" });
  const id = idOf(g);
  const eventsA = [
    { type: "grantCreated", at: NOW - 100, grant: g },
    { type: "grantActivated", at: NOW - 50, grantId: id },
  ];
  const eventsB = []; // an entirely unrelated, empty log

  const resultB1 = reconstructGrantIndex(eventsB, { now: NOW });
  reconstructGrantIndex(eventsA, { now: NOW }); // interleave a different call
  const resultB2 = reconstructGrantIndex(eventsB, { now: NOW });

  assert.deepEqual(resultB1, resultB2);
  assert.equal(resultB1.active.length, 0);
});

// ---------------------------------------------------------------------------
// ordering independence
// ---------------------------------------------------------------------------

test("ordering independence: shuffled event log reconstructs the same index", () => {
  const gA = rawGrant({ nonce: "n-shuffle-a" });
  const gB = rawGrant({ nonce: "n-shuffle-b", expiresAt: NOW + 500 });
  const idA = idOf(gA);
  const idB = idOf(gB);

  const events = [
    { type: "grantCreated", at: NOW - 400, grant: gA },
    { type: "grantActivated", at: NOW - 300, grantId: idA },
    { type: "grantCreated", at: NOW - 350, grant: gB },
    { type: "grantActivated", at: NOW - 250, grantId: idB },
    { type: "grantRevoked", at: NOW - 100, grantId: idB },
  ];

  const forward = reconstructGrantIndex(events, { now: NOW });
  const reversed = reconstructGrantIndex([...events].reverse(), { now: NOW });

  // Simple deterministic shuffle (reverse pairs) to further mix ordering.
  const shuffled = [events[2], events[4], events[0], events[3], events[1]];
  const shuffledResult = reconstructGrantIndex(shuffled, { now: NOW });

  assert.deepEqual(forward.active, reversed.active);
  assert.deepEqual(forward.historical, reversed.historical);
  assert.deepEqual(forward.active, shuffledResult.active);
  assert.deepEqual(forward.historical, shuffledResult.historical);

  assert.equal(forward.active.length, 1);
  assert.equal(forward.active[0].grantId, idA);
});

test("duplicate grantCreated events for the same identity are idempotent regardless of order", () => {
  const g = rawGrant({ nonce: "n-dup" });
  const id = idOf(g);
  const eventsOrderA = [
    { type: "grantCreated", at: NOW - 500, grant: g },
    { type: "grantCreated", at: NOW - 400, grant: g }, // duplicate, later timestamp
    { type: "grantActivated", at: NOW - 100, grantId: id },
  ];
  const eventsOrderB = [
    { type: "grantCreated", at: NOW - 400, grant: g },
    { type: "grantActivated", at: NOW - 100, grantId: id },
    { type: "grantCreated", at: NOW - 500, grant: g }, // duplicate arrives last, earlier timestamp
  ];

  const resultA = reconstructGrantIndex(eventsOrderA, { now: NOW });
  const resultB = reconstructGrantIndex(eventsOrderB, { now: NOW });

  assert.deepEqual(resultA.active, resultB.active);
  assert.equal(resultA.active[0].createdAt, NOW - 500);
  assert.equal(resultB.active[0].createdAt, NOW - 500);
});

// ---------------------------------------------------------------------------
// helper functions
// ---------------------------------------------------------------------------

test("isGrantActive / getGrantRecord convenience wrappers", () => {
  const g = rawGrant({ nonce: "n-helper" });
  const id = idOf(g);
  const events = [
    { type: "grantCreated", at: NOW - 100, grant: g },
    { type: "grantActivated", at: NOW - 50, grantId: id },
  ];
  assert.equal(isGrantActive(events, id, { now: NOW }), true);
  assert.equal(isGrantActive(events, "0x" + "0".repeat(64), { now: NOW }), false);

  const record = getGrantRecord(events, id, { now: NOW });
  assert.equal(record.grantId, id);
  assert.equal(record.status, GRANT_STATUS.ACTIVE);
  assert.equal(getGrantRecord(events, "missing-id", { now: NOW }), null);
});

// ---------------------------------------------------------------------------
// malformed / unknown-id events are isolated, never crash reconstruction
// ---------------------------------------------------------------------------

test("unknown event types and lifecycle events with no matching grantCreated are reported, not thrown", () => {
  const events = [
    { type: "somethingElse", at: NOW - 10 },
    { type: "grantActivated", at: NOW - 5, grantId: "never-created" },
    { type: "grantRevoked" }, // missing at + grantId
  ];
  const result = reconstructGrantIndex(events, { now: NOW });
  assert.equal(result.active.length, 0);
  // the never-created id shows up as UNKNOWN historical status
  const unknown = result.historical.find((r) => r.grantId === "never-created");
  assert.ok(unknown);
  assert.equal(unknown.status, GRANT_STATUS.UNKNOWN);
  assert.ok(result.invalidEvents.length >= 2);
});

test("grantCreated with an invalid grant payload is rejected, not thrown, and never appears active", () => {
  const badGrant = rawGrant({ actions: [] }); // fails policy-schema validation
  const events = [{ type: "grantCreated", at: NOW - 10, grant: badGrant }];
  const result = reconstructGrantIndex(events, { now: NOW });
  assert.equal(result.active.length, 0);
  assert.equal(result.all.length, 0);
  assert.ok(result.invalidEvents.some((e) => e.type === "grantCreated"));
});

test("grantId hint mismatching content-derived identity is rejected (fail closed, no id spoofing)", () => {
  const g = rawGrant({ nonce: "n-spoof" });
  const events = [
    { type: "grantCreated", at: NOW - 10, grant: g, grantId: "0x" + "f".repeat(64) },
  ];
  const result = reconstructGrantIndex(events, { now: NOW });
  assert.equal(result.all.length, 0);
  assert.ok(result.invalidEvents.some((e) => /does not match/.test(e.message)));
});

test("events dated after `now` are not yet applied (chain is source of truth for what has happened)", () => {
  const g = rawGrant({ nonce: "n-future" });
  const id = idOf(g);
  const events = [
    { type: "grantCreated", at: NOW - 100, grant: g },
    { type: "grantActivated", at: NOW + 10_000, grantId: id }, // future activation
  ];
  const result = reconstructGrantIndex(events, { now: NOW });
  assert.equal(result.active.length, 0);
  assert.equal(result.historical[0].status, GRANT_STATUS.PENDING);
});

// ---------------------------------------------------------------------------
// no-secret invariant
// ---------------------------------------------------------------------------

const SECRET_MARKERS = [
  "keystoreSecret",
  "sessionSecret",
  "bearerToken",
  "apiKey",
  "privateKey",
  "houseWalletKey",
  "SEED_PHRASE",
  "PRIVATE_HOUSE_WALLET",
];

test("no-secret invariant: audit output never contains injected secret-shaped fields, even under attack", () => {
  const g = rawGrant({ nonce: "n-secret-attempt" });
  const id = idOf(g);

  // Attempt to smuggle secret-shaped fields at every level an attacker could
  // reach: on the raw event envelope, inside the grant payload (rejected by
  // policy-schema's unknown-field fail-closed rule, but we still assert here
  // defensively), and on lifecycle events.
  const events = [
    {
      type: "grantCreated",
      at: NOW - 200,
      grant: g,
      apiKey: "sk-should-never-appear",
      bearerToken: "Bearer super-secret",
      privateKey: "0xdeadbeef-should-not-leak",
    },
    {
      type: "grantActivated",
      at: NOW - 100,
      grantId: id,
      sessionSecret: "should-not-leak-either",
      houseWalletKey: "0xhouse-secret",
    },
    {
      type: "grantRevoked",
      at: NOW - 50,
      grantId: id,
      reason: "rotation",
      keystoreSecret: "/should/not/leak/path",
      SEED_PHRASE: "twelve secret words should never leak",
    },
  ];

  const result = reconstructGrantIndex(events, { now: NOW });
  const serialized = JSON.stringify(result);

  for (const marker of SECRET_MARKERS) {
    assert.equal(
      serialized.includes(marker),
      false,
      `secret-shaped marker "${marker}" leaked into audit output`
    );
  }
  // Sanity: the wanted public fields ARE present (proves this isn't a
  // trivially-empty-output false pass).
  assert.ok(serialized.includes(id));
  assert.ok(serialized.includes("swap:exec"));
});

test("no-secret invariant: a grant payload that smuggles an extra field is rejected outright, not partially indexed", () => {
  const poisoned = { ...rawGrant({ nonce: "n-smuggle" }), privateKey: "0xleaked-secret-value" };
  const events = [{ type: "grantCreated", at: NOW - 10, grant: poisoned }];
  const result = reconstructGrantIndex(events, { now: NOW });
  assert.equal(result.all.length, 0);
  // The rejected FIELD NAME may surface in a validation error message (that's
  // just "field privateKey is not allowed", useful for debugging and not
  // sensitive) — but the secret VALUE must never appear anywhere in output.
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("0xleaked-secret-value"), false);
});

test("GRANT_EVENT_TYPES matches the four documented event kinds", () => {
  assert.deepEqual(
    [...GRANT_EVENT_TYPES].sort(),
    ["grantActivated", "grantCreated", "grantExpired", "grantRevoked"]
  );
});
