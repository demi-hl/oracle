// Regression coverage for the 2026-08-03 opus-lane finding: the ./receipts
// scrubber used a 5-word blocklist (privatekey, mnemonic, bearer, authorization,
// signature) and had NO value-shape rule, while address-book two files over
// already blocked every wallet-export alias plus key-shaped values.
//
// Verified to actually persist: unknown TOP-LEVEL props are dropped by the
// schema whitelist, but a secret nested inside a RETAINED field (intent, route,
// decodedAction) survived into the frozen receipt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeActionReceipt } from "../src/action-receipts.mjs";

// Fixtures built at runtime — never a committed key-shaped literal, which the
// repo secret scanner would (correctly) reject.
const HEX64 = "a".repeat(64);
const MNEMONIC = ["abandon", "ability", "able", "about", "above", "absent",
  "absorb", "abstract", "absurd", "abuse", "access", "accident"].join(" ");
const WIF = `5${"K".repeat(50)}`;

const VALID = {
  intent: "swap",
  route: "uniswap-v3",
  decodedAction: "exactInputSingle",
  policyChecks: [{ name: "cap", ok: true }],
  allowlistHits: ["router"],
  prepareHash: `0x${"b".repeat(64)}`,
};

test("the base receipt fixture is valid", () => {
  const r = normalizeActionReceipt(VALID);
  assert.equal(r.phase, "prepare");
});

test("every wallet-export alias is refused, not just privateKey/mnemonic", () => {
  for (const key of [
    "privateKey", "private_key", "privKey", "secretKey", "seedPhrase",
    "wif", "keyMaterial", "xprv", "xpriv", "mnemonic", "seed",
    "keystore", "passphrase", "password", "apiKey", "credential",
  ]) {
    assert.throws(
      () => normalizeActionReceipt({ ...VALID, [key]: HEX64 }),
      { code: "ACTION_RECEIPT_SECRET" },
      `${key} must be refused by the receipt scrubber`
    );
  }
});

// The gap only mattered because these fields are RETAINED. A secret under an
// unknown top-level key is dropped by the schema; one nested in intent/route/
// decodedAction was written into the receipt verbatim.
test("a secret nested inside a retained field is refused", () => {
  const cases = [
    { intent: { kind: "swap", secretKey: HEX64 } },
    { intent: { kind: "swap", seedPhrase: MNEMONIC } },
    { intent: { kind: "swap", wif: WIF } },
    { route: { venue: "uni", keyMaterial: HEX64 } },
    { decodedAction: { fn: "swap", xprv: HEX64 } },
  ];
  for (const override of cases) {
    assert.throws(
      () => normalizeActionReceipt({ ...VALID, ...override }),
      { code: "ACTION_RECEIPT_SECRET" },
      `nested secret must be refused: ${JSON.stringify(override)}`
    );
  }
});

test("a key-shaped VALUE in a benign field name is refused", () => {
  for (const [field, value] of [
    ["memo", HEX64],
    ["note", MNEMONIC],
    ["label", WIF],
    ["comment", `xprv${"9".repeat(60)}`],
  ]) {
    assert.throws(
      () => normalizeActionReceipt({ ...VALID, intent: { kind: "swap", [field]: value } }),
      { code: "ACTION_RECEIPT_SECRET" },
      `${field} carrying key-shaped material must be refused`
    );
  }
});

// The scrubber must visit STRING LEAVES in arrays, not merely object-property
// strings. Retained receipt fields preserve arbitrary nested values.
test("key-shaped values in nested arrays are refused before persistence", () => {
  for (const value of [MNEMONIC, HEX64, WIF]) {
    assert.throws(
      () => normalizeActionReceipt({ ...VALID, intent: { kind: "swap", memos: ["safe", value] } }),
      { code: "ACTION_RECEIPT_SECRET" },
      "array elements must get the same key-shape scan as object fields",
    );
  }
});

// A 32-byte hex leaf is ambiguous: it can be an EVM private key or a valid
// bytes32 protocol argument/x-only pubkey. The field allowlist must accept real
// protocol shapes without widening arbitrary prose fields such as `memo`.
test("legitimate 32-byte protocol values and ordinary twelve-word prose survive", () => {
  const protocolHexFields = ["calldata", "data", "publicKey", "pubkey", "message", "payload", "input", "extraData"];
  const intent = { kind: "swap" };
  for (const field of protocolHexFields) intent[field] = `0x${HEX64}`;
  intent.memo = "the cat sat and the dog ran and the fox hid out";

  const receipt = normalizeActionReceipt({ ...VALID, intent });
  const encoded = JSON.stringify(receipt);
  for (const field of protocolHexFields) {
    assert.equal(receipt.intent[field], `0x${HEX64}`, `${field} bytes32 must survive`);
  }
  assert.match(encoded, /the cat sat and the dog ran/, "ordinary prose is not a mnemonic");
});

// An over-tight filter that breaks real receipts is its own bug. A raw EVM
// private key and a bytes32 digest are byte-identical, so 64-hex is gated on
// the field NAME rather than blanket-refused.
test("legitimate bytes32 protocol params are still accepted", () => {
  const r = normalizeActionReceipt({
    ...VALID,
    txHash: `0x${HEX64}`,
    intent: {
      kind: "swap",
      orderHash: `0x${HEX64}`,
      salt: `0x${HEX64}`,
      merkleRoot: `0x${HEX64}`,
      nonce: `0x${HEX64}`,
      commitment: `0x${HEX64}`,
    },
  });
  const serialized = JSON.stringify(r);
  assert.ok(serialized.includes(HEX64), "digest-shaped params must survive into the receipt");
  assert.equal(r.phase, "execute", "supplying txHash marks the receipt as an execute phase");
});

// The array-leaf scan reuses the PARENT key for its name-based allowlist, so a
// digest field holding a LIST of digests must resolve the same way its singular
// form does. Plural protocol collections (orderHashes, proofs, txHashes) are the
// normal shape for batched routes; refusing them is an over-tight filter that
// breaks real receipts while blocking no secret.
test("plural digest collections survive the array-leaf scan", () => {
  const r = normalizeActionReceipt({
    ...VALID,
    intent: {
      kind: "swap",
      orderHashes: [`0x${HEX64}`, `0x${HEX64}`],
      proofs: [`0x${HEX64}`],
      txHashes: [`0x${HEX64}`],
      commitments: [`0x${HEX64}`],
      nonces: [`0x${HEX64}`],
    },
    route: { hops: 2, leafDigests: [`0x${HEX64}`] },
  });
  assert.equal(r.intent.orderHashes.length, 2, "batched order digests must survive");
  assert.equal(r.intent.proofs[0], `0x${HEX64}`, "merkle proof lists must survive");
  assert.equal(r.route.leafDigests[0], `0x${HEX64}`, "digest lists survive on any retained field");
});

// The plural allowance must not become a laundering channel: a mnemonic or WIF
// is refused by SHAPE regardless of how digest-like the field name is, and a
// bare 64-hex in a NON-digest plural field (memos) is still refused.
test("plural digest naming does not launder key-shaped material", () => {
  for (const value of [MNEMONIC, WIF]) {
    assert.throws(
      () => normalizeActionReceipt({ ...VALID, intent: { kind: "swap", orderHashes: [value] } }),
      { code: "ACTION_RECEIPT_SECRET" },
      "a digest-shaped plural name cannot whitelist key-shaped material",
    );
  }
  assert.throws(
    () => normalizeActionReceipt({ ...VALID, intent: { kind: "swap", memos: [HEX64] } }),
    { code: "ACTION_RECEIPT_SECRET" },
    "a non-digest plural field still refuses bare 64-hex",
  );
});
