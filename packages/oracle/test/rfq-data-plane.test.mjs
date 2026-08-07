import test from "node:test";
import assert from "node:assert/strict";
import { dataCall, dataCatalog } from "../src/data/desk-data.mjs";
import { normalizeRfqIntent, requestRfqQuotes } from "../src/index.mjs";

const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DEMI = "0x000000000000000000000000000000000000dEaD";

test("rfq provider is catalogued as prepare-only", () => {
  const row = dataCatalog().find((p) => p.id === "rfq");
  assert.ok(row);
  assert.equal(row.execution, "prepare");
  assert.deepEqual(row.ops, ["health", "intent", "quote"]);
});

test("public root exports RFQ helpers", async () => {
  const intent = normalizeRfqIntent({ fromChainId: 1, toChainId: 1, sellToken: ETH, buyToken: USDC, sellAmount: "1", receiver: DEMI, deadlineMs: 2_000, allowedSources: [] }, { nowMs: 1_000 });
  const result = await requestRfqQuotes(intent, { nowMs: 1_000 });
  assert.equal(result.kind, "rfq-result");
  assert.equal(result.sourcesTried, 0);
});

test("dataCall rfq.intent and rfq.quote route through the data facade", async () => {
  const intent = await dataCall("rfq", "intent", { fromChainId: 1, toChainId: 1, sellToken: ETH, buyToken: USDC, sellAmount: "1", receiver: DEMI, deadlineMs: 2_000, allowedSources: [] }, { nowMs: 1_000 });
  assert.equal(intent.kind, "rfq-intent");
  const result = await dataCall("rfq", "quote", { intent }, { nowMs: 1_000 });
  assert.equal(result.kind, "rfq-result");
  assert.equal(result.sourcesTried, 0);
});
