// Regression coverage for the 2026-08-03 grok-lane finding F1: prepare helpers
// accepted MIXED upstream payloads (valid unsigned bytes plus a pre-signed
// sibling) and hash-bound the signed material into the stamped envelope.
//
// The original guards only fired when the unsigned field was ABSENT, so
// signed-only was refused while mixed sailed through. These tests assert
// refusal by PRESENCE, and that legitimate unsigned payloads still prepare.

import { test } from "node:test";
import assert from "node:assert/strict";

import { findSignedFields, assertNoSignedMaterial } from "../src/data/providers/signed-material-guard.mjs";

const B58 = "DtM6A1ivwvFeT14f7ggTAGvpUTZA5LeutV3rLe8wR6U3";

const mkFetch = (body) => async () => ({
  ok: true,
  status: 200,
  headers: { get: () => "application/json" },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

test("the guard finds signed fields by name, case, and separator", () => {
  assert.deepEqual(findSignedFields({ tx: { data: [1] } }), []);
  assert.ok(findSignedFields({ txSigned: "x" }).length);
  assert.ok(findSignedFields({ signed_tx: "x" }).length);
  assert.ok(findSignedFields({ "Signed-Transaction": "x" }).length);
  assert.ok(findSignedFields({ signedPSBTBase64: "x" }).length);
  assert.ok(findSignedFields({ outer: { inner: { signature: "x" } } }).length, "must recurse into nested objects");
  assert.ok(findSignedFields([{ signedTx: "x" }]).length, "must recurse into arrays");
});

test("the guard does not flag ordinary unsigned prepare payloads", () => {
  assert.deepEqual(findSignedFields({ swapTransaction: "base64", lastValidBlockHeight: 1 }), []);
  assert.deepEqual(findSignedFields({ unsignedPSBTBase64: "abc", price_sats: 10 }), []);
  assert.doesNotThrow(() => assertNoSignedMaterial("test", { tx: { data: [1, 2, 3] } }));
});

// An over-tight filter that breaks a real prepare flow is its own bug.
// `unsignedPSBTBase64` normalizes to a string ENDING in `signedpsbtbase64`, so
// a naive suffix match refuses the exact payload the guard exists to protect.
test("explicitly unsigned field names are never treated as signed material", () => {
  for (const key of [
    "unsignedPSBTBase64",
    "unsignedPsbtBase64",
    "unsigned_psbt",
    "unsignedTx",
    "unsignedTransaction",
    "toSignMessage",
    "signableTransaction",
  ]) {
    assert.deepEqual(findSignedFields({ [key]: "value" }), [], `${key} is the unsigned field and must be accepted`);
  }
});

test("magic eden refuses a MIXED unsigned+signed payload, not just signed-only", async () => {
  const { magicEdenSolPrepareBuy } = await import("../src/data/providers/magiceden-sol.mjs");
  const args = { buyer: B58, seller: B58, auctionHouse: B58, tokenMint: B58, tokenATA: B58, price: 1 };

  // unsigned-only still prepares
  const ok = await magicEdenSolPrepareBuy(args, {
    apiKey: "test-only",
    fetchImpl: mkFetch({ tx: { data: [1, 2, 3] } }),
  });
  assert.equal(ok.requiresUserSignature, true);
  assert.equal(JSON.stringify(ok).includes("txSigned"), false);

  for (const hostile of [
    { txSigned: { data: [9] } },
    { tx: { data: [1, 2, 3] }, txSigned: { data: [9] } },
    { tx: { data: [1, 2, 3] }, signedTransaction: "EVIL" },
  ]) {
    await assert.rejects(
      () => magicEdenSolPrepareBuy(args, { apiKey: "test-only", fetchImpl: mkFetch(hostile) }),
      /pre-signed/,
      `magiceden must refuse ${JSON.stringify(hostile)}`
    );
  }
});

test("satflow refuses signed PSBT material in a purchase intent", async () => {
  const { satflowPreparePurchase } = await import("../src/data/providers/satflow.mjs");
  const args = {
    maxSats: 20000,
    inscription_id: "abc i0",
    buyer_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    price: 10000,
  };

  const ok = await satflowPreparePurchase(args, {
    apiKey: "test-key",
    fetchImpl: mkFetch({ price_sats: 10000, unsignedPSBTBase64: "UNSIGNED_OK" }),
  });
  assert.equal(ok.unsignedPsbt, "UNSIGNED_OK");

  for (const hostile of [
    { price_sats: 10000, unsignedPSBTBase64: "UNSIGNED_OK", signedPsbt: "EVIL" },
    { price_sats: 10000, signedPSBTBase64: "EVIL_ONLY" },
    // A bare psbt has no unsigned provenance. Treating it as unsigned lets a
    // signed PSBT cross the boundary under a neutral field name.
    { price_sats: 10000, psbt: "AMBIGUOUS_OR_SIGNED" },
  ]) {
    await assert.rejects(
      () => satflowPreparePurchase(args, { apiKey: "test-key", fetchImpl: mkFetch(hostile) }),
      /pre-signed|unsigned/i,
      `satflow must refuse ${JSON.stringify(hostile)}`
    );
  }
});

// Hostile names observed in the closure audit. These are behavior vectors, not
// implementation-string checks: every field must cause the actual public guard
// to refuse its payload before a provider can stamp it.
test("the signed-material guard blocks carrier aliases, deep payloads, and preserves status fields", () => {
  const mustRefuse = [
    "signedTransactionBase64", "signedTxBase64", "txSignedBase64",
    "signedPsbtHex", "signed_psbt_b64", "signaturesBase64",
    "finalizedPsbt", "completePsbt", "psbt", "serializedTransaction",
    "signedPayload", "signedMessageBase64", "preSignedTx", "presigned_transaction",
    "sig", "sigs", "scriptSig", "witness",
  ];
  for (const key of mustRefuse) {
    assert.ok(findSignedFields({ [key]: "MATERIAL" }).length, `${key} must be treated as signed material`);
  }

  assert.ok(findSignedFields({ psbtComplete: true, psbt: "MATERIAL" }).length, "complete PSBT must be refused");
  assert.ok(findSignedFields({ v: 27, r: "0x01", s: "0x02" }).length, "v/r/s signature tuple must be refused");

  let tooDeep = { signature: "MATERIAL" };
  for (let i = 0; i < 7; i += 1) tooDeep = { wrapper: tooDeep };
  assert.ok(findSignedFields(tooDeep).length, "over-depth payload must fail closed, not skip the signed leaf");

  for (const key of [
    "requiresUserSignature", "needsSignature", "signatureRequired", "signaturesRequired",
    "signingReady", "multisig", "cosig", "unsignedPSBTBase64", "toSignTransaction",
  ]) {
    assert.deepEqual(findSignedFields({ [key]: key === "signingReady" ? false : "status" }), [], `${key} is status/config, not signed bytes`);
  }
});

test("satflow refuses mixed signed material in BOTH purchase and list prepares", async () => {
  const { satflowPrepareList } = await import("../src/data/providers/satflow.mjs");
  const hostile = { unsignedListingPSBTBase64: "UNSIGNED_OK", signedPsbt: "EVIL" };
  await assert.rejects(
    () => satflowPrepareList(
      { inscription_id: "abc i0", seller_address: "bc1qtest" },
      { apiKey: "test-key", fetchImpl: mkFetch(hostile) },
    ),
    /pre-signed/,
    "satflow list must reject mixed upstream signed material before stamping",
  );
});
