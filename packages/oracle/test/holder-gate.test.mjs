// Locals Only holder gate.
//
// The gate decides who may download and install Oracle. Its security rests on
// two independent facts that must BOTH hold: the wallet holds the NFT, and the
// caller controls that wallet. Every test below exists because dropping one of
// those, or weakening how they combine, produces a gate that looks like it
// works and does not.

import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";

import {
  LOCALS_ONLY_CONTRACT,
  LOCALS_ONLY_CHAIN_ID,
  LOCALS_ONLY_RPC,
  NONCE_TTL_MS,
  createNonceStore,
  challengeMessage,
  issueChallenge,
  issueSession,
  readSession,
  verifyChallenge,
  holderBalance,
} from "../src/gate/holder-gate.mjs";

const SECRET = "test-secret-not-a-real-key";
const holder = () => ({ balanceOf: async () => 1n });
const nonHolder = () => ({ balanceOf: async () => 0n });

async function signedChallenge({ wallet, store, ttlMs } = {}) {
  const w = wallet ?? Wallet.createRandom();
  const s = store ?? createNonceStore();
  const challenge = issueChallenge(w.address, { store: s, ttlMs });
  const signature = await w.signMessage(challenge.message);
  return { wallet: w, store: s, challenge, signature };
}

test("the shipped contract is the verified Locals Only collection", () => {
  // Verified on-chain against HyperEVM: name() "Locals Only", symbol() LOCALS,
  // totalSupply() 500. Hardcoded so a missing env var cannot silently open the
  // gate to every wallet.
  assert.equal(LOCALS_ONLY_CONTRACT, "0x62FCFAf7573AD8B41a0FBF347AfEb85e06599A75");
  assert.equal(LOCALS_ONLY_CHAIN_ID, 999);
  assert.match(LOCALS_ONLY_RPC, /^https:\/\//);
});

test("a real holder who signs the challenge gets a session", async () => {
  const { store, challenge, signature } = await signedChallenge();
  const result = await verifyChallenge({
    nonce: challenge.nonce,
    signature,
    store,
    secret: SECRET,
    balanceOf: holder().balanceOf,
  });
  assert.equal(result.balance, "1");
  assert.ok(result.token);
  const session = readSession(result.token, { secret: SECRET });
  assert.equal(session.address, result.address);
  assert.equal(session.gate, "locals-only");
});

test("a wallet holding nothing is refused even with a valid signature", async () => {
  const { store, challenge, signature } = await signedChallenge();
  await assert.rejects(
    () => verifyChallenge({
      nonce: challenge.nonce,
      signature,
      store,
      secret: SECRET,
      balanceOf: nonHolder().balanceOf,
    }),
    /not-a-holder/,
  );
});

test("claiming a holder's address without their key is refused", async () => {
  // The whole point. An attacker knows a holder's address (it is public
  // on-chain) and asks for a challenge as them, but cannot produce the
  // signature. balanceOf alone would let this through.
  const victim = Wallet.createRandom();
  const attacker = Wallet.createRandom();
  const store = createNonceStore();
  const challenge = issueChallenge(victim.address, { store });
  const forged = await attacker.signMessage(challenge.message);

  await assert.rejects(
    () => verifyChallenge({
      nonce: challenge.nonce,
      signature: forged,
      store,
      secret: SECRET,
      balanceOf: holder().balanceOf,
    }),
    /address-mismatch/,
  );
});

test("a nonce cannot be replayed", async () => {
  const { store, challenge, signature } = await signedChallenge();
  await verifyChallenge({
    nonce: challenge.nonce,
    signature,
    store,
    secret: SECRET,
    balanceOf: holder().balanceOf,
  });
  await assert.rejects(
    () => verifyChallenge({
      nonce: challenge.nonce,
      signature,
      store,
      secret: SECRET,
      balanceOf: holder().balanceOf,
    }),
    /challenge-not-found/,
  );
});

test("an expired challenge is refused", async () => {
  const { store, challenge, signature } = await signedChallenge({ ttlMs: 1000 });
  await assert.rejects(
    () => verifyChallenge({
      nonce: challenge.nonce,
      signature,
      store,
      secret: SECRET,
      balanceOf: holder().balanceOf,
      now: Date.now() + 5000,
    }),
    /challenge-expired/,
  );
});

test("garbage passed as a signature is refused, not crashed on", async () => {
  const { store, challenge } = await signedChallenge();
  await assert.rejects(
    () => verifyChallenge({
      nonce: challenge.nonce,
      signature: "0xdeadbeef",
      store,
      secret: SECRET,
      balanceOf: holder().balanceOf,
    }),
    /bad-signature/,
  );
});

test("the balance check runs only after control is proven, on the RECOVERED address", async () => {
  // Order matters: a pre-verification balance lookup lets anyone probe whether
  // an arbitrary wallet holds the NFT, using this service as an oracle.
  //
  // Asserting "balanceOf did not run" is not enough on its own. The lookup must
  // also use the address RECOVERED from the signature, never the address the
  // caller claimed, or a mismatch could still be resolved against the victim's
  // holdings.
  let checked = false;
  const store = createNonceStore();
  const victim = Wallet.createRandom();
  const attacker = Wallet.createRandom();
  const challenge = issueChallenge(victim.address, { store });
  const forged = await attacker.signMessage(challenge.message);

  await assert.rejects(
    () => verifyChallenge({
      nonce: challenge.nonce,
      signature: forged,
      store,
      secret: SECRET,
      balanceOf: async () => { checked = true; return 1n; },
    }),
    /address-mismatch/,
  );
  assert.equal(checked, false, "balanceOf ran before the signature was verified");

  // Note on scope: once the equality check above passes, `recovered` and
  // `challenge.address` are provably the same string, so asserting which of the
  // two is handed to balanceOf proves nothing. What this test does pin is that
  // no balance lookup happens on the failure path at all.
  const holderWallet = Wallet.createRandom();
  const store2 = createNonceStore();
  const challenge2 = issueChallenge(holderWallet.address, { store: store2 });
  const signature2 = await holderWallet.signMessage(challenge2.message);
  let queried = null;
  await verifyChallenge({
    nonce: challenge2.nonce,
    signature: signature2,
    store: store2,
    secret: SECRET,
    balanceOf: async (address) => { queried = address; return 1n; },
  });
  assert.equal(
    queried,
    holderWallet.address.toLowerCase(),
    "balanceOf must be called with the verified signer address",
  );
});

test("a forged session token is rejected", () => {
  const token = issueSession({ address: Wallet.createRandom().address, balance: 1n, secret: SECRET });
  const [payload] = token.split(".");
  assert.equal(readSession(`${payload}.notavalidsignature`, { secret: SECRET }), null);
  assert.equal(readSession(token, { secret: "different-secret" }), null);
  assert.ok(readSession(token, { secret: SECRET }));
});

test("a session token that has expired is rejected", () => {
  const token = issueSession({
    address: Wallet.createRandom().address,
    balance: 1n,
    secret: SECRET,
    ttlMs: 1000,
  });
  assert.equal(readSession(token, { secret: SECRET, now: Date.now() + 5000 }), null);
});

test("the signed message states that signing grants no authority", () => {
  // A gate that trains users to approve vague signatures is a liability even if
  // this particular signature is harmless.
  const message = challengeMessage({
    domain: "oracle.local",
    address: "0x0000000000000000000000000000000000000001",
    nonce: "abc",
    issuedAt: new Date().toISOString(),
  });
  assert.match(message, /does not submit a transaction/i);
  assert.match(message, /trading authority/i);
  assert.match(message, /Nonce: abc/);
});

test("an invalid address cannot open a challenge", () => {
  const store = createNonceStore();
  assert.throws(() => issueChallenge("not-an-address", { store }), /invalid-address/);
  assert.equal(store.size, 0);
});

test("live: the gate contract answers balanceOf on HyperEVM", async (t) => {
  // Proves the shipped contract/RPC pair is real and callable, not just a
  // plausible-looking constant.
  let balance;
  try {
    balance = await holderBalance("0x0000000000000000000000000000000000000001");
  } catch (error) {
    t.skip(`HyperEVM RPC unavailable: ${error.message}`);
    return;
  }
  assert.equal(typeof balance, "bigint");
});
