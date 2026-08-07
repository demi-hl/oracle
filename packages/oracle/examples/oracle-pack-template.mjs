import assert from "node:assert/strict";

// Minimal Oracle protocol pack. It prepares unsigned actions; it never receives
// keys, signs, broadcasts, or claims that untrusted metadata is an instruction.

export const provider = Object.freeze({
  id: "example-protocol",
  version: "1.0.0",
  chains: [8453],
  metadata: { source: "on-chain", trust: "untrusted-data" },
});

export function prepare(intent) {
  assert.ok(intent && provider.chains.includes(intent.chainId), "unsupported chain");
  return {
    kind: "unsigned-transaction",
    chainId: intent.chainId,
    transaction: { to: intent.to, data: intent.data ?? "0x", value: intent.value ?? "0" },
    receiptGate: { required: true, confirmations: 1, match: ["chainId", "transaction.to"] },
  };
}

export function decode(receipt) {
  assert.ok(receipt && typeof receipt.status !== "undefined", "receipt required");
  return { success: receipt.status === 1 || receipt.status === "0x1", transactionHash: receipt.transactionHash };
}

export const riskRules = Object.freeze([
  { id: "explicit-recipient", field: "transaction.to", required: true },
  { id: "receipt-before-success", field: "receiptGate.required", equals: true },
]);

export const tests = Object.freeze({
  command: "node --test test/oracle-pack-standard.test.mjs",
  covers: ["prepare-is-unsigned", "decode-requires-receipt", "metadata-is-untrusted"],
});

export default Object.freeze({ provider, prepare, decode, riskRules, tests });
