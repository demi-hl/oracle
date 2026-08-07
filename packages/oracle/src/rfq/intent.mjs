import { createHash } from "node:crypto";
import { getAddress, isAddress } from "ethers";

export const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const DEFAULT_SAME_CHAIN_SOURCES = Object.freeze(["lifi", "paraswap", "0x", "cow", "uniswap-v3"]);
export const DEFAULT_CROSS_CHAIN_SOURCES = Object.freeze(["lifi"]);
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const INT = /^\d+$/;

function fail(label, message = "invalid") {
  throw new Error(`rfq: ${label} ${message}`);
}

function chainId(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) fail(label, "must be a positive chainId");
  return n;
}

function amount(value, label) {
  const s = String(value ?? "").trim();
  if (!INT.test(s) || BigInt(s) <= 0n) fail(label, "must be a positive integer string");
  return s;
}

function optionalAmount(value, label) {
  if (value == null || value === "") return null;
  return amount(value, label);
}

function token(value, label) {
  const s = String(value ?? "").trim();
  if (s.toLowerCase() === NATIVE_TOKEN.toLowerCase()) return NATIVE_TOKEN;
  if (!isAddress(s)) fail(label, "must be an EVM address or native token sentinel");
  return getAddress(s);
}

function address(value, label) {
  const s = String(value ?? "").trim();
  if (!isAddress(s)) fail(label, "must be an EVM address");
  return getAddress(s);
}

function optionalAddress(value, label) {
  if (value == null || value === "") return null;
  return address(value, label);
}

function stringList(value, label, defaults) {
  if (value === undefined) return [...defaults];
  if (!Array.isArray(value)) fail(label, "must be an array");
  return value.map((x) => String(x).trim()).filter(Boolean);
}

function deadline(value, { nowMs, maxDeadlineMs }, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) fail(label, "must be a finite millisecond timestamp");
  if (n <= nowMs) fail(label, "expired");
  if (n > nowMs + maxDeadlineMs) fail(label, "exceeds maxDeadlineMs");
  return Math.floor(n);
}

function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = plain(value[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(plain(value));
}

export function sha256Hex(value) {
  return `0x${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function withoutHash(value, keys) {
  const out = { ...value };
  for (const key of keys) delete out[key];
  return out;
}

export function hashRfqIntent(intent) {
  return sha256Hex(withoutHash(intent, ["intentHash"]));
}

export function hashFirmQuote(quote) {
  return sha256Hex(withoutHash(quote, ["firmQuoteHash"]));
}

export function normalizeRfqIntent(input = {}, opts = {}) {
  const nowMs = Number(opts.nowMs ?? Date.now());
  const maxDeadlineMs = Number(opts.maxDeadlineMs ?? 30 * 60 * 1000);
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxDeadlineMs) || maxDeadlineMs <= 0) fail("time", "is invalid");
  const fromChainId = chainId(input.fromChainId ?? input.fromChain, "fromChainId");
  const toChainId = chainId(input.toChainId ?? input.toChain, "toChainId");
  const sameChain = fromChainId === toChainId;
  const defaults = sameChain ? DEFAULT_SAME_CHAIN_SOURCES : DEFAULT_CROSS_CHAIN_SOURCES;
  const intent = {
    kind: "rfq-intent",
    version: 1,
    fromChainId,
    toChainId,
    sellToken: token(input.sellToken ?? input.tokenIn ?? input.fromToken, "sellToken"),
    buyToken: token(input.buyToken ?? input.tokenOut ?? input.toToken, "buyToken"),
    sellAmount: amount(input.sellAmount ?? input.amountIn ?? input.fromAmount, "sellAmount"),
    receiver: address(input.receiver ?? input.recipient ?? input.to, "receiver"),
    deadlineMs: deadline(input.deadlineMs ?? input.deadline ?? input.expiresAtMs, { nowMs, maxDeadlineMs }, "deadline"),
    minBuyAmount: optionalAmount(input.minBuyAmount ?? input.minOut ?? input.amountOutMin, "minBuyAmount"),
    allowedSources: stringList(input.allowedSources, "allowedSources", defaults),
    allowedRouters: stringList(input.allowedRouters, "allowedRouters", []),
    slippageBps: Number.isFinite(Number(input.slippageBps)) ? Number(input.slippageBps) : null,
    partialFill: input.partialFill === true,
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? plain(input.metadata) : {},
  };
  if (intent.slippageBps != null && (!Number.isInteger(intent.slippageBps) || intent.slippageBps < 0 || intent.slippageBps > 10_000)) fail("slippageBps", "must be 0 to 10000");
  intent.intentId = input.intentId ? String(input.intentId) : sha256Hex({ seed: "rfq-intent", intent }).slice(0, 34);
  intent.intentHash = hashRfqIntent(intent);
  return Object.freeze(intent);
}

function artifact(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("artifact", "required");
  if (value.typedDataHash != null && !HEX32.test(String(value.typedDataHash))) fail("artifact.typedDataHash", "must be bytes32");
  if (value.calldataHash != null && !HEX32.test(String(value.calldataHash))) fail("artifact.calldataHash", "must be bytes32");
  if (value.to != null && !isAddress(String(value.to))) fail("artifact.to", "must be an address");
  if (value.data != null && !/^0x(?:[0-9a-fA-F]{2})*$/.test(String(value.data))) fail("artifact.data", "must be hex");
  return plain(value);
}

export function normalizeFirmQuote(intent, quote = {}, opts = {}) {
  if (!intent || intent.kind !== "rfq-intent") fail("intent", "required");
  const nowMs = Number(opts.nowMs ?? Date.now());
  const expiryMs = Number(quote.expiryMs ?? quote.expiresAtMs ?? quote.validUntilMs);
  if (!Number.isFinite(expiryMs)) fail("quote expiry", "required");
  if (expiryMs <= nowMs) fail("quote", "expired");
  if (expiryMs > intent.deadlineMs) fail("quote expiry", "exceeds intent deadline");
  const source = String(quote.source ?? quote.provider ?? "").trim();
  if (!source) fail("source", "required");
  if (!intent.allowedSources.includes(source)) fail("source", "not allowed by intent");
  const amountOut = amount(quote.amountOut ?? quote.buyAmount, "amountOut");
  const minBuyAmount = amount(quote.minBuyAmount ?? quote.minOut ?? amountOut, "minBuyAmount");
  if (BigInt(minBuyAmount) > BigInt(amountOut)) fail("minBuyAmount", "exceeds amountOut");
  const artifactValue = artifact(quote.artifact ?? quote.executableArtifact ?? quote.transaction ?? quote.typedData);
  const quotedAtMs = Number(quote.quotedAtMs ?? quote.timestampMs ?? opts.nowMs ?? Date.now());
  if (!Number.isFinite(quotedAtMs)) fail("quotedAtMs", "must be finite");
  const router = optionalAddress(quote.router ?? quote.settlementRouter ?? artifactValue.to, "router");
  const out = {
    kind: "rfq-firm-quote",
    provider: "rfq",
    surface: "rfq",
    version: 1,
    quoteId: String(quote.quoteId ?? quote.id ?? "").trim(),
    source,
    intentHash: intent.intentHash,
    fromChainId: intent.fromChainId,
    toChainId: intent.toChainId,
    sellToken: intent.sellToken,
    buyToken: intent.buyToken,
    sellAmount: intent.sellAmount,
    receiver: intent.receiver,
    router,
    amountOut,
    minBuyAmount,
    quotedAtMs: Math.floor(quotedAtMs),
    expiryMs: Math.floor(expiryMs),
    artifact: artifactValue,
    maker: quote.maker ? String(quote.maker) : null,
    metadata: quote.metadata && typeof quote.metadata === "object" && !Array.isArray(quote.metadata) ? plain(quote.metadata) : {},
  };
  if (!out.quoteId) out.quoteId = sha256Hex({ seed: "rfq-quote", out }).slice(0, 34);
  out.firmQuoteHash = hashFirmQuote(out);
  return Object.freeze(out);
}
