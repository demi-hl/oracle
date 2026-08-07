// Jupiter Swap API lane for Solana. Prepare-only: returns a serialized
// transaction for the user's Solana wallet to sign. No local signer, no broadcast.

import { httpJson } from "../http.mjs";
import { solanaPubkey } from "./solana-rpc.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";
import { assertNoSignedMaterial } from "./signed-material-guard.mjs";

export const JUPITER_SWAP_API = "https://lite-api.jup.ag/swap/v1";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const JUPITER_MAX_SLIPPAGE_BPS = 100;
const DEFAULT_QUOTE_TTL_MS = 20_000;

function baseUrl(opts = {}) {
  return String(opts.baseUrl || process.env.JUPITER_SWAP_API_URL || JUPITER_SWAP_API).replace(/\/$/, "");
}

function amountString(value, label = "amount") {
  try {
    const n = BigInt(String(value));
    if (n <= 0n) throw new Error("nonpositive");
    return n.toString();
  } catch {
    throw new Error(`jupiter: ${label} must be a positive integer string`);
  }
}

function slippageBps(value) {
  const n = value == null ? 50 : Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error("jupiter: slippageBps must be a non-negative integer");
  if (n > JUPITER_MAX_SLIPPAGE_BPS) throw new Error("jupiter: slippage exceeds hard 100 bps cap");
  return n;
}

function boolDefault(value, fallback) {
  return value == null ? fallback : Boolean(value);
}

function base64Tx(value) {
  const text = String(value || "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) throw new Error("jupiter: swapTransaction must be base64");
  return text;
}

function solanaGuard(quote = {}, { quotedAtMs = Date.now(), ttlMs = DEFAULT_QUOTE_TTL_MS } = {}) {
  const inputMint = solanaPubkey(quote.inputMint, "inputMint");
  const outputMint = solanaPubkey(quote.outputMint, "outputMint");
  const inAmount = amountString(quote.inAmount, "inAmount");
  const outAmount = amountString(quote.outAmount, "outAmount");
  const otherAmountThreshold = amountString(quote.otherAmountThreshold ?? quote.outAmount, "otherAmountThreshold");
  const bps = slippageBps(quote.slippageBps ?? 50);
  return {
    mode: "solana-jupiter-quote",
    provider: "jupiter",
    venue: "jupiter-swap-v1",
    inputMint,
    outputMint,
    inAmount,
    outAmount,
    otherAmountThreshold,
    slippageBps: bps,
    contextSlot: quote.contextSlot ?? null,
    quotedAtMs,
    expiresAtMs: quotedAtMs + Math.min(Math.max(Number(ttlMs) || DEFAULT_QUOTE_TTL_MS, 1_000), 30_000),
  };
}

// Known BPF loaders. A program is only real if it is BOTH executable AND owned
// by one of these. `executable: true` alone is claimable by any account, so
// checking it in isolation is not proof.
const SOLANA_LOADERS = new Set([
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoader1111111111111111111111111111111111",
]);

const B58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function isSolanaPubkey(s) {
  if (typeof s !== "string" || !s.length) return false;
  let num = 0n;
  for (const ch of s) {
    const v = B58_ALPHA.indexOf(ch);
    if (v < 0) return false;
    num = num * 58n + BigInt(v);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let bytes = hex.length / 2;
  for (const ch of s) {
    if (ch === "1") bytes++;
    else break;
  }
  return bytes === 32;
}

export async function jupiterVenues(args = {}, opts = {}) {
  const rpcUrl = args.rpc || opts.solanaRpc || process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
  const fetchImpl = opts.fetchImpl || fetch;

  const res = await fetchImpl(`${JUPITER_SWAP_API}/program-id-to-label`, {
    signal: AbortSignal.timeout(Number(opts.timeoutMs) || 15_000),
  });
  if (!res.ok) throw new Error(`jupiter venue map failed: HTTP ${res.status}`);
  const labelMap = await res.json();

  const entries = Object.entries(labelMap);
  const wellFormed = entries.filter(([id]) => isSolanaPubkey(id));
  const verified = [];
  const unresolved = entries
    .filter(([id]) => !isSolanaPubkey(id))
    .map(([id, label]) => ({ programId: id, label, reason: "malformed program id" }));

  if (args.verify === false) {
    return {
      source: `${JUPITER_SWAP_API}/program-id-to-label`,
      verified: wellFormed.map(([programId, label]) => ({ programId, label })),
      unresolved,
      verifiedOnChain: false,
      totals: { fromRouterMap: entries.length, verified: wellFormed.length },
    };
  }

  const call = async (body) => {
    const r = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(opts.timeoutMs) || 20_000),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };

  for (let i = 0; i < wellFormed.length; i += 90) {
    const chunk = wellFormed.slice(i, i + 90);
    let out = null;
    for (let attempt = 0; attempt < 3 && !out; attempt++) {
      try {
        out = await call({
          jsonrpc: "2.0",
          id: 1,
          method: "getMultipleAccounts",
          params: [chunk.map(([id]) => id), { encoding: "base64", dataSlice: { offset: 0, length: 0 } }],
        });
      } catch {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    if (!out) {
      for (const [programId, label] of chunk) {
        unresolved.push({ programId, label, reason: "rpc batch failed after 3 attempts" });
      }
      continue;
    }
    out.value.forEach((acc, k) => {
      const [programId, label] = chunk[k];
      if (acc && acc.executable === true && SOLANA_LOADERS.has(acc.owner)) {
        verified.push({ programId, label, owner: acc.owner });
      } else {
        unresolved.push({
          programId,
          label,
          reason: !acc ? "account not found" : acc.executable !== true ? "not executable" : `unknown owner ${acc.owner}`,
        });
      }
    });
    if (i + 90 < wellFormed.length) await new Promise((r) => setTimeout(r, 700));
  }

  const brands = new Set(
    verified.map((v) => v.label.replace(/\s+(CLMM|CP|V\d+|Launchlab|DLMM|Pools?)$/i, "").trim())
  );

  return {
    source: `${JUPITER_SWAP_API}/program-id-to-label`,
    rpc: rpcUrl,
    verifiedOnChain: true,
    verifiedAt: new Date().toISOString(),
    totals: {
      fromRouterMap: entries.length,
      verified: verified.length,
      unresolved: unresolved.length,
      distinctLabels: new Set(verified.map((v) => v.label)).size,
      distinctBrands: brands.size,
    },
    verified: verified.sort((a, b) => a.label.localeCompare(b.label)),
    unresolved,
  };
}

export async function jupiterHealth(opts = {}) {
  try {
    const q = await jupiterQuote({ inputMint: SOL_MINT, outputMint: USDC_MINT, amount: "1000000", slippageBps: 50 }, opts);
    return { ok: true, provider: "jupiter", outAmount: q.quote.outAmount, exec: false };
  } catch (error) {
    return { ok: false, provider: "jupiter", error: String(error?.message || error), exec: false };
  }
}

export async function jupiterQuote(args = {}, opts = {}) {
  const inputMint = solanaPubkey(args.inputMint || args.fromMint || SOL_MINT, "inputMint");
  const outputMint = solanaPubkey(args.outputMint || args.toMint || USDC_MINT, "outputMint");
  const amount = amountString(args.amount || args.inAmount, "amount");
  const bps = slippageBps(args.slippageBps ?? args.maxSlippageBps ?? 50);
  const url = new URL(`${baseUrl(opts)}/quote`);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amount);
  url.searchParams.set("slippageBps", String(bps));
  url.searchParams.set("swapMode", args.swapMode || "ExactIn");
  if (args.onlyDirectRoutes != null) url.searchParams.set("onlyDirectRoutes", String(Boolean(args.onlyDirectRoutes)));
  if (args.platformFeeBps != null) url.searchParams.set("platformFeeBps", String(args.platformFeeBps));
  const quote = await httpJson(url.toString(), {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 12_000,
  });
  const guard = solanaGuard({ ...quote, slippageBps: bps }, opts);
  return {
    provider: "jupiter",
    chain: "solana-mainnet-beta",
    quoteReady: true,
    executionReady: false,
    inputMint,
    outputMint,
    amount,
    quote,
    solanaGuard: guard,
  };
}

function compactBody(body) {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

export async function jupiterPrepareSwap(args = {}, opts = {}) {
  const userPublicKey = solanaPubkey(args.userPublicKey || args.owner || args.wallet, "userPublicKey");
  const quoteEnvelope = args.quoteResponse
    ? { quote: args.quoteResponse, solanaGuard: solanaGuard(args.quoteResponse, opts) }
    : await jupiterQuote(args, opts);
  const quoteResponse = quoteEnvelope.quote;
  const guard = quoteEnvelope.solanaGuard || solanaGuard(quoteResponse, opts);

  // dynamicSlippage lets Jupiter widen the on-chain slippage floor at build
  // time, which silently voids the hard bps ceiling the quote path enforced —
  // the returned guard would still advertise the capped number. Refuse it
  // rather than return a transaction whose real tolerance exceeds the cap.
  if (boolDefault(args.dynamicSlippage, false) === true) {
    throw new Error(
      "jupiter: dynamicSlippage would override the enforced slippage ceiling — pass an explicit slippageBps instead"
    );
  }

  const response = await httpJson(`${baseUrl(opts)}/swap`, {
    method: "POST",
    body: compactBody({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: boolDefault(args.wrapAndUnwrapSol, true),
      dynamicComputeUnitLimit: boolDefault(args.dynamicComputeUnitLimit, true),
      dynamicSlippage: false,
      prioritizationFeeLamports: args.prioritizationFeeLamports,
    }),
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
  const swapTransaction = base64Tx(response?.swapTransaction);

  // Refuse pre-signed material by PRESENCE. The primary `swapTransaction` field
  // stays unsigned, but the full upstream body was echoed as `raw` and
  // hash-bound into the envelope, so a hostile endpoint could smuggle a signed
  // sibling that downstream tooling might select instead.
  assertNoSignedMaterial("jupiter", response);

  // Bind the returned transaction to the quote it claims to implement. A
  // compromised or impersonated endpoint can return any bytes while Oracle
  // stamps the optimistic quote on top; the user signs the bytes, not the
  // guard. Jupiter echoes the quote it built from — require it to match.
  const echoed = response?.quoteResponse ?? response?.quote ?? null;
  if (echoed) {
    for (const field of ["inAmount", "outAmount", "otherAmountThreshold", "inputMint", "outputMint"]) {
      const want = quoteResponse?.[field];
      const got = echoed?.[field];
      if (want != null && got != null && String(want) !== String(got)) {
        throw new Error(
          `jupiter: swap response ${field} (${got}) does not match the quoted ${field} (${want}) — refusing to prepare`
        );
      }
    }
  }

  return stampPrepared({
    provider: "jupiter",
    chain: "solana-mainnet-beta",
    prepareReady: true,
    executionReady: false,
    signingReady: false,
    broadcastReady: false,
    requiresUserSignature: true,
    // The prepared bytes are NOT verified against the quote beyond the fields
    // Jupiter echoes. Simulate before signing.
    verifiedAgainstQuote: Boolean(echoed),
    userPublicKey,
    quote: quoteResponse,
    solanaGuard: guard,
    swapTransaction,
    swapTransactionEncoding: "base64",
    lastValidBlockHeight: response?.lastValidBlockHeight ?? null,
    prioritizationFeeLamports: response?.prioritizationFeeLamports ?? null,
    computeUnitLimit: response?.computeUnitLimit ?? null,
    raw: response,
  }, { provider: "jupiter", kind: "jupiter-swap" });
}
