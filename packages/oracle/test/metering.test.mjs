// Metered API access. The public plane already serves the data Zerion and
// Zapper charge for; this layer tells a paying integrator from a stranger
// without adding a database or breaking anonymous access.
import test from "node:test";
import assert from "node:assert/strict";
import {
  TIERS,
  issueKey,
  readKey,
  resolveAccess,
  meter,
  describePlans,
} from "../src/public-api/metering.mjs";

const SECRET = "metering-test-secret";

test("no key is the free tier, not an error", () => {
  // The public plane must keep working for anonymous callers. If adding
  // metering 401s them, it has broken the thing it was meant to monetise.
  const r = resolveAccess({ key: "", secret: SECRET });
  assert.equal(r.ok, true);
  assert.equal(r.tier.name, "free");
  assert.equal(r.anonymous, true);
});

test("a valid key resolves to its tier", () => {
  const key = issueKey({ subject: "acme", tier: "build", secret: SECRET });
  const r = resolveAccess({ key, secret: SECRET });
  assert.equal(r.ok, true);
  assert.equal(r.tier.name, "build");
  assert.equal(r.subject, "acme");
});

test("a forged key is refused, never silently downgraded", () => {
  // Downgrading to free would let an attacker probe which keys exist by
  // watching for a different response.
  const key = issueKey({ subject: "acme", tier: "scale", secret: SECRET });
  const tampered = key.slice(0, -4) + "AAAA";
  assert.equal(resolveAccess({ key: tampered, secret: SECRET }).ok, false);
  assert.equal(resolveAccess({ key: "ok_garbage.sig", secret: SECRET }).ok, false);
  assert.equal(resolveAccess({ key: key, secret: "wrong-secret" }).ok, false);
});

test("a key cannot be edited to claim a higher tier", () => {
  const key = issueKey({ subject: "acme", tier: "build", secret: SECRET });
  const [payload] = key.slice(3).split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  claims.tier = "scale";
  const forgedPayload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const forged = `ok_${forgedPayload}.${key.split(".")[1]}`;
  assert.equal(resolveAccess({ key: forged, secret: SECRET }).ok, false);
});

test("an expired key is refused", () => {
  const key = issueKey({ subject: "acme", tier: "build", secret: SECRET, ttlMs: 1000, now: 0 });
  assert.equal(resolveAccess({ key, secret: SECRET, now: 5000 }).ok, false);
  assert.equal(resolveAccess({ key, secret: SECRET, now: 500 }).ok, true);
});

test("Locals Only status never changes API access tiers", () => {
  const r = resolveAccess({ key: "", isHolder: true, secret: SECRET });
  assert.equal(r.ok, true);
  assert.equal(r.tier.name, "free");
  assert.equal(r.tier.rpm, TIERS.free.rpm);
});

test("Locals Only status never changes a paid key tier", () => {
  const key = issueKey({ subject: "acme", tier: "scale", secret: SECRET });
  const r = resolveAccess({ key, isHolder: true, secret: SECRET });
  assert.equal(r.tier.name, "scale");
});

test("the meter enforces the per-minute ceiling", () => {
  const store = new Map();
  const rpm = 3;
  for (let i = 0; i < rpm; i += 1) {
    assert.equal(meter({ store, subject: "acme", rpm, now: 1000 }).allowed, true, `request ${i + 1}`);
  }
  const blocked = meter({ store, subject: "acme", rpm, now: 1000 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
});

test("the meter window rolls over", () => {
  const store = new Map();
  meter({ store, subject: "acme", rpm: 1, now: 0 });
  assert.equal(meter({ store, subject: "acme", rpm: 1, now: 100 }).allowed, false);
  assert.equal(meter({ store, subject: "acme", rpm: 1, now: 60_001 }).allowed, true);
});

test("subjects are metered independently", () => {
  const store = new Map();
  meter({ store, subject: "acme", rpm: 1, now: 0 });
  assert.equal(meter({ store, subject: "other", rpm: 1, now: 0 }).allowed, true,
    "one integrator must not exhaust another's quota");
});

test("published plans leak no secrets", () => {
  const plans = describePlans();
  const serialized = JSON.stringify(plans);
  for (const banned of ["secret", "sub", "hmac", "key"]) {
    assert.ok(!serialized.toLowerCase().includes(banned), `plans must not expose ${banned}`);
  }
  assert.equal(plans.some((p) => p.tier === "holder"), false);
});

test("the Buzz catalog publishes tiers without breaking existing consumers", async () => {
  const { buildBuzzCatalog } = await import("../src/public-api/buzz-integration.mjs");
  // Existing shape must be unchanged when no plans are passed — an integrator
  // already parsing this document cannot be broken by adding monetisation.
  const before = buildBuzzCatalog({ baseUrl: "https://x" });
  assert.equal(before.access, undefined);
  assert.equal(before.ok, true);
  assert.ok(Array.isArray(before.endpoints));

  const after = buildBuzzCatalog({ baseUrl: "https://x", plans: describePlans() });
  assert.equal(after.ok, true);
  assert.equal(after.access.anonymous, true, "anonymous access must survive monetisation");
  assert.equal(after.access.plans.some((p) => p.tier === "holder"), false);
  assert.deepEqual(after.endpoints, before.endpoints, "endpoints must not change");
});

test("the catalog still declares no house custody", async () => {
  // Monetising must not quietly change the custody posture.
  const { buildBuzzCatalog } = await import("../src/public-api/buzz-integration.mjs");
  const cat = JSON.stringify(buildBuzzCatalog({ baseUrl: "https://x", plans: describePlans() }));
  assert.ok(cat.includes("user-signs"), "custody must stay user-signs");
  assert.ok(cat.includes("DISARMED"), "default posture must stay disarmed");
  assert.ok(!cat.toLowerCase().includes("privatekey"), "no key material in a public document");
});
