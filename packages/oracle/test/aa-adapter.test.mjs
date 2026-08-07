import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, keccak256, stringToHex } from "viem";

import {
  PROVIDERS,
  createSessionGrant,
  createRevocationRegistry,
  canonicalJson,
} from "../src/public-control/session-key-model.mjs";

import {
  ENTRYPOINT_V07,
  ENTRYPOINT_ABI,
  DEFAULT_SESSION_MODULE_ABI,
  encodeSessionKeyInstall,
  revokeSessionKey,
  buildUserOperation,
} from "../src/public-control/aa-adapter.mjs";

const OWNER = "0x1111111111111111111111111111111111111111";
const AGENT = "0x2222222222222222222222222222222222222222";
const TARGET = "0x3333333333333333333333333333333333333333";
const MODULE = "0x5555555555555555555555555555555555555555";
const SENDER = OWNER; // smart account address for userOp assembly in these tests
const NOW = 1_700_000_000_000;

function baseGrant(overrides = {}) {
  return createSessionGrant({
    provider: PROVIDERS.PERMISSIONLESS_VIEM,
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
// encodeSessionKeyInstall
// ---------------------------------------------------------------------------

test("encodeSessionKeyInstall is deterministic for fixed inputs", () => {
  const g = baseGrant();
  const a = encodeSessionKeyInstall(g, { moduleAddress: MODULE, nowMs: NOW + 1 });
  const b = encodeSessionKeyInstall(g, { moduleAddress: MODULE, nowMs: NOW + 1 });
  assert.deepEqual(a, b);
  assert.equal(a.to, MODULE);
  assert.match(a.data, /^0x[0-9a-f]+$/);
  assert.equal(a.value, "0x0");
});

test("encodeSessionKeyInstall output matches manual encodeFunctionData for the same grant (full field recomputation)", () => {
  const g = baseGrant();
  const out = encodeSessionKeyInstall(g, { moduleAddress: MODULE, nowMs: NOW + 1 });
  const actionsHash = keccak256(stringToHex(canonicalJson(g.actions)));
  const expected = encodeFunctionData({
    abi: DEFAULT_SESSION_MODULE_ABI,
    functionName: "installSessionKey",
    args: [
      g.id,
      AGENT,
      BigInt(Math.floor(g.issuedAtMs / 1000)),
      BigInt(Math.floor(g.expiresAtMs / 1000)),
      actionsHash,
      [TARGET],
      BigInt(g.maxValueWei),
      0n, // grant has no maxGasWei -> encoded as 0
    ],
  });
  assert.equal(out.data, expected);
});

test("encodeSessionKeyInstall differs when session id (grant identity) differs", () => {
  const g1 = baseGrant({ nonce: 1 });
  const g2 = baseGrant({ nonce: 2 });
  const a = encodeSessionKeyInstall(g1, { moduleAddress: MODULE, nowMs: NOW + 1 });
  const b = encodeSessionKeyInstall(g2, { moduleAddress: MODULE, nowMs: NOW + 1 });
  assert.notEqual(a.data, b.data);
});

test("encodeSessionKeyInstall requires moduleAddress", () => {
  const g = baseGrant();
  assert.throws(() => encodeSessionKeyInstall(g, { nowMs: NOW + 1 }), /moduleAddress is required/);
  assert.throws(() => encodeSessionKeyInstall(g, { moduleAddress: "not-an-address", nowMs: NOW + 1 }), /moduleAddress is required/);
});

test("encodeSessionKeyInstall refuses an expired grant before encoding (out-of-policy, fail-closed)", () => {
  const g = baseGrant();
  assert.throws(
    () => encodeSessionKeyInstall(g, { moduleAddress: MODULE, nowMs: g.expiresAtMs + 1 }),
    /refusing to encode calldata for a expired session/
  );
});

test("encodeSessionKeyInstall refuses a revoked grant before encoding (out-of-policy, fail-closed)", () => {
  const g = baseGrant();
  const registry = createRevocationRegistry();
  registry.revoke(g.id, { nowMs: NOW + 5 });
  assert.throws(
    () => encodeSessionKeyInstall(g, { moduleAddress: MODULE, nowMs: NOW + 10, revocation: registry }),
    /refusing to encode calldata for a revoked session/
  );
});

test("encodeSessionKeyInstall refuses a tampered grant-shaped object (id/field mismatch)", () => {
  const g = baseGrant();
  const tampered = { ...g, maxValueWei: "999999999999" }; // id no longer matches fields
  assert.throws(
    () => encodeSessionKeyInstall(tampered, { moduleAddress: MODULE, nowMs: NOW + 1 }),
    /grant integrity check failed/
  );
});

test("encodeSessionKeyInstall refuses a non-grant object", () => {
  assert.throws(
    () => encodeSessionKeyInstall({ not: "a grant" }, { moduleAddress: MODULE, nowMs: NOW + 1 }),
    /not a valid session-key-model grant/
  );
});

// ---------------------------------------------------------------------------
// revokeSessionKey
// ---------------------------------------------------------------------------

test("revokeSessionKey produces the expected revocation calldata (from a grant object)", () => {
  const g = baseGrant();
  const out = revokeSessionKey(g, { moduleAddress: MODULE });
  const expected = encodeFunctionData({
    abi: DEFAULT_SESSION_MODULE_ABI,
    functionName: "revokeSessionKey",
    args: [g.id],
  });
  assert.equal(out.data, expected);
  assert.equal(out.to, MODULE);
  assert.equal(out.value, "0x0");
});

test("revokeSessionKey produces identical calldata from a raw session id string", () => {
  const g = baseGrant();
  const fromGrant = revokeSessionKey(g, { moduleAddress: MODULE });
  const fromId = revokeSessionKey(g.id, { moduleAddress: MODULE });
  assert.deepEqual(fromGrant, fromId);
});

test("revokeSessionKey is deterministic for fixed inputs", () => {
  const g = baseGrant();
  const a = revokeSessionKey(g, { moduleAddress: MODULE });
  const b = revokeSessionKey(g, { moduleAddress: MODULE });
  assert.deepEqual(a, b);
});

test("revokeSessionKey allows an already-expired grant (idempotent revoke, unlike install)", () => {
  const g = baseGrant();
  assert.doesNotThrow(() => revokeSessionKey(g, { moduleAddress: MODULE }));
});

test("revokeSessionKey rejects a malformed session id", () => {
  assert.throws(() => revokeSessionKey("0xdead", { moduleAddress: MODULE }), /32-byte hash/);
});

test("revokeSessionKey requires moduleAddress", () => {
  const g = baseGrant();
  assert.throws(() => revokeSessionKey(g, {}), /moduleAddress is required/);
});

// ---------------------------------------------------------------------------
// buildUserOperation
// ---------------------------------------------------------------------------

const FIXED_GAS = {
  callGasLimit: 100_000n,
  verificationGasLimit: 150_000n,
  preVerificationGas: 50_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
};

test("buildUserOperation assembles a deterministic unsigned userOp for fixed inputs (explicit nonce)", async () => {
  const g = baseGrant();
  const callData = encodeSessionKeyInstall(g, { moduleAddress: MODULE, nowMs: NOW + 1 }).data;

  const a = await buildUserOperation({ sender: SENDER, callData, nonce: 7n, ...FIXED_GAS });
  const b = await buildUserOperation({ sender: SENDER, callData, nonce: 7n, ...FIXED_GAS });
  assert.deepEqual(a, b);
  assert.equal(a.sender, SENDER);
  assert.equal(a.callData, callData);
  assert.equal(a.nonce, "0x7");
});

test("buildUserOperation has no signature and no secret/key material", async () => {
  const callData = "0xdeadbeef";
  const userOp = await buildUserOperation({ sender: SENDER, callData, nonce: 0n, ...FIXED_GAS });

  assert.equal(userOp.signature, "0x");
  const json = JSON.stringify(userOp);
  for (const forbidden of ["privateKey", "private_key", "secret", "mnemonic", "keystore", "bearer"]) {
    assert.doesNotMatch(json.toLowerCase(), new RegExp(forbidden.toLowerCase()));
  }
  assert.deepEqual(Object.keys(userOp).sort(), [
    "callData",
    "callGasLimit",
    "factory",
    "factoryData",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "nonce",
    "paymaster",
    "paymasterData",
    "paymasterPostOpGasLimit",
    "paymasterVerificationGasLimit",
    "preVerificationGas",
    "sender",
    "signature",
    "verificationGasLimit",
  ]);
});

test("buildUserOperation fetches nonce via an injected client — NO live network call", async () => {
  let calls = 0;
  const mockClient = {
    async readContract({ address, abi, functionName, args }) {
      calls += 1;
      assert.equal(address, ENTRYPOINT_V07);
      assert.equal(functionName, "getNonce");
      assert.deepEqual(args, [SENDER, 0n]);
      assert.equal(abi, ENTRYPOINT_ABI);
      return 42n; // fully mocked — no fetch/http happens
    },
  };
  const userOp = await buildUserOperation({ client: mockClient, sender: SENDER, callData: "0x1234", ...FIXED_GAS });
  assert.equal(calls, 1);
  assert.equal(userOp.nonce, "0x2a");
});

test("buildUserOperation throws when nonce is omitted and no client is provided", async () => {
  await assert.rejects(
    () => buildUserOperation({ sender: SENDER, callData: "0x1234", ...FIXED_GAS }),
    /no usable client was provided/
  );
});

test("buildUserOperation requires every gas/fee field explicitly (never estimates)", async () => {
  await assert.rejects(
    () => buildUserOperation({ sender: SENDER, callData: "0x1234", nonce: 0n }),
    /callGasLimit is required/
  );
});

test("buildUserOperation rejects an invalid sender/callData", async () => {
  await assert.rejects(
    () => buildUserOperation({ sender: "not-an-address", callData: "0x1234", nonce: 0n, ...FIXED_GAS }),
    /sender must be a valid 0x address/
  );
  await assert.rejects(
    () => buildUserOperation({ sender: SENDER, callData: "not-hex", nonce: 0n, ...FIXED_GAS }),
    /callData must be 0x-prefixed hex/
  );
});

test("buildUserOperation supports counterfactual deploy (factory + factoryData) or neither, not one alone", async () => {
  const withFactory = await buildUserOperation({
    sender: SENDER,
    callData: "0x1234",
    nonce: 0n,
    factory: MODULE,
    factoryData: "0xabcdef",
    ...FIXED_GAS,
  });
  assert.equal(withFactory.factory, MODULE);
  assert.equal(withFactory.factoryData, "0xabcdef");

  await assert.rejects(
    () => buildUserOperation({ sender: SENDER, callData: "0x1234", nonce: 0n, factory: MODULE, ...FIXED_GAS }),
    /factory and factoryData must both be set/
  );
});

test("buildUserOperation supports an optional paymaster block, all-or-nothing on its gas fields", async () => {
  const withPaymaster = await buildUserOperation({
    sender: SENDER,
    callData: "0x1234",
    nonce: 0n,
    paymaster: MODULE,
    paymasterVerificationGasLimit: 10_000n,
    paymasterPostOpGasLimit: 5_000n,
    paymasterData: "0xaa",
    ...FIXED_GAS,
  });
  assert.equal(withPaymaster.paymaster, MODULE);
  assert.equal(withPaymaster.paymasterVerificationGasLimit, "0x2710");
  assert.equal(withPaymaster.paymasterPostOpGasLimit, "0x1388");

  await assert.rejects(
    () => buildUserOperation({ sender: SENDER, callData: "0x1234", nonce: 0n, paymaster: MODULE, ...FIXED_GAS }),
    /paymasterVerificationGasLimit and paymasterPostOpGasLimit are required/
  );
});

test("buildUserOperation output is frozen (defensive against downstream mutation before signing)", async () => {
  const userOp = await buildUserOperation({ sender: SENDER, callData: "0x1234", nonce: 0n, ...FIXED_GAS });
  assert.ok(Object.isFrozen(userOp));
});

// ---------------------------------------------------------------------------
// end-to-end: grant -> install calldata -> unsigned userOp, all in one flow
// ---------------------------------------------------------------------------

test("end-to-end: an out-of-policy grant never reaches buildUserOperation because encoding refuses first", () => {
  const g = baseGrant();
  const registry = createRevocationRegistry();
  registry.revoke(g.id, { nowMs: NOW + 1 });
  assert.throws(() => encodeSessionKeyInstall(g, { moduleAddress: MODULE, nowMs: NOW + 2, revocation: registry }));
  // (No buildUserOperation call follows — there is no calldata to wrap.)
});

test("end-to-end: valid grant -> install calldata -> unsigned userOp round-trips deterministically", async () => {
  const g = baseGrant();
  const install = encodeSessionKeyInstall(g, { moduleAddress: MODULE, nowMs: NOW + 1 });
  const userOp1 = await buildUserOperation({ sender: OWNER, callData: install.data, nonce: 3n, ...FIXED_GAS });
  const userOp2 = await buildUserOperation({ sender: OWNER, callData: install.data, nonce: 3n, ...FIXED_GAS });
  assert.deepEqual(userOp1, userOp2);
  assert.equal(userOp1.callData, install.data);
  assert.equal(userOp1.signature, "0x");
});
