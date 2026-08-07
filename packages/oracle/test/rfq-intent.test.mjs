import test from "node:test";
import assert from "node:assert/strict";
import {
  hashFirmQuote,
  hashRfqIntent,
  normalizeFirmQuote,
  normalizeRfqIntent,
} from "../src/rfq/intent.mjs";

const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DEMI = "0x000000000000000000000000000000000000dEaD";

test("normalizes same-chain RFQ intent with safe source defaults", () => {
  const nowMs = 1_000_000;
  const intent = normalizeRfqIntent({
    fromChainId: 1,
    toChainId: 1,
    sellToken: ETH,
    buyToken: USDC,
    sellAmount: "1000000000000000000",
    receiver: DEMI,
    deadlineMs: nowMs + 60_000,
    minBuyAmount: "3000000000",
  }, { nowMs });
  assert.equal(intent.kind, "rfq-intent");
  assert.equal(intent.version, 1);
  assert.deepEqual(intent.allowedSources, ["lifi", "paraswap", "0x", "cow", "uniswap-v3"]);
  assert.equal(intent.intentHash, hashRfqIntent(intent));
});

test("normalizes cross-chain RFQ intent with lifi MVP default", () => {
  const intent = normalizeRfqIntent({
    fromChainId: 1,
    toChainId: 8453,
    sellToken: ETH,
    buyToken: USDC,
    sellAmount: "1",
    receiver: DEMI,
    deadlineMs: 2_000,
  }, { nowMs: 1_000 });
  assert.deepEqual(intent.allowedSources, ["lifi"]);
});

test("explicit empty source list stays a kill switch", () => {
  const intent = normalizeRfqIntent({
    fromChainId: 1,
    toChainId: 1,
    sellToken: ETH,
    buyToken: USDC,
    sellAmount: "1",
    receiver: DEMI,
    deadlineMs: 2_000,
    allowedSources: [],
  }, { nowMs: 1_000 });
  assert.deepEqual(intent.allowedSources, []);
});

test("rejects invalid chain, expired deadline, and zero amount", () => {
  assert.throws(() => normalizeRfqIntent({ fromChainId: 0, toChainId: 1, sellToken: ETH, buyToken: USDC, sellAmount: "1", receiver: DEMI, deadlineMs: 2_000 }, { nowMs: 1_000 }), /fromChainId/);
  assert.throws(() => normalizeRfqIntent({ fromChainId: 1, toChainId: 1, sellToken: ETH, buyToken: USDC, sellAmount: "0", receiver: DEMI, deadlineMs: 2_000 }, { nowMs: 1_000 }), /sellAmount/);
  assert.throws(() => normalizeRfqIntent({ fromChainId: 1, toChainId: 1, sellToken: ETH, buyToken: USDC, sellAmount: "1", receiver: DEMI, deadlineMs: 999 }, { nowMs: 1_000 }), /deadline/);
});

test("firm quote binds intent hash and tampering changes quote hash", () => {
  const intent = normalizeRfqIntent({
    fromChainId: 1,
    toChainId: 1,
    sellToken: ETH,
    buyToken: USDC,
    sellAmount: "1000",
    receiver: DEMI,
    deadlineMs: 10_000,
  }, { nowMs: 1_000 });
  const quote = normalizeFirmQuote(intent, {
    quoteId: "q1",
    source: "cow",
    amountOut: "2000",
    minBuyAmount: "1900",
    expiryMs: 5_000,
    quotedAtMs: 1_000,
    router: DEMI,
    artifact: { type: "typed-data", typedDataHash: "0x" + "11".repeat(32) },
  }, { nowMs: 1_000 });
  assert.equal(quote.kind, "rfq-firm-quote");
  assert.equal(quote.provider, "rfq");
  assert.equal(quote.surface, "rfq");
  assert.equal(quote.quotedAtMs, 1_000);
  assert.equal(quote.router, DEMI);
  assert.equal(quote.intentHash, intent.intentHash);
  assert.equal(quote.firmQuoteHash, hashFirmQuote(quote));
  const tampered = { ...quote, minBuyAmount: "1800" };
  assert.notEqual(hashFirmQuote(tampered), quote.firmQuoteHash);
});

test("firm quote refuses missing artifact, source outside intent, and expired quote", () => {
  const intent = normalizeRfqIntent({
    fromChainId: 1,
    toChainId: 1,
    sellToken: ETH,
    buyToken: USDC,
    sellAmount: "1000",
    receiver: DEMI,
    deadlineMs: 10_000,
    allowedSources: ["cow"],
  }, { nowMs: 1_000 });
  assert.throws(() => normalizeFirmQuote(intent, { quoteId: "q", source: "cow", amountOut: "1", minBuyAmount: "1", expiryMs: 2_000 }, { nowMs: 1_000 }), /artifact/);
  assert.throws(() => normalizeFirmQuote(intent, { quoteId: "q", source: "lifi", amountOut: "1", minBuyAmount: "1", expiryMs: 2_000, artifact: { type: "tx", to: DEMI, data: "0x" } }, { nowMs: 1_000 }), /source/);
  assert.throws(() => normalizeFirmQuote(intent, { quoteId: "q", source: "cow", amountOut: "1", minBuyAmount: "1", expiryMs: 999, artifact: { type: "typed-data", typedDataHash: "0x" + "22".repeat(32) } }, { nowMs: 1_000 }), /expired/);
});
