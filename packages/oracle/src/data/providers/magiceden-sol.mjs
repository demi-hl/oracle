// Magic Eden Solana NFT lane. Read + prepare only.
//
// Reads (collection stats, listings, activities) are keyless on the public
// mainnet API. The instruction builders (buy_now, list, mint) require a Magic
// Eden API key and return an UNSIGNED transaction the user's wallet signs.
// Nothing here signs or broadcasts.

import { httpJson } from "../http.mjs";
import { solanaPubkey } from "./solana-rpc.mjs";
import { resolveProviderEndpoint, credentialedHeaders } from "../provider-endpoint.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";
import { assertNoSignedMaterial } from "./signed-material-guard.mjs";

export const MAGICEDEN_SOL_API = "https://api-mainnet.magiceden.dev/v2";
export const LAMPORTS_PER_SOL = 1_000_000_000;

function endpoint(opts = {}) {
  return resolveProviderEndpoint({
    provider: "magiceden",
    defaultUrl: MAGICEDEN_SOL_API,
    hosts: ["api-mainnet.magiceden.dev", "api-devnet.magiceden.dev"],
    url: opts.baseUrl || process.env.MAGICEDEN_API_URL,
  });
}

function base(opts = {}) {
  return endpoint(opts).baseUrl;
}

function apiKey(opts = {}) {
  return opts.apiKey || process.env.MAGICEDEN_API_KEY || "";
}

function headers(opts = {}) {
  // Bearer token goes only to a pinned Magic Eden host.
  const key = apiKey(opts);
  return credentialedHeaders(
    { accept: "application/json" },
    { Authorization: key ? `Bearer ${key}` : "" },
    endpoint(opts).trusted
  );
}

function symbolArg(value) {
  const symbol = String(value || "").trim();
  if (!/^[a-z0-9_]{1,64}$/i.test(symbol)) throw new Error("magiceden: symbol must be a collection slug");
  return symbol;
}

/**
 * Number() accepts "1e2", "0x10", " 12 " and Infinity. A price that parses
 * differently from how it reads is a spend-control bug: the UI shows one value
 * and the wallet is asked for another. Require a plain decimal.
 */
function positiveNumber(value, label) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`magiceden: ${label} must be a positive number`);
    return value;
  }
  const text = String(value ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`magiceden: ${label} must be a plain decimal number (no hex, exponent, or sign)`);
  }
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`magiceden: ${label} must be a positive number`);
  return n;
}

/** Pull the launchpad's quoted mint price (SOL) out of an API response. */
function mintPriceSol(raw) {
  const candidates = [
    raw?.price,
    raw?.mintPrice,
    raw?.priceSol,
    raw?.v0?.price,
    raw?.launchStageInfo?.price,
    raw?.stage?.price,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  // A free mint legitimately quotes zero.
  if (raw?.isFree === true) return 0;
  return null;
}

function lamports(sol) {
  return Math.round(positiveNumber(sol, "priceSol") * LAMPORTS_PER_SOL);
}

function listingExpiry(value) {
  if (value == null || value === "") throw new Error("magiceden: listing expiry is required and must be in the future");
  const expiry = Number(value);
  if (!Number.isSafeInteger(expiry) || expiry <= 0) {
    throw new Error("magiceden: expiry must be a future Unix timestamp in seconds");
  }
  if (expiry <= Math.floor(Date.now() / 1000)) {
    throw new Error("magiceden: expiry must be in the future");
  }
  return expiry;
}

function listConfirmation({ tokenMint, priceSol, expiry }) {
  return `list ${tokenMint} on magiceden-sol for ${priceSol} SOL until ${expiry}`;
}

function requireListingConfirmation(args, fields) {
  if (args.userConfirmed !== true) {
    throw new Error("magiceden: listing requires userConfirmed=true after reviewing tokenMint, priceSol, and expiry");
  }
  const expected = listConfirmation(fields);
  const actual = String(args.confirmation || args.confirmationPhrase || "").trim();
  if (actual !== expected) {
    throw new Error(`magiceden: confirmation must equal ${JSON.stringify(expected)}`);
  }
  return expected;
}

export async function magicEdenSolHealth(opts = {}) {
  try {
    const stats = await magicEdenSolStats({ symbol: "mad_lads" }, opts);
    return {
      ok: true,
      provider: "magiceden-sol",
      keyed: Boolean(apiKey(opts)),
      readTier: "keyless",
      prepareTier: apiKey(opts) ? "keyed" : "requires MAGICEDEN_API_KEY",
      floorPriceSol: stats.floorPriceSol,
      exec: false,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "magiceden-sol",
      keyed: Boolean(apiKey(opts)),
      error: String(error?.message || error).slice(0, 160),
      exec: false,
    };
  }
}

export async function magicEdenSolStats(args = {}, opts = {}) {
  const symbol = symbolArg(args.symbol || args.collection);
  const raw = await httpJson(`${base(opts)}/collections/${encodeURIComponent(symbol)}/stats`, {
    headers: headers(opts),
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 12_000,
  });
  const floorLamports = Number(raw?.floorPrice ?? 0);
  return {
    provider: "magiceden-sol",
    chain: "solana-mainnet-beta",
    symbol,
    floorPriceLamports: floorLamports || null,
    floorPriceSol: floorLamports ? floorLamports / LAMPORTS_PER_SOL : null,
    listedCount: raw?.listedCount ?? null,
    volume24hrSol: raw?.volume24hr != null ? Number(raw.volume24hr) / LAMPORTS_PER_SOL : null,
    avgPrice24hrSol: raw?.avgPrice24hr != null ? Number(raw.avgPrice24hr) / LAMPORTS_PER_SOL : null,
    exec: false,
    raw,
  };
}

function normalizeListing(item = {}) {
  const priceSol = Number(item.price ?? 0);
  return {
    tokenMint: item.tokenMint ?? null,
    tokenATA: item.tokenAddress ?? null,
    seller: item.seller ?? null,
    sellerReferral: item.sellerReferral ?? null,
    auctionHouse: item.auctionHouse ?? null,
    pdaAddress: item.pdaAddress ?? null,
    priceSol: priceSol || null,
    priceLamports: priceSol ? Math.round(priceSol * LAMPORTS_PER_SOL) : null,
    tokenSize: item.tokenSize ?? 1,
  };
}

export async function magicEdenSolListings(args = {}, opts = {}) {
  const symbol = symbolArg(args.symbol || args.collection);
  const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
  const offset = Math.max(Number(args.offset ?? 0) || 0, 0);
  const url = new URL(`${base(opts)}/collections/${encodeURIComponent(symbol)}/listings`);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("limit", String(limit));
  if (args.sort) url.searchParams.set("sort", String(args.sort));
  const raw = await httpJson(url.toString(), {
    headers: headers(opts),
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 12_000,
  });
  const listings = (Array.isArray(raw) ? raw : []).map(normalizeListing);
  return {
    provider: "magiceden-sol",
    chain: "solana-mainnet-beta",
    symbol,
    count: listings.length,
    listings,
    exec: false,
  };
}

export async function magicEdenSolTokenListing(args = {}, opts = {}) {
  const mint = solanaPubkey(args.tokenMint || args.mint, "tokenMint");
  const raw = await httpJson(`${base(opts)}/tokens/${encodeURIComponent(mint)}/listings`, {
    headers: headers(opts),
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 12_000,
  });
  const listings = (Array.isArray(raw) ? raw : []).map(normalizeListing);
  return { provider: "magiceden-sol", chain: "solana-mainnet-beta", tokenMint: mint, listings, exec: false };
}

/**
 * Build an UNSIGNED buy_now transaction for a listed Solana NFT.
 * Requires MAGICEDEN_API_KEY. Returns base64 tx for the user's wallet.
 */
export async function magicEdenSolPrepareBuy(args = {}, opts = {}) {
  if (!apiKey(opts)) throw new Error("magiceden: MAGICEDEN_API_KEY required to build a buy instruction");
  const buyer = solanaPubkey(args.buyer || args.userPublicKey, "buyer");
  const seller = solanaPubkey(args.seller, "seller");
  const tokenMint = solanaPubkey(args.tokenMint, "tokenMint");
  const tokenATA = solanaPubkey(args.tokenATA || args.tokenAddress, "tokenATA");
  const auctionHouse = solanaPubkey(args.auctionHouse, "auctionHouse");
  const priceSol = positiveNumber(args.priceSol ?? args.price, "priceSol");
  const maxPriceSol = args.maxPriceSol == null ? priceSol : positiveNumber(args.maxPriceSol, "maxPriceSol");
  if (priceSol > maxPriceSol) {
    throw new Error(`magiceden: listing price ${priceSol} SOL exceeds maxPriceSol cap ${maxPriceSol} SOL`);
  }
  const url = new URL(`${base(opts)}/instructions/buy_now`);
  url.searchParams.set("buyer", buyer);
  url.searchParams.set("seller", seller);
  url.searchParams.set("auctionHouseAddress", auctionHouse);
  url.searchParams.set("tokenMint", tokenMint);
  url.searchParams.set("tokenATA", tokenATA);
  url.searchParams.set("price", String(priceSol));
  if (args.sellerReferral) url.searchParams.set("sellerReferral", String(args.sellerReferral));
  if (args.buyerReferral) url.searchParams.set("buyerReferral", String(args.buyerReferral));
  const raw = await httpJson(url.toString(), {
    headers: headers(opts),
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
  // Refuse pre-signed material by PRESENCE, before selecting unsigned bytes.
  // A mixed payload (valid unsigned bytes plus a signed sibling) previously
  // skipped this check entirely and bound the signed field into the envelope.
  assertNoSignedMaterial("magiceden", raw);
  const data = raw?.v0?.tx?.data ?? raw?.tx?.data ?? null;
  // Accept ONLY the documented unsigned instruction field. A pre-signed payload
  // (txSigned) from a compromised or impersonated API must never be laundered
  // into a "prepare" result — the user would be signing bytes Oracle never
  // validated against the price cap.
  if (!Array.isArray(data)) {
    if (raw?.txSigned) throw new Error("magiceden: refused a pre-signed transaction payload from the API");
    throw new Error("magiceden: buy_now returned no unsigned transaction payload");
  }
  const transaction = Buffer.from(data).toString("base64");
  return stampPrepared({
    provider: "magiceden-sol",
    chain: "solana-mainnet-beta",
    kind: "nft-buy",
    prepareReady: true,
    executionReady: false,
    signingReady: false,
    broadcastReady: false,
    requiresUserSignature: true,
    buyer,
    seller,
    tokenMint,
    priceSol,
    maxPriceSol,
    lamports: lamports(priceSol),
    transaction,
    transactionEncoding: "base64",
    raw,
  });
}

/**
 * Build an UNSIGNED list instruction so a holder can list their own NFT.
 * Requires MAGICEDEN_API_KEY. User wallet signs; Oracle never broadcasts.
 */
export async function magicEdenSolPrepareList(args = {}, opts = {}) {
  if (!apiKey(opts)) throw new Error("magiceden: MAGICEDEN_API_KEY required to build a list instruction");
  const seller = solanaPubkey(args.seller || args.userPublicKey, "seller");
  const tokenMint = solanaPubkey(args.tokenMint, "tokenMint");
  const tokenATA = solanaPubkey(args.tokenATA || args.tokenAddress, "tokenATA");
  const auctionHouse = solanaPubkey(args.auctionHouse, "auctionHouse");
  const priceSol = positiveNumber(args.priceSol ?? args.price, "priceSol");
  const expiry = listingExpiry(args.expiry);
  const confirmation = requireListingConfirmation(args, { tokenMint, priceSol, expiry });
  const url = new URL(`${base(opts)}/instructions/sell`);
  url.searchParams.set("seller", seller);
  url.searchParams.set("auctionHouseAddress", auctionHouse);
  url.searchParams.set("tokenMint", tokenMint);
  url.searchParams.set("tokenAccount", tokenATA);
  url.searchParams.set("price", String(priceSol));
  if (args.sellerReferral) url.searchParams.set("sellerReferral", solanaPubkey(args.sellerReferral, "sellerReferral"));
  if (expiry != null) url.searchParams.set("expiry", String(expiry));
  const raw = await httpJson(url.toString(), {
    headers: headers(opts),
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
  // Refuse pre-signed material by PRESENCE, before selecting unsigned bytes.
  // A mixed payload (valid unsigned bytes plus a signed sibling) previously
  // skipped this check entirely and bound the signed field into the envelope.
  assertNoSignedMaterial("magiceden", raw);
  const data = raw?.v0?.tx?.data ?? raw?.tx?.data ?? null;
  if (!Array.isArray(data)) {
    if (raw?.txSigned) throw new Error("magiceden: refused a pre-signed transaction payload from the API");
    throw new Error("magiceden: sell returned no unsigned transaction payload");
  }
  const transaction = Buffer.from(data).toString("base64");
  return stampPrepared({
    provider: "magiceden-sol",
    chain: "solana-mainnet-beta",
    kind: "nft-list",
    prepareReady: true,
    executionReady: false,
    signingReady: false,
    broadcastReady: false,
    requiresUserSignature: true,
    seller,
    tokenMint,
    priceSol,
    expiry,
    confirmation,
    transaction,
    transactionEncoding: "base64",
    raw,
  });
}

/**
 * Launchpad mint instruction. Requires MAGICEDEN_API_KEY. Unsigned only.
 */
export async function magicEdenSolPrepareMint(args = {}, opts = {}) {
  if (!apiKey(opts)) throw new Error("magiceden: MAGICEDEN_API_KEY required to build a mint instruction");
  const buyer = solanaPubkey(args.buyer || args.userPublicKey, "buyer");
  const symbol = symbolArg(args.symbol || args.collection);
  // A mint debits the buyer, so the cap is mandatory. Recording it without
  // enforcing it is worse than having none: the caller believes a ceiling held.
  if (args.maxPriceSol == null) {
    throw new Error("magiceden: maxPriceSol is required to prepare a mint — an uncapped mint has no spend ceiling");
  }
  const maxPriceSol = positiveNumber(args.maxPriceSol, "maxPriceSol");
  const nftAmount = args.nftAmount == null ? 1 : positiveNumber(args.nftAmount, "nftAmount");
  if (!Number.isInteger(nftAmount)) throw new Error("magiceden: nftAmount must be a whole number");

  const url = new URL(`${base(opts)}/instructions/mint`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("wallet", buyer);
  url.searchParams.set("nftAmount", String(nftAmount));
  const raw = await httpJson(url.toString(), {
    headers: headers(opts),
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });

  // Enforce the cap against the price the launchpad actually quotes. If the
  // price cannot be determined, fail closed rather than return an unbounded
  // mint the caller thinks is capped.
  const quoted = mintPriceSol(raw);
  if (quoted == null) {
    throw new Error("magiceden: mint price not present in the API response — refusing to prepare an unverifiable spend");
  }
  const totalSol = quoted * nftAmount;
  if (totalSol > maxPriceSol) {
    throw new Error(
      `magiceden: mint cost ${totalSol} SOL exceeds maxPriceSol cap ${maxPriceSol} SOL`
    );
  }

  // Refuse pre-signed material by PRESENCE, before selecting unsigned bytes.
  // A mixed payload (valid unsigned bytes plus a signed sibling) previously
  // skipped this check entirely and bound the signed field into the envelope.
  assertNoSignedMaterial("magiceden", raw);
  const data = raw?.v0?.tx?.data ?? raw?.tx?.data ?? null;
  if (!Array.isArray(data)) {
    if (raw?.txSigned) throw new Error("magiceden: refused a pre-signed transaction payload from the API");
    throw new Error("magiceden: mint returned no unsigned transaction payload");
  }
  const transaction = Buffer.from(data).toString("base64");
  return stampPrepared({
    provider: "magiceden-sol",
    chain: "solana-mainnet-beta",
    kind: "nft-mint",
    prepareReady: true,
    executionReady: false,
    signingReady: false,
    broadcastReady: false,
    requiresUserSignature: true,
    buyer,
    symbol,
    nftAmount,
    priceSol: quoted,
    totalSol,
    maxPriceSol,
    transaction,
    transactionEncoding: "base64",
    raw,
  });
}
