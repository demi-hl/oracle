// Tests — Oracle Control end-to-end session orchestrator (Slice J).
//
// Proves the orchestrator is pure glue over the already-tested lanes:
//   - plan -> activate -> revoke happy path
//   - explicit SECONDS<->MILLISECONDS conversion (ms === seconds * 1000)
//   - every userOp leaves UNSIGNED (signature === "0x")
//   - fail-closed no-secret invariant on every return
//   - out-of-policy grants are refused at planConnection (never reach AA lane)

import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, getBytes } from "ethers";

import {
  planConnection,
  activateSession,
  createSessionOrchestrator,
  revokeSession,
  describeActive,
  scanPublicReturn,
  ORCHESTRATOR_KINDS,
} from "../src/public-control/session-orchestrator.mjs";
import { GrantValidationError, grantId as computeControlGrantId } from "../src/public-control/policy-schema.mjs";
import { SecretLeakError } from "../src/public-api/connect-agent.mjs";
import { createRevocationRegistry, sessionStatus, SESSION_STATUS } from "../src/public-control/session-key-model.mjs";

const ACCOUNT = "0x00000000000000000000000000000000000000aa";
const AGENT = "0x00000000000000000000000000000000000000a1";
const TARGET = "0x00000000000000000000000000000000000000b2";
const MODULE = "0x00000000000000000000000000000000000000c3";

const NOW_S = 1_700_000_000; // control lane — UNIX SECONDS
const NOW_MS = NOW_S * 1000; // AA lane — MILLISECONDS

function baseGrantInput(overrides = {}) {
  return {
    chainId: 8453,
    agentAddress: AGENT,
    accountAddress: ACCOUNT,
    actions: ["swap:exec", "read:balance"],
    targets: [TARGET],
    maxValueWei: "1000000000000000000",
    maxGasWei: "50000000000000000",
    maxSlippageBps: 50,
    expiresAt: NOW_S + 3600, // UNIX SECONDS
    nonce: "n-1",
    revocationKey: "revoke.n-1",
    ...overrides,
  };
}

function userOpParams(overrides = {}) {
  return {
    nonce: 7,
    callGasLimit: 200_000,
    verificationGasLimit: 150_000,
    preVerificationGas: 50_000,
    maxFeePerGas: 1_000_000_000,
    maxPriorityFeePerGas: 100_000_000,
    ...overrides,
  };
}

function sessionKeyModelParams(overrides = {}) {
  return {
    moduleAddress: MODULE,
    issuedAtMs: NOW_MS, // MILLISECONDS
    userOp: userOpParams(),
    ...overrides,
  };
}

const OWNER_SIG = "0xdeadbeef01";
const trustedOrchestrator = createSessionOrchestrator({
  verifyOwnerSignature: async ({ ownerSignature }) => ownerSignature === OWNER_SIG,
});

function activateWithTrustedVerifier(params) {
  return trustedOrchestrator.activateSession(params);
}

// ---------------------------------------------------------------------------
// planConnection
// ---------------------------------------------------------------------------

test("planConnection returns unsigned grant, signing bytes, and render", () => {
  const plan = planConnection(baseGrantInput(), { now: NOW_S });

  assert.equal(plan.kind, ORCHESTRATOR_KINDS.PLAN);
  assert.equal(plan.unsigned, true);
  assert.equal(typeof plan.grantId, "string");
  assert.equal(plan.grantId, computeControlGrantId(baseGrantInput()));
  assert.equal(plan.unsignedGrant.unsigned, true);
  assert.equal(plan.signingBytes, plan.unsignedGrant.signing);
  assert.match(plan.signingBytes.bytesHex, /^0x[0-9a-f]+$/);
  assert.equal(plan.signingBytes.sha256, plan.grantId);
  assert.match(plan.render, /UNSIGNED/);
  assert.ok(Object.isFrozen(plan));
});

test("planConnection is deterministic for identical input", () => {
  const a = planConnection(baseGrantInput(), { now: NOW_S });
  const b = planConnection(baseGrantInput(), { now: NOW_S });
  assert.equal(a.grantId, b.grantId);
  assert.equal(a.signingBytes.bytesHex, b.signingBytes.bytesHex);
});

test("planConnection refuses an out-of-policy grant (wildcard action)", () => {
  assert.throws(
    () => planConnection(baseGrantInput({ actions: ["*"] }), { now: NOW_S }),
    GrantValidationError
  );
});

test("planConnection refuses an expired grant against now", () => {
  assert.throws(
    () => planConnection(baseGrantInput({ expiresAt: NOW_S - 1 }), { now: NOW_S }),
    GrantValidationError
  );
});

test("planConnection refuses unknown fields and state-changing scope with empty targets", () => {
  assert.throws(
    () => planConnection(baseGrantInput({ surprise: 1 }), { now: NOW_S }),
    GrantValidationError
  );
  assert.throws(
    () => planConnection(baseGrantInput({ targets: [] }), { now: NOW_S }),
    GrantValidationError
  );
});

// ---------------------------------------------------------------------------
// activateSession
// ---------------------------------------------------------------------------

test("activateSession bridges SECONDS -> MILLISECONDS explicitly (ms === s * 1000)", async () => {
  const input = baseGrantInput();
  const activation = await activateWithTrustedVerifier({
    grant: input,
    ownerSignature: OWNER_SIG,
    sessionKeyModel: sessionKeyModelParams(),
  });

  assert.equal(activation.kind, ORCHESTRATOR_KINDS.ACTIVATION);
  // THE unit rule: control lane seconds * 1000 === AA lane milliseconds.
  assert.equal(activation.units.expiresAtSeconds, input.expiresAt);
  assert.equal(activation.units.expiresAtMs, input.expiresAt * 1000);
  assert.equal(activation.sessionGrant.expiresAtMs, activation.units.expiresAtSeconds * 1000);
});

test("activateSession returns UNSIGNED userOp (signature '0x') + install calldata", async () => {
  const activation = await activateWithTrustedVerifier({
    grant: baseGrantInput(),
    ownerSignature: OWNER_SIG,
    sessionKeyModel: sessionKeyModelParams(),
  });

  assert.equal(activation.unsigned, true);
  assert.equal(activation.userOp.signature, "0x"); // never signed here
  assert.equal(activation.userOp.callData, activation.install.data);
  assert.equal(activation.install.to.toLowerCase(), MODULE.toLowerCase());
  assert.match(activation.install.data, /^0x[0-9a-f]+$/i);
  assert.match(activation.sessionId, /^0x[0-9a-f]{64}$/);
  assert.equal(activation.grantId, computeControlGrantId(baseGrantInput()));
  // the AA-lane grant it produced is ACTIVE at issuance time
  assert.equal(
    sessionStatus(activation.sessionGrant, { nowMs: NOW_MS }),
    SESSION_STATUS.ACTIVE
  );
});

test("activateSession requires a verified ownerSignature and never returns it", async () => {
  await assert.rejects(
    () => activateWithTrustedVerifier({ grant: baseGrantInput(), sessionKeyModel: sessionKeyModelParams() }),
    /ownerSignature is required/
  );
  await assert.rejects(
    () =>
      activateWithTrustedVerifier({
        grant: baseGrantInput(),
        ownerSignature: "  ",
        sessionKeyModel: sessionKeyModelParams(),
      }),
    /ownerSignature is required/
  );
  await assert.rejects(
    () =>
      activateWithTrustedVerifier({
        grant: baseGrantInput(),
        ownerSignature: "not-hex",
        sessionKeyModel: sessionKeyModelParams(),
      }),
    /0x-prefixed hex/
  );
  const rejectingOrchestrator = createSessionOrchestrator({
    verifyOwnerSignature: async () => false,
  });
  await assert.rejects(
    () =>
      rejectingOrchestrator.activateSession({
        grant: baseGrantInput(),
        ownerSignature: OWNER_SIG,
        sessionKeyModel: sessionKeyModelParams(),
      }),
    /verification failed/
  );

  const activation = await activateWithTrustedVerifier({
    grant: baseGrantInput(),
    ownerSignature: OWNER_SIG,
    sessionKeyModel: sessionKeyModelParams(),
  });
  // the owner's signature never appears anywhere in the return
  assert.ok(!JSON.stringify(activation).includes(OWNER_SIG.slice(2)));
});

test("activateSession recovers an EOA owner signature without a custom verifier", async () => {
  const owner = Wallet.createRandom();
  const grant = baseGrantInput({ accountAddress: owner.address });
  const plan = planConnection(grant, { now: NOW_S });
  const ownerSignature = await owner.signMessage(getBytes(plan.signingBytes.bytesHex));
  const activation = await activateSession({
    grant,
    ownerSignature,
    sessionKeyModel: sessionKeyModelParams(),
  });
  assert.equal(activation.grantId, plan.grantId);
});

test("activateSession does not trust a verifier nested in caller-controlled session params", async () => {
  await assert.rejects(
    () => activateSession({
      grant: baseGrantInput(),
      ownerSignature: OWNER_SIG,
      sessionKeyModel: sessionKeyModelParams({ verifyOwnerSignature: async () => true }),
    }),
    /could not be verified/,
  );
});

test("activateSession does not trust a verifier supplied on the activation call", async () => {
  await assert.rejects(
    () => activateSession(
      {
        grant: baseGrantInput(),
        ownerSignature: OWNER_SIG,
        sessionKeyModel: sessionKeyModelParams(),
      },
      { verifyOwnerSignature: async () => true },
    ),
    /could not be verified/,
  );
});

test("activateSession refuses an out-of-policy grant before touching the AA lane", async () => {
  await assert.rejects(
    () =>
      activateWithTrustedVerifier({
        grant: baseGrantInput({ expiresAt: NOW_S - 10 }), // already expired
        ownerSignature: OWNER_SIG,
        sessionKeyModel: sessionKeyModelParams(),
      }),
    GrantValidationError
  );
});

// ---------------------------------------------------------------------------
// revokeSession
// ---------------------------------------------------------------------------

test("revokeSession returns revoke calldata + registry entry (MILLISECONDS)", async () => {
  const activation = await activateWithTrustedVerifier({
    grant: baseGrantInput(),
    ownerSignature: OWNER_SIG,
    sessionKeyModel: sessionKeyModelParams(),
  });

  const registry = createRevocationRegistry();
  const revocation = revokeSession(activation.sessionGrant, {
    moduleAddress: MODULE,
    registry,
    nowMs: NOW_MS + 5_000, // MILLISECONDS
    reason: "user clicked revoke",
  });

  assert.equal(revocation.kind, ORCHESTRATOR_KINDS.REVOCATION);
  assert.equal(revocation.sessionId, activation.sessionId);
  assert.match(revocation.revoke.data, /^0x[0-9a-f]+$/i);
  assert.equal(revocation.revocation.revokedAtMs, NOW_MS + 5_000);
  assert.equal(revocation.revocation.reason, "user clicked revoke");
  assert.equal(registry.isRevoked(activation.sessionId), true);

  // downstream: the session-key-model now reports REVOKED
  assert.equal(
    sessionStatus(activation.sessionGrant, { nowMs: NOW_MS + 6_000, revocation: registry }),
    SESSION_STATUS.REVOKED
  );
});

test("revokeSession accepts a raw session id and creates a registry when none given", () => {
  const rawId = `0x${"ab".repeat(32)}`;
  const revocation = revokeSession(rawId, { moduleAddress: MODULE, nowMs: NOW_MS });
  assert.equal(revocation.sessionId, rawId);
  assert.equal(revocation.registry.isRevoked(rawId), true);
});

// ---------------------------------------------------------------------------
// describeActive
// ---------------------------------------------------------------------------

test("describeActive reconstructs the active list against a SECONDS now", () => {
  const grant = baseGrantInput();
  const id = computeControlGrantId(grant);
  const events = [
    { type: "grantCreated", at: NOW_S - 100, grant },
    { type: "grantActivated", at: NOW_S - 50, grantId: id },
  ];

  const description = describeActive(events, NOW_S);
  assert.equal(description.kind, ORCHESTRATOR_KINDS.DESCRIPTION);
  assert.equal(description.count, 1);
  assert.equal(description.active[0].grantId, id);
  assert.equal(description.active[0].status, "active");

  // revocation flips it out of the active set
  const afterRevoke = describeActive(
    [...events, { type: "grantRevoked", at: NOW_S - 10, grantId: id, reason: "done" }],
    NOW_S
  );
  assert.equal(afterRevoke.count, 0);

  // and a SECONDS clock past expiresAt expires it (no ms confusion:
  // NOW_S + 3601 is seconds, not milliseconds)
  const afterExpiry = describeActive(events, grant.expiresAt + 1);
  assert.equal(afterExpiry.count, 0);
});

// ---------------------------------------------------------------------------
// full lifecycle + no-secret invariant
// ---------------------------------------------------------------------------

test("happy path: plan -> activate -> revoke -> describe", async () => {
  const input = baseGrantInput();

  const plan = planConnection(input, { now: NOW_S });
  const activation = await activateWithTrustedVerifier({
    grant: plan.grant,
    ownerSignature: OWNER_SIG,
    sessionKeyModel: sessionKeyModelParams(),
  });
  assert.equal(activation.grantId, plan.grantId);
  assert.equal(activation.userOp.signature, "0x");

  const revocation = revokeSession(activation.sessionGrant, {
    moduleAddress: MODULE,
    nowMs: NOW_MS + 1_000,
  });
  assert.equal(revocation.sessionId, activation.sessionId);

  const events = [
    { type: "grantCreated", at: NOW_S - 10, grant: input },
    { type: "grantActivated", at: NOW_S - 5, grantId: plan.grantId },
    // UNIT BOUNDARY: registry recorded MILLISECONDS; the control-lane event
    // log records SECONDS — explicit conversion at the bridge.
    { type: "grantRevoked", at: Math.floor(revocation.revocation.revokedAtMs / 1000), grantId: plan.grantId },
  ];
  const description = describeActive(events, NOW_S + 2);
  assert.equal(description.count, 0);
  const record = description.index.all.find((r) => r.grantId === plan.grantId);
  assert.equal(record.status, "revoked");
});

test("no-secret invariant holds on every orchestrator return", async () => {
  const plan = planConnection(baseGrantInput(), { now: NOW_S });
  const activation = await activateWithTrustedVerifier({
    grant: baseGrantInput(),
    ownerSignature: OWNER_SIG,
    sessionKeyModel: sessionKeyModelParams(),
  });
  const revocation = revokeSession(activation.sessionGrant, {
    moduleAddress: MODULE,
    nowMs: NOW_MS,
  });
  const description = describeActive(
    [{ type: "grantCreated", at: NOW_S - 1, grant: baseGrantInput() }],
    NOW_S
  );

  // scanPublicReturn re-runs the fail-closed scan; all four returns pass.
  for (const value of [plan, activation, revocation, description]) {
    assert.equal(scanPublicReturn(value), value);
  }

  // and the scan genuinely fails closed on secret-shaped material
  assert.throws(
    () => scanPublicReturn({ privateKey: "boom" }),
    SecretLeakError
  );
  assert.throws(
    () => scanPublicReturn({ innocuous: `0x${"11".repeat(32)}` }), // raw 32-byte hex NOT at an id key
    SecretLeakError
  );
  assert.throws(
    () => scanPublicReturn({ note: "keystore path here" }),
    SecretLeakError
  );
  // a userOp whose signature is anything but "0x" is refused outright
  assert.throws(
    () => scanPublicReturn({ signature: "0xdeadbeef" }),
    /never signs/
  );
});
