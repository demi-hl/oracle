import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ActionReceiptSecretError,
  canonicalReceiptJson,
  computeReceiptId,
  normalizeActionReceipt,
  summarizeActionReceipt,
} from "../src/action-receipts.mjs";

function facts(overrides = {}) {
  return {
    intent: { tokenOut: "USDC", amount: "100", tokenIn: "ETH" },
    route: { venue: "uniswap", chainId: 1 },
    decodedAction: { type: "swap", recipient: "0xabc" },
    policyChecks: [{ name: "spend-limit", ok: true }, { name: "slippage", ok: true }],
    allowlistHits: ["router:0xdef", "token:USDC"],
    prepareHash: "a".repeat(64),
    ...overrides,
  };
}

test("stable receipt ids ignore input and nested object key order", () => {
  const a = normalizeActionReceipt(facts());
  const b = normalizeActionReceipt({
    allowlistHits: ["router:0xdef", "token:USDC"],
    policyChecks: [{ ok: true, name: "spend-limit" }, { ok: true, name: "slippage" }],
    decodedAction: { recipient: "0xabc", type: "swap" },
    route: { chainId: 1, venue: "uniswap" },
    intent: { amount: "100", tokenIn: "ETH", tokenOut: "USDC" },
    prepareHash: "a".repeat(64),
  });
  assert.equal(a.receiptId, b.receiptId);
  assert.equal(a.receiptId.length, 64);
  assert.equal(computeReceiptId(a), a.receiptId);
});

test("public field changes change the id and unknown fields are omitted", () => {
  const a = normalizeActionReceipt(facts({ debug: "not part of schema" }));
  const b = normalizeActionReceipt(facts({ prepareHash: "b".repeat(64) }));
  assert.notEqual(a.receiptId, b.receiptId);
  assert.equal("debug" in a, false);
});

test("execute receipt includes tx hash and supplied before/after balances", () => {
  const receipt = normalizeActionReceipt(facts({
    transactionHash: "0xtx",
    beforeBalances: { ETH: 2n, USDC: "0" },
    afterBalances: { ETH: "1", USDC: "100" },
  }));
  assert.equal(receipt.phase, "execute");
  assert.equal(receipt.txHash, "0xtx");
  assert.deepEqual(receipt.balances, {
    after: { ETH: "1", USDC: "100" },
    before: { ETH: "2", USDC: "0" },
  });
});

test("secret-bearing fields are refused without echoing their values", () => {
  const secrets = ["privateKey", "private_key", "mnemonic", "bearer", "authorization", "signature", "txSignature"];
  for (const key of secrets) {
    const value = `DO-NOT-ECHO-${key}`;
    assert.throws(
      () => normalizeActionReceipt(facts({ metadata: { [key]: value } })),
      (error) => error instanceof ActionReceiptSecretError && !error.message.includes(value),
      key,
    );
  }
});

test("unknown secret material is refused rather than silently redacted", () => {
  assert.throws(
    () => normalizeActionReceipt(facts({ ignored: { authorization: "Bearer abc" } })),
    /secret-bearing field at \$\.ignored\.authorization/,
  );
});

test("canonical JSON is detached, stable, and rejects non-JSON values", () => {
  assert.equal(canonicalReceiptJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
  assert.throws(() => canonicalReceiptJson({ value: Number.NaN }), /non-finite/);
});

test("summaries are deterministic and human-readable for prepare and execute", () => {
  const prepared = normalizeActionReceipt(facts());
  assert.equal(
    summarizeActionReceipt(prepared),
    `prepare swap via uniswap; policy 2 passed, 0 failed; 2 allowlist hits; no transaction hash; balances not provided; receipt ${prepared.receiptId}`,
  );

  const executed = normalizeActionReceipt(facts({
    txHash: "0x123",
    balances: { before: { ETH: "2" }, after: { ETH: "1" } },
  }));
  assert.equal(
    summarizeActionReceipt(executed),
    `execute swap via uniswap; policy 2 passed, 0 failed; 2 allowlist hits; tx 0x123; before/after balances recorded; receipt ${executed.receiptId}`,
  );
});
