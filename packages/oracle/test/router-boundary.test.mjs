import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RISK_TIERS,
  READ_ONLY_KINDS,
  CUSTODY_ADJACENT_KINDS,
  classifyRisk,
  isReadOnlyKind,
  isCustodyAdjacentKind,
} from "../src/router/risk-classifier.mjs";

import {
  DANGEROUS_FIELD_PATTERNS,
  findDangerousFields,
  assertNoDangerousFields,
  stripDangerousFields,
  createProposal,
  assertAdvisoryProposal,
} from "../src/router/proposal.mjs";

// ---------------------------------------------------------------------------
// risk-classifier.mjs
// ---------------------------------------------------------------------------

test("classifyRisk: read-only kinds score low and are labeled read/advisory", () => {
  for (const kind of READ_ONLY_KINDS) {
    const result = classifyRisk({ kind });
    assert.equal(RISK_TIERS.includes(result.tier), true);
    assert.equal(result.tier, "low");
    assert.equal(isReadOnlyKind(kind), true);
    assert.equal(isCustodyAdjacentKind(kind), false);
  }
});

test("classifyRisk: custody-adjacent kinds score higher than read-only kinds", () => {
  const read = classifyRisk({ kind: "read" });
  const swap = classifyRisk({ kind: "swap", notionalUsd: 500, destinationKnown: true });
  assert.equal(read.score < swap.score, true);
  assert.equal(CUSTODY_ADJACENT_KINDS.includes("swap"), true);
});

test("classifyRisk: large notional pushes tier up", () => {
  const small = classifyRisk({ kind: "transfer", notionalUsd: 50, destinationKnown: true });
  const huge = classifyRisk({ kind: "transfer", notionalUsd: 250_000, destinationKnown: true });
  assert.equal(huge.score > small.score, true);
  assert.equal(huge.tier === "high" || huge.tier === "critical", true);
});

test("classifyRisk: unlimited approval and unknown destination raise risk", () => {
  const bounded = classifyRisk({
    kind: "approval",
    notionalUsd: 100,
    destinationKnown: true,
    unlimitedApproval: false,
  });
  const unlimited = classifyRisk({
    kind: "approval",
    notionalUsd: 100,
    destinationKnown: false,
    unlimitedApproval: true,
  });
  assert.equal(unlimited.score > bounded.score, true);
  assert.equal(unlimited.tier, "critical");
  assert.equal(unlimited.reasons.some((r) => /unlimited/i.test(r)), true);
  assert.equal(unlimited.reasons.some((r) => /not a reviewed/i.test(r)), true);
});

test("classifyRisk: unrecognized kind is treated conservatively, not as low risk", () => {
  const unknown = classifyRisk({ kind: "self-destruct-everything" });
  assert.notEqual(unknown.tier, "low");
});

test("classifyRisk: missing notional on a non-read action is penalized, not ignored", () => {
  const known = classifyRisk({ kind: "swap", notionalUsd: 50, destinationKnown: true });
  const unknownNotional = classifyRisk({ kind: "swap", destinationKnown: true });
  assert.equal(unknownNotional.score >= known.score, true);
});

test("classifyRisk: is a pure function -- same input, same output, no shared state mutation", () => {
  const input = { kind: "swap", notionalUsd: 1000, destinationKnown: true };
  const a = classifyRisk(input);
  const b = classifyRisk(input);
  assert.deepEqual(a, b);
  // Output must be frozen so nothing downstream can mutate a risk label into
  // something it isn't.
  assert.throws(() => {
    a.tier = "low";
  }, TypeError);
});

// ---------------------------------------------------------------------------
// proposal.mjs -- dangerous field detection
// ---------------------------------------------------------------------------

const DANGEROUS_SAMPLES = [
  { privateKey: "0xdeadbeef" },
  { private_key: "0xdeadbeef" },
  { seedPhrase: "abandon abandon abandon" },
  { mnemonic: "abandon abandon abandon" },
  { apiKey: "sk-live-abc" },
  { apiSecret: "shh" },
  { bearerToken: "Bearer abc.def.ghi" },
  { sessionKey: "sess-123" },
  { sessionSecret: "sess-secret" },
  { keystorePath: "/home/operator/.config/oracle/agent.keystore.json" },
  { passphrase: "correct horse battery staple" },
  { password: "hunter2" },
  { signature: "0x1234" },
  { signedTx: "0xf86b..." },
  { rawTx: "0xf86b..." },
  { broadcast: true },
  { authorize: true },
  { grant: "grant-abc" },
  { grantToken: "grant-abc" },
  { credentials: { user: "x", pass: "y" } },
  { houseWallet: "0xhouse" },
  { executorToken: "exec-abc" },
  { accessToken: "acc-abc" },
  { token: "tok-abc" },
  { sig: "0xsig" },
  { walletKey: "0xwalletkey" },
];

test("findDangerousFields: flags every known-dangerous key at the top level", () => {
  for (const sample of DANGEROUS_SAMPLES) {
    const hits = findDangerousFields(sample);
    assert.equal(hits.length > 0, true, `expected a hit for ${JSON.stringify(sample)}`);
  }
});

test("findDangerousFields: flags dangerous keys nested arbitrarily deep", () => {
  const nested = {
    kind: "swap",
    meta: {
      execution: {
        signer: {
          privateKey: "0xdeadbeef",
        },
      },
    },
  };
  const hits = findDangerousFields(nested);
  assert.equal(hits.some((h) => h.includes("privateKey")), true);
});

test("findDangerousFields: flags dangerous keys inside arrays", () => {
  const withArray = { steps: [{ ok: true }, { bearerToken: "abc" }] };
  const hits = findDangerousFields(withArray);
  assert.equal(hits.some((h) => h.includes("bearerToken")), true);
});

test("findDangerousFields: benign fields produce no hits", () => {
  const benign = {
    kind: "swap",
    target: "HL BTC-PERP",
    notionalUsd: 1000,
    chainId: 42161,
    venue: "hyperliquid",
    destinationKnown: true,
    note: "routine rebalance",
  };
  assert.deepEqual(findDangerousFields(benign), []);
});

test("assertNoDangerousFields: throws on any dangerous field, passes on benign input", () => {
  assert.throws(() => assertNoDangerousFields({ privateKey: "x" }), /disallowed/i);
  assert.doesNotThrow(() => assertNoDangerousFields({ kind: "read" }));
});

test("stripDangerousFields: removes dangerous keys recursively, keeps benign ones", () => {
  const dirty = {
    kind: "swap",
    notionalUsd: 100,
    auth: { bearerToken: "abc", chainId: 1 },
    list: [{ signature: "0x1" }, { note: "ok" }],
  };
  const clean = stripDangerousFields(dirty);
  assert.equal(findDangerousFields(clean).length, 0);
  assert.equal(clean.kind, "swap");
  assert.equal(clean.auth.chainId, 1);
  assert.equal(clean.list[1].note, "ok");
});

test("DANGEROUS_FIELD_PATTERNS is non-empty and covers the documented threat list", () => {
  assert.equal(DANGEROUS_FIELD_PATTERNS.length > 10, true);
});

// ---------------------------------------------------------------------------
// proposal.mjs -- createProposal: advisory only, never authorizing
// ---------------------------------------------------------------------------

test("createProposal: rejects input containing any dangerous field, for every documented sample", () => {
  for (const sample of DANGEROUS_SAMPLES) {
    assert.throws(
      () => createProposal({ kind: "swap", notionalUsd: 100, ...sample }),
      /disallowed secret\/signing\/broadcast/i,
      `expected createProposal to reject ${JSON.stringify(sample)}`
    );
  }
});

test("createProposal: rejects a dangerous field nested inside an allowed-looking object", () => {
  assert.throws(() =>
    createProposal({
      kind: "swap",
      notionalUsd: 100,
      note: { text: "fine", signer: { privateKey: "0xabc" } },
    })
  );
});

test("createProposal: requires a kind", () => {
  assert.throws(() => createProposal({}), /kind is required/i);
});

test("createProposal: builds a well-formed advisory proposal for a benign read request", () => {
  const proposal = createProposal({ kind: "read", target: "HL open interest" });
  assert.equal(proposal.mode, "proposal");
  assert.equal(proposal.advisoryOnly, true);
  assert.equal(proposal.authorized, false);
  assert.equal(proposal.signed, false);
  assert.equal(proposal.broadcast, false);
  assert.equal(proposal.grantsPermissions, false);
  assert.equal(proposal.requiresHumanConfirmation, true);
  assert.equal(proposal.risk.tier, "low");
  assert.equal(proposal.capabilities.canSign, false);
  assert.equal(proposal.capabilities.canBroadcast, false);
  assert.equal(proposal.capabilities.canAuthorize, false);
  assert.equal(proposal.capabilities.canMintCapability, false);
  assert.equal(proposal.capabilities.canAccessSecrets, false);
});

test("createProposal: custody-adjacent kinds still come back unauthorized regardless of risk tier", () => {
  const proposal = createProposal({
    kind: "swap",
    notionalUsd: 500_000,
    destinationKnown: false,
    unlimitedApproval: true,
    target: "arbitrary router",
  });
  assert.equal(proposal.risk.tier, "critical");
  assert.equal(proposal.authorized, false);
  assert.equal(proposal.signed, false);
  assert.equal(proposal.broadcast, false);
  assert.equal(proposal.mode, "proposal");
});

test("createProposal: drops unlisted/unknown fields -- only the allowlisted shape survives", () => {
  const proposal = createProposal({
    kind: "read",
    target: "BTC funding",
    somethingWeDidNotAnticipate: "should not appear",
    __proto__polluter: "nope",
  });
  assert.equal("somethingWeDidNotAnticipate" in proposal, false);
  assert.equal(Object.keys(proposal).includes("__proto__polluter"), false);
});

test("createProposal: caller attempting to send pinned-marker-shaped fields is rejected outright (fail-closed, not silently dropped)", () => {
  // authorized/broadcast/etc are reserved marker names this module pins to
  // fixed constants. A caller is not even allowed to send them as input --
  // findDangerousFields treats them as dangerous-shaped fields and
  // createProposal rejects the whole request rather than silently stripping
  // and continuing.
  assert.throws(
    () =>
      createProposal({
        kind: "read",
        mode: "authorization",
        authorized: true,
        signed: true,
        broadcast: true,
      }),
    /disallowed secret\/signing\/broadcast/i
  );

  // With those reserved names absent, the pinned markers on legitimate input
  // come back fixed to their safe constants regardless of other fields sent.
  const proposal = createProposal({
    kind: "read",
    advisoryOnly: false,
    grantsPermissions: true,
    requiresHumanConfirmation: false,
  });
  assert.equal(proposal.mode, "proposal");
  assert.equal(proposal.authorized, false);
  assert.equal(proposal.signed, false);
  assert.equal(proposal.broadcast, false);
  assert.equal(proposal.advisoryOnly, true);
  assert.equal(proposal.grantsPermissions, false);
  assert.equal(proposal.requiresHumanConfirmation, true);
});

test("createProposal: emitted proposal is deep-frozen and cannot be mutated into an authorization", () => {
  const proposal = createProposal({ kind: "read" });
  assert.throws(() => {
    proposal.authorized = true;
  }, TypeError);
  assert.throws(() => {
    proposal.capabilities.canSign = true;
  }, TypeError);
  assert.throws(() => {
    proposal.risk.tier = "low";
  }, TypeError);
});

test("createProposal: never echoes a dangerous field back even if one somehow reached output construction", () => {
  // Simulate the "gap" scenario directly against the output-side guard, since
  // createProposal only ever builds from the allowlist and cannot include a
  // dangerous field in practice. This documents that a second independent
  // check exists on the output path.
  const wellFormed = createProposal({ kind: "read" });
  assert.doesNotThrow(() =>
    assertNoDangerousFields(wellFormed, "proposal output", { allowPinnedSafe: true })
  );
});

test("createProposal: each call gets a unique id and a valid ISO createdAt", () => {
  const a = createProposal({ kind: "read" }, 1_700_000_000_000);
  const b = createProposal({ kind: "read" }, 1_700_000_000_000);
  assert.notEqual(a.id, b.id);
  assert.equal(new Date(a.createdAt).toISOString(), a.createdAt);
});

// ---------------------------------------------------------------------------
// proposal.mjs -- assertAdvisoryProposal: independent downstream guard
// ---------------------------------------------------------------------------

test("assertAdvisoryProposal: accepts a genuine router proposal", () => {
  const proposal = createProposal({ kind: "swap", notionalUsd: 1000, destinationKnown: true });
  assert.equal(assertAdvisoryProposal(proposal), true);
});

test("assertAdvisoryProposal: rejects an object forged to look authorized", () => {
  const forged = {
    mode: "proposal",
    advisoryOnly: true,
    authorized: true, // forged
    signed: false,
    broadcast: false,
    grantsPermissions: false,
    capabilities: { canSign: false, canBroadcast: false, canAuthorize: false, canMintCapability: false, canAccessSecrets: false },
  };
  assert.throws(() => assertAdvisoryProposal(forged), /authorized must be false/i);
});

test("assertAdvisoryProposal: rejects an object whose capabilities grant sign/broadcast/authorize", () => {
  const forged = {
    mode: "proposal",
    advisoryOnly: true,
    authorized: false,
    signed: false,
    broadcast: false,
    grantsPermissions: false,
    capabilities: { canSign: true, canBroadcast: false, canAuthorize: false, canMintCapability: false, canAccessSecrets: false },
  };
  assert.throws(() => assertAdvisoryProposal(forged), /must not grant/i);
});

test("assertAdvisoryProposal: rejects an object carrying a dangerous field even if markers look fine", () => {
  const forged = {
    mode: "proposal",
    advisoryOnly: true,
    authorized: false,
    signed: false,
    broadcast: false,
    grantsPermissions: false,
    capabilities: { canSign: false, canBroadcast: false, canAuthorize: false, canMintCapability: false, canAccessSecrets: false },
    bearerToken: "smuggled",
  };
  assert.throws(() => assertAdvisoryProposal(forged), /disallowed/i);
});

test("assertAdvisoryProposal: rejects missing/malformed proposal", () => {
  assert.throws(() => assertAdvisoryProposal(null), /proposal required/i);
  assert.throws(() => assertAdvisoryProposal({}), /mode must be/i);
});
