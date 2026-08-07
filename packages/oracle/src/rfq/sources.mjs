import { lifiQuote } from "../data/providers/lifi.mjs";
import { paraswapPrice } from "../data/providers/paraswap.mjs";
import { zeroxQuote } from "../data/providers/zerox.mjs";
import { cowQuote } from "../data/providers/cowswap.mjs";
import { uniV3QuoteExactIn, UNI_V3_CHAINS } from "../data/providers/uniswap-v3.mjs";
import { normalizeFirmQuote } from "./intent.mjs";

function allowed(intent, source) {
  return Array.isArray(intent?.allowedSources) && intent.allowedSources.includes(source);
}

function envValue(env, key) {
  return String(env?.[key] ?? "").trim();
}

function candidate(source, run) {
  return Object.freeze({ source, run });
}

export function sourceCandidates(intent, opts = {}) {
  if (!intent || intent.kind !== "rfq-intent") throw new Error("rfq: intent required");
  const env = opts.env ?? process.env;
  const providers = opts.providers ?? {};
  const uniChains = opts.supportedUniV3Chains ?? UNI_V3_CHAINS;
  const sameChain = Number(intent.fromChainId) === Number(intent.toChainId);
  const out = [];
  if (allowed(intent, "lifi")) {
    out.push(candidate("lifi", async () => {
      const fn = providers.lifiQuote ?? lifiQuote;
      const q = await fn({
        fromChain: intent.fromChainId,
        toChain: intent.toChainId,
        fromToken: intent.sellToken,
        toToken: intent.buyToken,
        fromAmount: intent.sellAmount,
        fromAddress: intent.receiver,
      }, opts);
      const est = q?.estimate ?? q?.[0]?.estimate ?? q;
      return {
        quoteId: q?.id ?? q?.routeId ?? null,
        amountOut: est?.toAmount ?? q?.toAmount,
        minBuyAmount: est?.toAmountMin ?? q?.toAmountMin ?? est?.toAmount ?? q?.toAmount,
        expiryMs: Date.now() + Number(opts.defaultQuoteTtlMs ?? 20_000),
        artifact: { type: "lifi-route", calldataHash: q?.transactionRequest?.data ? await hashMaybe(opts, q.transactionRequest.data) : undefined, route: q },
        metadata: { tool: q?.tool ?? q?.toolDetails?.name ?? null },
      };
    }));
  }
  if (!sameChain) return out;
  if (allowed(intent, "paraswap")) {
    out.push(candidate("paraswap", async () => {
      const fn = providers.paraswapPrice ?? paraswapPrice;
      const q = await fn({
        chainId: intent.fromChainId,
        srcToken: intent.sellToken,
        destToken: intent.buyToken,
        amount: intent.sellAmount,
        srcDecimals: opts.decimalsIn,
        destDecimals: opts.decimalsOut,
      }, opts);
      const pr = q?.priceRoute ?? q;
      return {
        quoteId: pr?.id ?? null,
        amountOut: pr?.destAmount,
        minBuyAmount: q?.amountOutMinimum ?? pr?.destAmount,
        expiryMs: Date.now() + Number(opts.defaultQuoteTtlMs ?? 20_000),
        artifact: { type: "paraswap-price-route", route: pr },
        metadata: { contractAddress: pr?.contractAddress ?? null },
      };
    }));
  }
  if (allowed(intent, "0x") && (envValue(env, "ZEROX_API_KEY") || envValue(env, "0X_API_KEY") || providers.zeroxQuote)) {
    out.push(candidate("0x", async () => {
      const fn = providers.zeroxQuote ?? zeroxQuote;
      const q = await fn({ chainId: intent.fromChainId, sellToken: intent.sellToken, buyToken: intent.buyToken, sellAmount: intent.sellAmount, taker: intent.receiver }, opts);
      return {
        quoteId: q?.id ?? null,
        amountOut: q?.buyAmount ?? q?.grossBuyAmount,
        minBuyAmount: q?.minBuyAmount ?? q?.buyAmount,
        expiryMs: Date.now() + Number(opts.defaultQuoteTtlMs ?? 20_000),
        artifact: { type: "0x-transaction", to: q?.transaction?.to, data: q?.transaction?.data, value: q?.transaction?.value ?? "0" },
        metadata: { route: q?.route ?? null },
      };
    }));
  }
  if (allowed(intent, "cow")) {
    out.push(candidate("cow", async () => {
      const fn = providers.cowQuote ?? cowQuote;
      const q = await fn({ chainId: intent.fromChainId, sellToken: intent.sellToken, buyToken: intent.buyToken, sellAmountBeforeFee: intent.sellAmount, from: intent.receiver, signingScheme: "eip712" }, opts);
      const quote = q?.quote ?? q;
      return {
        quoteId: q?.id ?? null,
        amountOut: quote?.buyAmount,
        minBuyAmount: quote?.buyAmount,
        expiryMs: Math.min(Number(quote?.validTo ?? 0) * 1000 || Date.now() + Number(opts.defaultQuoteTtlMs ?? 20_000), intent.deadlineMs),
        artifact: { type: "cow-order", order: quote },
        metadata: { solver: true },
      };
    }));
  }
  if (allowed(intent, "uniswap-v3") && uniChains[Number(intent.fromChainId)]) {
    out.push(candidate("uniswap-v3", async () => {
      const fn = providers.uniV3QuoteExactIn ?? uniV3QuoteExactIn;
      const q = await fn({ chainId: intent.fromChainId, tokenIn: intent.sellToken, tokenOut: intent.buyToken, amountIn: intent.sellAmount }, opts);
      return {
        quoteId: q?.id ?? null,
        amountOut: q?.amountOut,
        minBuyAmount: q?.minOut ?? q?.amountOutMinimum ?? q?.amountOut,
        expiryMs: Date.now() + Number(opts.defaultQuoteTtlMs ?? 20_000),
        artifact: { type: "uniswap-v3-quote", quoter: q?.quoter, fee: q?.fee },
        metadata: { onchain: true },
      };
    }));
  }
  return out;
}

async function hashMaybe(opts, value) {
  const crypto = await import("node:crypto");
  return `0x${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}

async function runWithTimeout(c, timeoutMs) {
  return Promise.race([
    Promise.resolve().then(c.run),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${c.source}: timeout`)), timeoutMs)),
  ]);
}

export async function executeRfqCandidates(intent, candidates, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs ?? 12_000);
  const settled = await Promise.allSettled(candidates.map((c) => runWithTimeout(c, timeoutMs)));
  const quotes = [];
  const failed = [];
  for (let i = 0; i < settled.length; i++) {
    const c = candidates[i];
    const r = settled[i];
    if (r.status === "rejected") {
      failed.push({ source: c.source, error: String(r.reason?.message || r.reason) });
      continue;
    }
    try {
      quotes.push(normalizeFirmQuote(intent, { ...r.value, source: c.source }, opts));
    } catch (e) {
      failed.push({ source: c.source, error: String(e?.message || e) });
    }
  }
  return { quotes, failed };
}

export function rankRfqQuotes(quotes = [], opts = {}) {
  const nowMs = Number(opts.nowMs ?? Date.now());
  const usable = quotes.filter((q) => Number(q.expiryMs ?? 0) > nowMs);
  usable.sort((a, b) => {
    const floor = BigInt(b.minBuyAmount ?? 0) - BigInt(a.minBuyAmount ?? 0);
    if (floor !== 0n) return floor > 0n ? 1 : -1;
    const gross = BigInt(b.amountOut ?? 0) - BigInt(a.amountOut ?? 0);
    return gross > 0n ? 1 : gross < 0n ? -1 : 0;
  });
  const ranked = usable.map((q) => ({ ...q, scoreBasis: "minBuyAmount" }));
  const warnings = [];
  if (!ranked.length) warnings.push("no RFQ source returned a usable firm quote");
  if (quotes.length !== ranked.length) warnings.push("expired RFQ quotes were excluded from ranking");
  return { best: ranked[0] ?? null, quotes: ranked, failed: [], warnings };
}

export async function requestRfqQuotes(intent, opts = {}) {
  const candidates = sourceCandidates(intent, opts);
  const { quotes, failed } = await executeRfqCandidates(intent, candidates, opts);
  const ranked = rankRfqQuotes(quotes, opts);
  return {
    kind: "rfq-result",
    intent,
    best: ranked.best,
    quotes: ranked.quotes,
    failed,
    warnings: [...ranked.warnings],
    sourcesTried: candidates.length,
    sourcesAnswered: quotes.length,
  };
}
