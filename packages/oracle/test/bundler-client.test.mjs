import { test } from "node:test";
import assert from "node:assert/strict";

import { ENTRYPOINT_V07 } from "../src/public-control/aa-adapter.mjs";

import {
  SecretLeakError,
  assertNoSecretPayload,
  submitUserOperation,
  estimateAndFill,
  applyPaymaster,
  waitForReceipt,
} from "../src/public-control/bundler-client.mjs";

const SENDER = "0x1111111111111111111111111111111111111111";
const WRONG_ENTRYPOINT = "0x9999999999999999999999999999999999999999";
const PAYMASTER = "0x4444444444444444444444444444444444444444";

const FIXED_GAS = {
  callGasLimit: "0x186a0",
  verificationGasLimit: "0x249f0",
  preVerificationGas: "0xc350",
  maxFeePerGas: "0x77359400",
  maxPriorityFeePerGas: "0x3b9aca00",
};

function baseUserOp(overrides = {}) {
  return {
    sender: SENDER,
    nonce: "0x7",
    factory: null,
    factoryData: null,
    callData: "0xdeadbeef",
    ...FIXED_GAS,
    paymaster: null,
    paymasterVerificationGasLimit: null,
    paymasterPostOpGasLimit: null,
    paymasterData: null,
    signature: "0x",
    ...overrides,
  };
}

// A real ECDSA signature is 65 bytes (r:32 + s:32 + v:1 = 130 hex chars).
// Using a realistic length here (not 32 bytes) also keeps this fixture out
// of the raw-32-byte-hex-key secret-shape rule, which is intentionally
// tuned to catch a bare private key, not a real signature.
const REALISTIC_SIGNATURE =
  "0x" + "aa".repeat(32) + "bb".repeat(32) + "1c";

function signedUserOp(overrides = {}) {
  return baseUserOp({ signature: REALISTIC_SIGNATURE, ...overrides });
}

// ---------------------------------------------------------------------------
// mock client factory
// ---------------------------------------------------------------------------

function mockBundlerClient(overrides = {}) {
  const calls = { sendUserOperation: [], waitForUserOperationReceipt: [], estimateUserOperationGas: [] };
  const client = {
    async sendUserOperation(args) {
      calls.sendUserOperation.push(args);
      return overrides.sendUserOperationResult ?? "0xaaaa000000000000000000000000000000000000000000000000000000000000";
    },
    async waitForUserOperationReceipt(args) {
      calls.waitForUserOperationReceipt.push(args);
      return overrides.receiptResult ?? { success: true, userOpHash: args.hash };
    },
    async estimateUserOperationGas(args) {
      calls.estimateUserOperationGas.push(args);
      return (
        overrides.estimateResult ?? {
          callGasLimit: 200_000n,
          verificationGasLimit: 300_000n,
          preVerificationGas: 60_000n,
        }
      );
    },
  };
  return { client, calls };
}

function mockPaymasterClient(overrides = {}) {
  const calls = { getPaymasterData: [] };
  const client = {
    async getPaymasterData(args) {
      calls.getPaymasterData.push(args);
      return (
        overrides.result ?? {
          paymaster: PAYMASTER,
          paymasterData: "0xfeed",
          paymasterVerificationGasLimit: 10_000n,
          paymasterPostOpGasLimit: 5_000n,
        }
      );
    },
  };
  return { client, calls };
}

// ---------------------------------------------------------------------------
// submitUserOperation
// ---------------------------------------------------------------------------

test("submitUserOperation always refuses (prepare-only wall)", async () => {
  const userOp = {
    sender: "0x1111111111111111111111111111111111111111",
    nonce: "0x0",
    callData: "0x",
    callGasLimit: "0x1",
    verificationGasLimit: "0x1",
    preVerificationGas: "0x1",
    maxFeePerGas: "0x1",
    maxPriorityFeePerGas: "0x1",
    signature: "0x" + "ab".repeat(65),
  };
  let called = 0;
  const client = { sendUserOperation: async () => { called++; return "0x" + "11".repeat(32); } };
  await assert.rejects(() => submitUserOperation({ userOp, bundlerClient: client }), /prepare-only|refused/);
  await assert.rejects(
    () => submitUserOperation({ userOp, bundlerClient: client, entryPoint: ENTRYPOINT_V07 }),
    /prepare-only|refused/
  );
  assert.equal(called, 0);
});

test("estimateAndFill fills gas fields from the injected client and preserves other fields", async () => {
  const { client, calls } = mockBundlerClient();
  const userOp = baseUserOp();
  const filled = await estimateAndFill({ userOp, bundlerClient: client });

  assert.equal(calls.estimateUserOperationGas.length, 1);
  assert.equal(calls.estimateUserOperationGas[0].entryPoint, ENTRYPOINT_V07);
  assert.equal(filled.callGasLimit, "0x30d40"); // 200_000n
  assert.equal(filled.verificationGasLimit, "0x493e0"); // 300_000n
  assert.equal(filled.preVerificationGas, "0xea60"); // 60_000n
  assert.equal(filled.sender, SENDER);
  assert.equal(filled.signature, "0x"); // still unsigned — estimateAndFill never signs
});

test("estimateAndFill does not require a signature (runs pre-signature)", async () => {
  const { client } = mockBundlerClient();
  const userOp = baseUserOp({ signature: "0x" });
  await assert.doesNotReject(() => estimateAndFill({ userOp, bundlerClient: client }));
});

test("estimateAndFill requires a bundlerClient exposing estimateUserOperationGas", async () => {
  const userOp = baseUserOp();
  await assert.rejects(
    () => estimateAndFill({ userOp, bundlerClient: {} }),
    /must expose an async estimateUserOperationGas/
  );
});

test("estimateAndFill falls back to input gas fields when the client omits one", async () => {
  const { client } = mockBundlerClient({ estimateResult: { callGasLimit: 999n } });
  const userOp = baseUserOp();
  const filled = await estimateAndFill({ userOp, bundlerClient: client });
  assert.equal(filled.callGasLimit, "0x3e7"); // 999n
  assert.equal(filled.verificationGasLimit, FIXED_GAS.verificationGasLimit);
  assert.equal(filled.preVerificationGas, FIXED_GAS.preVerificationGas);
});

// ---------------------------------------------------------------------------
// applyPaymaster
// ---------------------------------------------------------------------------

test("applyPaymaster with no paymasterClient returns the explicit self-funded path", async () => {
  const userOp = baseUserOp();
  const out = await applyPaymaster({ userOp });
  assert.equal(out.paymaster, null);
  assert.equal(out.paymasterData, null);
  assert.equal(out.paymasterVerificationGasLimit, null);
  assert.equal(out.paymasterPostOpGasLimit, null);
});

test("applyPaymaster calls the injected paymasterClient with expected args and fills fields", async () => {
  const { client, calls } = mockPaymasterClient();
  const userOp = baseUserOp();
  const out = await applyPaymaster({ userOp, paymasterClient: client });

  assert.equal(calls.getPaymasterData.length, 1);
  assert.equal(calls.getPaymasterData[0].entryPoint, ENTRYPOINT_V07);
  assert.equal(calls.getPaymasterData[0].userOperation.sender, SENDER);
  assert.equal(out.paymaster, PAYMASTER);
  assert.equal(out.paymasterData, "0xfeed");
  assert.equal(out.paymasterVerificationGasLimit, "0x2710"); // 10_000n
  assert.equal(out.paymasterPostOpGasLimit, "0x1388"); // 5_000n
});

test("applyPaymaster rejects a paymasterClient that returns an invalid paymaster address", async () => {
  const { client } = mockPaymasterClient({ result: { paymaster: "not-an-address" } });
  const userOp = baseUserOp();
  await assert.rejects(
    () => applyPaymaster({ userOp, paymasterClient: client }),
    /must resolve to an object with a valid paymaster address/
  );
});

test("applyPaymaster never holds/requests any credential — output carries no secret-shaped keys", async () => {
  const { client } = mockPaymasterClient();
  const userOp = baseUserOp();
  const out = await applyPaymaster({ userOp, paymasterClient: client });
  assert.doesNotThrow(() => assertNoSecretPayload(out));
});

// ---------------------------------------------------------------------------
// waitForReceipt
// ---------------------------------------------------------------------------

test("waitForReceipt passes through to the injected client and returns its result", async () => {
  const { client, calls } = mockBundlerClient();
  const hash = "0xaaaa000000000000000000000000000000000000000000000000000000000000";
  const receipt = await waitForReceipt({ hash, bundlerClient: client });

  assert.equal(calls.waitForUserOperationReceipt.length, 1);
  assert.equal(calls.waitForUserOperationReceipt[0].hash, hash);
  assert.deepEqual(receipt, { success: true, userOpHash: hash });
});

test("waitForReceipt forwards extra opts (e.g. pollingInterval) untouched", async () => {
  const { client, calls } = mockBundlerClient();
  const hash = "0xbbbb000000000000000000000000000000000000000000000000000000000000";
  await waitForReceipt({ hash, bundlerClient: client, opts: { pollingInterval: 500, timeout: 60_000 } });
  assert.equal(calls.waitForUserOperationReceipt[0].pollingInterval, 500);
  assert.equal(calls.waitForUserOperationReceipt[0].timeout, 60_000);
});

test("waitForReceipt requires a valid hex hash", async () => {
  const { client } = mockBundlerClient();
  await assert.rejects(
    () => waitForReceipt({ hash: "not-a-hash", bundlerClient: client }),
    /must be 0x-prefixed hex/
  );
});

test("waitForReceipt requires a bundlerClient exposing waitForUserOperationReceipt", async () => {
  const hash = "0xaaaa000000000000000000000000000000000000000000000000000000000000";
  await assert.rejects(
    () => waitForReceipt({ hash, bundlerClient: {} }),
    /must expose an async waitForUserOperationReceipt/
  );
});

// ---------------------------------------------------------------------------
// end-to-end: no secret/key ever appears in the submitted payload
// ---------------------------------------------------------------------------

test("no secret/key material path: submitUserOperation refuses before any client call", async () => {
  let called = 0;
  const client = {
    sendUserOperation: async (args) => {
      called++;
      return "0x" + "11".repeat(32);
    },
  };
  const userOp = {
    sender: "0x1111111111111111111111111111111111111111",
    nonce: "0x0",
    callData: "0x",
    callGasLimit: "0x1",
    verificationGasLimit: "0x1",
    preVerificationGas: "0x1",
    maxFeePerGas: "0x1",
    maxPriorityFeePerGas: "0x1",
    signature: "0x" + "ab".repeat(65),
    privateKey: "0x" + "11".repeat(32), // poison field must never be sent
  };
  await assert.rejects(() => submitUserOperation({ userOp, bundlerClient: client }), /prepare-only|refused/);
  assert.equal(called, 0);
});


test("assertNoSecretPayload throws SecretLeakError on a forbidden key name", () => {
  assert.throws(() => assertNoSecretPayload({ privateKey: "0xabc" }), SecretLeakError);
});

test("assertNoSecretPayload throws SecretLeakError on a raw 32-byte-hex value even under a benign key", () => {
  const rawKeyShaped = "0x" + "ab".repeat(32);
  assert.throws(() => assertNoSecretPayload({ someField: rawKeyShaped }), SecretLeakError);
});

test("assertNoSecretPayload does NOT flag a signed userOp's signature field (public, submittable)", () => {
  const userOp = signedUserOp();
  assert.doesNotThrow(() => assertNoSecretPayload(userOp));
});
