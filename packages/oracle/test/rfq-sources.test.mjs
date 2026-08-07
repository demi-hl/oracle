import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRfqIntent } from "../src/rfq/intent.mjs";
import { executeRfqCandidates, rankRfqQuotes, sourceCandidates } from "../src/rfq/sources.mjs";

const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DEMI = "0x000000000000000000000000000000000000dEaD";

function intent(extra = {}) {
  return normalizeRfqIntent({
    fromChainId: 1,
    toChainId: 1,
    sellToken: ETH,
    buyToken: USDC,
    sellAmount: "1000",
    receiver: DEMI,
    deadlineMs: 10_000,
    ...extra,
  }, { nowMs: 1_000 });
}

test("sourceCandidates selects same-chain and respects empty source kill switch", () => {
  assert.deepEqual(sourceCandidates(intent({ allowedSources: [] })).map((c) => c.source), []);
  const names = sourceCandidates(intent(), { env: { ZEROX_API_KEY: "k" }, supportedUniV3Chains: { 1: true } }).map((c) => c.source);
  assert.deepEqual(names, ["lifi", "paraswap", "0x", "cow", "uniswap-v3"]);
});

test("sourceCandidates limits cross-chain MVP to lifi", () => {
  const names = sourceCandidates(intent({ toChainId: 8453 }), { env: { ZEROX_API_KEY: "k" }, supportedUniV3Chains: { 1: true } }).map((c) => c.source);
  assert.deepEqual(names, ["lifi"]);
});

test("executeRfqCandidates isolates failed or timed out venues", async () => {
  const i = intent({ allowedSources: ["good", "bad", "slow"] });
  const candidates = [
    { source: "good", run: async () => ({ quoteId: "a", amountOut: "100", minBuyAmount: "95", expiryMs: 5_000, artifact: { type: "tx", to: DEMI, data: "0x1234" } }) },
    { source: "bad", run: async () => { throw new Error("down"); } },
    { source: "slow", run: () => new Promise((resolve) => setTimeout(() => resolve({ quoteId: "s", amountOut: "1", minBuyAmount: "1", expiryMs: 5_000, artifact: { type: "tx", to: DEMI, data: "0x" } }), 50)) },
  ];
  const out = await executeRfqCandidates(i, candidates, { nowMs: 1_000, timeoutMs: 5 });
  assert.equal(out.quotes.length, 1);
  assert.equal(out.quotes[0].source, "good");
  assert.deepEqual(out.failed.map((f) => f.source), ["bad", "slow"]);
});

test("rankRfqQuotes ranks firm floor before gross output and warns on no fill", () => {
  const ranked = rankRfqQuotes([
    { source: "gross", amountOut: "120", minBuyAmount: "90", expiryMs: 5_000 },
    { source: "firm", amountOut: "110", minBuyAmount: "100", expiryMs: 5_000 },
  ], { nowMs: 1_000 });
  assert.equal(ranked.best.source, "firm");
  assert.equal(ranked.quotes[0].scoreBasis, "minBuyAmount");
  assert.match(rankRfqQuotes([], { nowMs: 1_000 }).warnings[0], /no RFQ/);
});
