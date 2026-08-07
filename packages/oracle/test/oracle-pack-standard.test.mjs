import { test } from "node:test";
import assert from "node:assert/strict";
import pack, { provider, prepare, decode, riskRules, tests } from "../examples/oracle-pack-template.mjs";
import { benchmarkPack } from "../scripts/adversarial-bench.mjs";

test("template exposes the complete standard surface", () => {
  assert.deepEqual(pack, { provider, prepare, decode, riskRules, tests });
  assert.equal(benchmarkPack({ default: pack }).ok, true);
});

test("prepare returns an unsigned action with a receipt gate", () => {
  const result = prepare({ chainId: 8453, to: "0x1111111111111111111111111111111111111111" });
  assert.equal(result.kind, "unsigned-transaction");
  assert.equal(result.receiptGate.required, true);
  assert.equal("signature" in result, false);
  assert.equal("transactionHash" in result, false);
});

test("decoder requires a receipt and reports its status", () => {
  assert.throws(() => decode(), /receipt required/);
  assert.deepEqual(decode({ status: 1, transactionHash: "0xabc" }), { success: true, transactionHash: "0xabc" });
  assert.equal(decode({ status: 0, transactionHash: "0xdef" }).success, false);
});
