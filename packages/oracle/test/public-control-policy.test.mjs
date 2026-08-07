// Oracle Control policy core tests (Slice A).
//
// Proves: (1) canonicalization stability across key order / casing / numeric
// representation, (2) fail-closed validation rejection cases, (3) exact
// byte-for-byte render output.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateGrant,
  normalizeGrant,
  canonicalizeGrant,
  grantId,
  isExpired,
  isReadonlyAction,
  GrantValidationError,
  REQUIRED_FIELDS,
} from "../src/public-control/policy-schema.mjs";
import { renderGrant, formatWei, formatBps } from "../src/public-control/policy-render.mjs";

const AGENT = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const ACCOUNT = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";
const TARGET = "0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc";

function baseGrant(overrides = {}) {
  return {
    chainId: 8453,
    agentAddress: AGENT,
    accountAddress: ACCOUNT,
    actions: ["prepare:trade", "read:markets"],
    targets: [TARGET],
    maxValueWei: "50000000000000000",
    maxGasWei: "5000000000000000",
    maxSlippageBps: 50,
    expiresAt: 1790000000,
    nonce: "n-1",
    revocationKey: "rk_public_1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Canonicalization stability
// ---------------------------------------------------------------------------

test("canonicalization: exact canonical string with sorted keys", () => {
  assert.equal(
    canonicalizeGrant(baseGrant()),
    '{"version":1,"accountAddress":"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",' +
      '"actions":["prepare:trade","read:markets"],' +
      '"agentAddress":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",' +
      '"chainId":8453,"expiresAt":1790000000,"maxGasWei":"5000000000000000",' +
      '"maxSlippageBps":50,"maxValueWei":"50000000000000000","nonce":"n-1",' +
      '"revocationKey":"rk_public_1",' +
      '"targets":["0xcccccccccccccccccccccccccccccccccccccccc"]}'
  );
});

test("canonicalization: stable across key order, address casing, numeric representation, and array order", () => {
  const reference = canonicalizeGrant(baseGrant());

  // Reversed key order, lowercase addresses, bigint/number/string amounts,
  // reordered + duplicated actions.
  const shuffled = {
    revocationKey: "rk_public_1",
    nonce: "n-1",
    expiresAt: "1790000000",
    maxSlippageBps: "50",
    maxGasWei: 5000000000000000n,
    maxValueWei: 50000000000000000n,
    targets: [TARGET.toLowerCase()],
    actions: ["read:markets", "prepare:trade", "read:markets"],
    accountAddress: ACCOUNT.toLowerCase(),
    agentAddress: AGENT.toLowerCase(),
    chainId: "8453",
  };
  assert.equal(canonicalizeGrant(shuffled), reference);
  assert.equal(grantId(shuffled), grantId(baseGrant()));
});

test("canonicalization: grant id is the sha256 of the canonical form and is stable", () => {
  assert.equal(
    grantId(baseGrant()),
    "8435ad682284d797751006ccb028bbcdd616be3079ebc10207e6c062e678335d"
  );
  // Any semantic change changes the id.
  assert.notEqual(grantId(baseGrant({ nonce: "n-2" })), grantId(baseGrant()));
  assert.notEqual(grantId(baseGrant({ chainId: 1 })), grantId(baseGrant()));
});

test("normalizeGrant: addresses lowercased, arrays deduped+sorted, amounts canonical decimal strings", () => {
  const g = normalizeGrant(
    baseGrant({
      actions: ["read:markets", "prepare:trade", "prepare:trade"],
      targets: [TARGET, TARGET.toLowerCase()],
      maxValueWei: 50000000000000000n,
      maxSlippageBps: "50",
    })
  );
  assert.equal(g.agentAddress, AGENT.toLowerCase());
  assert.equal(g.accountAddress, ACCOUNT.toLowerCase());
  assert.deepEqual(g.actions, ["prepare:trade", "read:markets"]);
  assert.deepEqual(g.targets, [TARGET.toLowerCase()]);
  assert.equal(g.maxValueWei, "50000000000000000");
  assert.equal(g.maxSlippageBps, 50);
});

// ---------------------------------------------------------------------------
// Fail-closed validation
// ---------------------------------------------------------------------------

test("fail closed: every required field is required (expiry, chain, agent, account, ...)", () => {
  for (const field of REQUIRED_FIELDS) {
    const g = baseGrant();
    delete g[field];
    const res = validateGrant(g);
    assert.equal(res.ok, false, `${field} missing must fail`);
    assert.equal(res.grant, null);
    assert.ok(res.errors.some((e) => e.field === field), `${field} named in errors`);
  }
  // null is as bad as missing.
  assert.equal(validateGrant(baseGrant({ expiresAt: null })).ok, false);
});

test("fail closed: unknown fields are rejected (no smuggled authority)", () => {
  const res = validateGrant(baseGrant({ privateKey: "0xdeadbeef" }));
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.field === "privateKey"));
});

test("fail closed: broad wildcard actions rejected by default", () => {
  for (const bad of [["*"], ["*:*"], ["trade:*"], ["read:markets", "*"]]) {
    const res = validateGrant(baseGrant({ actions: bad }));
    assert.equal(res.ok, false, `actions ${JSON.stringify(bad)} must fail`);
    assert.ok(res.errors.some((e) => e.field === "actions" && /wildcard/.test(e.message)));
  }
});

test("wildcard verbs are rejected even with allowWildcardActions opt-in", () => {
  // Narrow resource wildcard allowed only with explicit opt-in...
  assert.equal(
    validateGrant(baseGrant({ actions: ["read:*"] }), { allowWildcardActions: true }).ok,
    true
  );
  // ...but "*" and "*:*" stay rejected no matter what.
  for (const bad of [["*"], ["*:*"]]) {
    assert.equal(
      validateGrant(baseGrant({ actions: bad }), { allowWildcardActions: true }).ok,
      false
    );
  }
});

test("fail closed: empty targets only allowed for read/simulate scopes", () => {
  // Write scope + empty targets => rejected.
  const res = validateGrant(baseGrant({ actions: ["prepare:trade"], targets: [] }));
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.field === "targets" && /read\/simulate/.test(e.message)));

  // Mixed read + write with empty targets => still rejected.
  assert.equal(
    validateGrant(baseGrant({ actions: ["read:markets", "prepare:trade"], targets: [] })).ok,
    false
  );

  // Pure read/simulate with empty targets => allowed.
  const ok = validateGrant(baseGrant({ actions: ["read:markets", "simulate:trade"], targets: [] }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.grant.targets, []);
});

test("fail closed: malformed addresses, chain, amounts, slippage, actions", () => {
  const cases = [
    ["agentAddress", "not-an-address"],
    ["agentAddress", "0x1234"],
    ["accountAddress", "0xZZZZaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    ["chainId", 0],
    ["chainId", -1],
    ["chainId", 1.5],
    ["maxValueWei", "-1"],
    ["maxValueWei", "1.5"],
    ["maxValueWei", "0x10"],
    ["maxGasWei", "abc"],
    ["maxSlippageBps", 10001],
    ["maxSlippageBps", -1],
    ["actions", []],
    ["actions", ["READ:markets"]],
    ["actions", ["noverb"]],
    ["targets", ["*"]],
    ["targets", ["0x1234"]],
    ["nonce", ""],
    ["nonce", "bad nonce with spaces"],
    ["revocationKey", ""],
    ["expiresAt", 0],
    ["expiresAt", -5],
  ];
  for (const [field, value] of cases) {
    const res = validateGrant(baseGrant({ [field]: value }));
    assert.equal(res.ok, false, `${field}=${JSON.stringify(value)} must fail`);
    assert.ok(res.errors.some((e) => e.field === field), `${field} named in errors`);
  }
});

test("fail closed: non-object inputs rejected", () => {
  for (const bad of [null, undefined, "grant", 42, [], true]) {
    assert.equal(validateGrant(bad).ok, false);
  }
});

test("expiry: deterministic liveness check against explicit now", () => {
  const g = baseGrant(); // expiresAt 1790000000
  assert.equal(validateGrant(g, { now: 1789999999 }).ok, true);
  assert.equal(validateGrant(g, { now: 1790000000 }).ok, false); // expiry is exclusive
  assert.equal(validateGrant(g, { now: 1790000001 }).ok, false);

  assert.equal(isExpired(normalizeGrant(g), 1789999999), false);
  assert.equal(isExpired(normalizeGrant(g), 1790000000), true);
  assert.equal(isExpired({}, 1), true); // malformed => expired (fail closed)
  assert.equal(isExpired(normalizeGrant(g), null), true);
});

test("expiry: a live grant cannot exceed the hard 24-hour TTL", () => {
  const now = 1_800_000_000;
  assert.equal(validateGrant(baseGrant({ expiresAt: now + 86_400 }), { now }).ok, true);
  const tooLong = validateGrant(baseGrant({ expiresAt: now + 86_401 }), { now });
  assert.equal(tooLong.ok, false);
  assert.ok(tooLong.errors.some((error) => error.field === "expiresAt" && /24-hour TTL/.test(error.message)));
});

test("normalizeGrant throws GrantValidationError with structured errors", () => {
  assert.throws(
    () => normalizeGrant(baseGrant({ chainId: null })),
    (err) => {
      assert.ok(err instanceof GrantValidationError);
      assert.ok(Array.isArray(err.errors) && err.errors.length > 0);
      assert.ok(err.errors.some((e) => e.field === "chainId"));
      return true;
    }
  );
});

test("isReadonlyAction classifies verbs", () => {
  assert.equal(isReadonlyAction("read:markets"), true);
  assert.equal(isReadonlyAction("simulate:trade"), true);
  assert.equal(isReadonlyAction("prepare:trade"), false);
  assert.equal(isReadonlyAction("agent:execute"), false);
});

// ---------------------------------------------------------------------------
// Exact render output
// ---------------------------------------------------------------------------

test("render helpers: exact formatting", () => {
  assert.equal(formatWei("50000000000000000"), "50,000,000,000,000,000 wei");
  assert.equal(formatWei("0"), "0 wei");
  assert.equal(formatBps(50), "50 bps (0.50%)");
  assert.equal(formatBps(10000), "10000 bps (100.00%)");
});

test("render: exact output for a state-changing grant", () => {
  const expected = [
    "ORACLE CONTROL GRANT (deterministic authorization)",
    "==================================================",
    "Grant ID:     8435ad682284d797751006ccb028bbcdd616be3079ebc10207e6c062e678335d",
    "Version:      1",
    "Chain:        8453",
    "Agent:        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "Account:      0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "Actions:      prepare:trade, read:markets",
    "Targets:      0xcccccccccccccccccccccccccccccccccccccccc",
    "Max value:    50,000,000,000,000,000 wei",
    "Max gas:      5,000,000,000,000,000 wei",
    "Max slippage: 50 bps (0.50%)",
    "Expires:      2026-09-21T14:13:20.000Z (unix 1790000000)",
    "Nonce:        n-1",
    "Revocation:   rk_public_1",
    "--------------------------------------------------",
    "Scope: includes state-changing actions bounded by the caps above.",
    "Self-custodial: this grant contains public data only and can be revoked at any time via the revocation key.",
  ].join("\n");
  assert.equal(renderGrant(baseGrant()), expected);
});

test("render: exact output for a read-only grant with empty targets", () => {
  const expected = [
    "ORACLE CONTROL GRANT (deterministic authorization)",
    "==================================================",
    "Grant ID:     cc193f4dc8eefca076e4feeef6c8c30221288b5d7518f7b6542e0d452304346a",
    "Version:      1",
    "Chain:        8453",
    "Agent:        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "Account:      0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "Actions:      read:markets, simulate:trade",
    "Targets:      (none — read/simulate only)",
    "Max value:    50,000,000,000,000,000 wei",
    "Max gas:      5,000,000,000,000,000 wei",
    "Max slippage: 50 bps (0.50%)",
    "Expires:      2026-09-21T14:13:20.000Z (unix 1790000000)",
    "Nonce:        n-1",
    "Revocation:   rk_public_1",
    "--------------------------------------------------",
    "Scope: read/simulate only — this grant cannot move funds.",
    "Self-custodial: this grant contains public data only and can be revoked at any time via the revocation key.",
  ].join("\n");
  assert.equal(
    renderGrant(baseGrant({ actions: ["read:markets", "simulate:trade"], targets: [] })),
    expected
  );
});

test("render: identical grants render identically regardless of input shape", () => {
  const a = renderGrant(baseGrant());
  const b = renderGrant({
    revocationKey: "rk_public_1",
    nonce: "n-1",
    expiresAt: "1790000000",
    maxSlippageBps: "50",
    maxGasWei: 5000000000000000n,
    maxValueWei: "50000000000000000",
    targets: [TARGET.toLowerCase()],
    actions: ["read:markets", "prepare:trade"],
    accountAddress: ACCOUNT.toLowerCase(),
    agentAddress: AGENT,
    chainId: "8453",
  });
  assert.equal(a, b);
});

test("render: invalid grants cannot be rendered (fail closed)", () => {
  assert.throws(() => renderGrant(baseGrant({ expiresAt: null })), GrantValidationError);
  assert.throws(() => renderGrant(baseGrant({ actions: ["*"] })), GrantValidationError);
});
