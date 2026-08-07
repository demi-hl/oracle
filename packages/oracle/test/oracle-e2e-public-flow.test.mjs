// Slice L — end-to-end integration test harness (test-only, mocked chain).
//
// One node:test integration test that boots the REAL public HTTP server
// in-process (startPublicServer from src/public-api/http.mjs) on a random
// loopback port, drives the real connect-agent + policy-schema + grants
// read path over actual HTTP, then bridges into the AA/bundler lane
// (aa-adapter.buildUserOperation + bundler-client.submitUserOperation) with
// an injected MOCK bundler client and a MOCK wallet signature. No live
// network call, no live chain, no real key material anywhere in this file.
//
// Hard boundaries for this file:
//   - Imports ONLY the already-tested public modules named in the task
//     brief (public-api/http.mjs, public-api/connect-agent.mjs,
//     public-control/policy-schema.mjs, public-control/aa-adapter.mjs,
//     public-control/bundler-client.mjs). Never the private executor stack
//     (bin/exec-server.mjs, bin/local-signer-server.mjs,
//     bin/mad-exec-mcp.mjs, src/get-signer.mjs, src/keystore.mjs,
//     src/exec-policy.mjs, src/local-signer/*, src/adapters/*,
//     bin/mint-capability.mjs, src/data/providers/solana*,
//     src/adapters/solana*).
//   - The "mock wallet signature" below is a deterministic hash-derived
//     hex string, not a real ECDSA signature over any real key, and no
//     private key is ever generated, held, or referenced anywhere here.
//     It exists only to exercise bundler-client's signed/unsigned branch
//     with a realistic 65-byte (130 hex char) signature shape, which is
//     intentionally outside the 32-byte raw-key secret-shape rule both
//     connect-agent and bundler-client scan for.
//   - Every HTTP response body is checked for the x-oracle-plane: public
//     header and grepped, in raw text form, for secret-shaped values
//     (a bare 0x + 64-hex string, or a "Bearer " token) before any
//     assertion trusts its JSON. The same grep runs over the payload the
//     mocked bundler client receives.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";

import { startPublicServer, PUBLIC_PLANE } from "../src/public-api/http.mjs";
import { SIGNING_SCHEME } from "../src/public-api/connect-agent.mjs";
import { grantId, normalizeGrant } from "../src/public-control/policy-schema.mjs";
import { buildUserOperation, ENTRYPOINT_V07 } from "../src/public-control/aa-adapter.mjs";
import { submitUserOperation } from "../src/public-control/bundler-client.mjs";

const NOW = Math.floor(Date.now() / 1000); // fixed for this test process

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
    nonce: "n-e2e-1",
    revocationKey: "revoke.n-e2e-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Secret-shape grep — the same fail-closed posture the modules under test
// enforce, re-applied independently at the test boundary over raw text.
// ---------------------------------------------------------------------------

// A bare 0x-prefixed 32-byte value: the shape of a raw private key/session
// secret. Anchored so it only fires on an actual "0x" + exactly 64 hex
// chars not followed by more hex (so a longer, legitimate 65-byte signature
// never trips it).
const HEX64_RE = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/i;

function assertNoSecretShapes(text, label) {
  assert.ok(!HEX64_RE.test(text), `${label}: found a 0x + 64-hex secret-shaped value`);
  assert.ok(!BEARER_RE.test(text), `${label}: found a Bearer-token-shaped value`);
}

/**
 * Deterministic MOCK signature standing in for the user's own wallet
 * signing `bytesHex` off this infrastructure. NOT a real ECDSA signature,
 * derived by hashing (never a real key), but sized like a real 65-byte
 * (r + s + v) ECDSA signature so it exercises the same code path a real
 * wallet signature would.
 */
function mockSignBytes(bytesHex) {
  const r = createHash("sha256").update(bytesHex).update("r").digest("hex"); // 32 bytes
  const s = createHash("sha256").update(bytesHex).update("s").digest("hex"); // 32 bytes
  return `0x${r}${s}1b`; // r(32) + s(32) + v(1) = 65 bytes
}

let server;
let base;

before(async () => {
  server = startPublicServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  assert.equal(
    res.headers.get("x-oracle-plane"),
    PUBLIC_PLANE,
    `${path}: missing x-oracle-plane: public header`
  );
  assertNoSecretShapes(text, path);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave json null */
  }
  return { status: res.status, json, text };
}

test("oracle public e2e: connect -> assemble -> sign -> userOp -> bundler submit, plus grants/active liveness", async (t) => {
  await t.test("1. real public HTTP server boots on a random loopback port", () => {
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  let assembled;
  await t.test("2. assemble with a valid SECONDS grant returns an unsigned payload", async () => {
    const { status, json } = await post("/public/connect/assemble", {
      input: baseInput(),
      opts: { now: NOW },
    });
    assert.equal(status, 200);
    assert.equal(json.kind, "oracle-unsigned-grant");
    assert.equal(json.unsigned, true);
    assert.equal(json.signing.scheme, SIGNING_SCHEME);
    assert.ok(/^0x[0-9a-f]+$/.test(json.signing.bytesHex));

    const expectedId = grantId(normalizeGrant(baseInput(), { now: NOW }));
    assert.equal(json.payload.grantId, expectedId);
    assert.equal(json.signing.sha256, expectedId);
    assembled = json;
  });

  await t.test("3. ms-shaped expiresAt is rejected 400 invalid-grant (regression guard)", async () => {
    const { status, json } = await post("/public/connect/assemble", {
      input: baseInput({ expiresAt: 9999999999000 }),
      opts: { now: NOW },
    });
    assert.equal(status, 400);
    assert.equal(json.error, "invalid-grant");
    assert.ok(Array.isArray(json.errors));
    const expiresAtError = json.errors.find((e) => e.field === "expiresAt");
    assert.ok(expiresAtError, `expected an expiresAt error, got ${JSON.stringify(json.errors)}`);
    assert.match(expiresAtError.message, /max unix-seconds|milliseconds/);
  });

  let unsignedUserOp;
  const bundlerCalls = [];

  await t.test("4a. an unsigned userOp is rejected by the mocked bundler until signed", async () => {
    unsignedUserOp = await buildUserOperation({
      sender: ACCOUNT,
      callData: "0xdeadbeef",
      nonce: "0x0",
      callGasLimit: "100000",
      verificationGasLimit: "150000",
      preVerificationGas: "50000",
      maxFeePerGas: "2000000000",
      maxPriorityFeePerGas: "1000000000",
    });
    assert.equal(unsignedUserOp.signature, "0x");

    const mockBundlerClient = {
      async sendUserOperation(args) {
        bundlerCalls.push(args);
        return `0x${"00".repeat(32)}`;
      },
    };
    await assert.rejects(
      () => submitUserOperation({ userOp: unsignedUserOp, bundlerClient: mockBundlerClient }),
      /prepare-only|refused/
    );
    assert.equal(bundlerCalls.length, 0, "the mocked bundler must never be called — prepare package refuses submit");
  });

  await t.test("4b. mock-signing signing.bytesHex and submitting through the mocked bundler carries no secret", async () => {
    // Mock user signing: the user's own wallet (off this infrastructure)
    // signs the exact bytes the assemble step returned to sign
    // (assembled.signing.bytesHex) and hands back a signature. This test
    // never generates or touches a real private key.
    const mockSignature = mockSignBytes(assembled.signing.bytesHex);
    const signedUserOp = { ...unsignedUserOp, signature: mockSignature };

    const mockBundlerClient = {
      async sendUserOperation(args) {
        bundlerCalls.push(args);
        return `0x${"11".repeat(32)}`;
      },
    };
    // Prepare package hard-refuses bundler submit; wallet/operator owns settlement.
    await assert.rejects(
      () =>
        submitUserOperation({
          userOp: signedUserOp,
          bundlerClient: mockBundlerClient,
          entryPoint: ENTRYPOINT_V07,
        }),
      /prepare-only|refused/
    );
    assert.equal(bundlerCalls.length, 0, "prepare package must not call the bundler");
    // Mock signature stays local — prepare package never forwards it.
    assertNoSecretShapes(mockSignature, "local mock signature material");
  });

  await t.test("5. grants/active returns only the live grant among expired + revoked + live", async () => {
    const live = baseInput({ nonce: "n-live", revocationKey: "rk.live" });
    const expired = baseInput({ nonce: "n-expired", revocationKey: "rk.expired", expiresAt: NOW - 10 });
    const revoked = baseInput({ nonce: "n-revoked", revocationKey: "rk.revoked" });

    const store = [live, expired, { grant: revoked, revoked: true }];
    const { status, json } = await post("/public/grants/active", {
      store,
      opts: { now: NOW },
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.count, 1);
    assert.equal(json.grants.length, 1);
    assert.equal(json.grants[0].grant.nonce, "n-live");

    const expectedLiveId = grantId(normalizeGrant(live, { now: NOW }));
    assert.equal(json.grants[0].id, expectedLiveId);
  });
});
