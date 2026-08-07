// Satflow Marketplace API — Bitcoin ordinals + runes market plane.
// Docs: https://docs.satflow.com  Base: https://api.satflow.com/v1
// Auth: x-api-key header (SATFLOW_API_KEY).
//
// Magic Eden BTC marketplace is DEAD (sunset 2026). Satflow docs mark
// magiceden external intents deprecated/blocked. Do not use ME for ordinals.

import { btcAddress } from "./bitcoin-esplora.mjs";
import { resolveProviderEndpoint, credentialedHeaders } from "../provider-endpoint.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";
import { assertNoSignedMaterial } from "./signed-material-guard.mjs";

export const SATFLOW_BASE = "https://api.satflow.com/v1";

function endpoint(opts = {}) {
  return resolveProviderEndpoint({
    provider: "satflow",
    defaultUrl: SATFLOW_BASE,
    hosts: ["api.satflow.com"],
    url: opts.baseUrl || process.env.SATFLOW_API_URL,
  });
}

function baseUrl(opts = {}) {
  return endpoint(opts).baseUrl;
}

function apiKey(opts = {}) {
  return String(opts.apiKey || process.env.SATFLOW_API_KEY || process.env.BTC_SATFLOW_API_KEY || "").trim();
}

function headers(opts = {}) {
  // The API key travels ONLY to a pinned Satflow host. Redirecting baseUrl
  // elsewhere drops the credential instead of forwarding it.
  return credentialedHeaders(
    {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "oracle-btc-satflow/0.1",
    },
    { "x-api-key": apiKey(opts) },
    endpoint(opts).trusted
  );
}

async function sfFetch(path, { method = "GET", body, opts = {} } = {}) {
  const key = apiKey(opts);
  if (!key) {
    throw new Error("satflow: SATFLOW_API_KEY not set (request key via Satflow docs form)");
  }
  const url = `${baseUrl(opts)}${path.startsWith("/") ? path : `/${path}`}`;
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl(url, {
    method,
    headers: headers(opts),
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`satflow ${method} ${path}: HTTP ${res.status} ${String(text).slice(0, 200)}`);
  }
  return data;
}

export async function satflowHealth(opts = {}) {
  const keyPresent = Boolean(apiKey(opts));
  if (!keyPresent) {
    return {
      ok: false,
      provider: "satflow",
      baseUrl: baseUrl(opts),
      apiKeyPresent: false,
      marketplace: "satflow",
      magicEdenOrdinals: "deprecated-dead",
      note: "Set SATFLOW_API_KEY. Magic Eden BTC ordinals marketplace is shut down — do not use ME.",
    };
  }
  try {
    // lightweight authenticated probe
    await sfFetch("/collection/stats/floors?type=ordinals", { opts });
    return {
      ok: true,
      provider: "satflow",
      baseUrl: baseUrl(opts),
      apiKeyPresent: true,
      marketplace: "satflow",
      magicEdenOrdinals: "deprecated-dead",
      capabilities: {
        floors: true,
        walletContents: true,
        purchaseIntent: true,
        listIntent: true,
        bidIntent: true,
      },
    };
  } catch (e) {
    return {
      ok: false,
      provider: "satflow",
      baseUrl: baseUrl(opts),
      apiKeyPresent: true,
      error: String(e?.message || e).slice(0, 200),
      magicEdenOrdinals: "deprecated-dead",
    };
  }
}

/** Collection floor stats. type: ordinals | runes */
export async function satflowCollectionFloors(args = {}, opts = {}) {
  const type = String(args.type || "ordinals").toLowerCase();
  if (!["ordinals", "runes"].includes(type)) throw new Error("satflow: type must be ordinals|runes");
  const q = new URLSearchParams({ type });
  if (args.ids) q.set("ids", Array.isArray(args.ids) ? args.ids.join(",") : String(args.ids));
  const data = await sfFetch(`/collection/stats/floors?${q}`, { opts });
  return { provider: "satflow", type, floors: data, magicEdenOrdinals: "deprecated-dead" };
}

export async function satflowCollectionStats(args = {}, opts = {}) {
  const id = String(args.collectionId || args.id || args.slug || "").trim();
  if (!id) throw new Error("satflow: collectionId required");
  const q = new URLSearchParams({ id });
  if (args.type) q.set("type", args.type);
  const data = await sfFetch(`/collection/stats?${q}`, { opts });
  return { provider: "satflow", collectionId: id, stats: data };
}

export async function satflowItem(args = {}, opts = {}) {
  const id = String(args.inscriptionId || args.id || "").trim();
  if (!id) throw new Error("satflow: inscriptionId required");
  const q = new URLSearchParams({ id });
  const data = await sfFetch(`/item?${q}`, { opts });
  return { provider: "satflow", item: data };
}

export async function satflowWalletContents(args = {}, opts = {}) {
  const address = btcAddress(args.address || args.addr, "address");
  const q = new URLSearchParams({ address });
  if (args.type) q.set("type", args.type);
  if (args.limit != null) q.set("limit", String(args.limit));
  if (args.offset != null) q.set("offset", String(args.offset));
  const data = await sfFetch(`/address/wallet-contents?${q}`, { opts });
  return { provider: "satflow", address, contents: data };
}

export async function satflowFloorListings(args = {}, opts = {}) {
  const ids = args.collectionIds || args.ids || args.collectionId;
  if (!ids) throw new Error("satflow: collectionIds required");
  const q = new URLSearchParams({
    ids: Array.isArray(ids) ? ids.join(",") : String(ids),
  });
  if (args.limit != null) q.set("limit", String(args.limit));
  const data = await sfFetch(`/orders/floor?${q}`, { opts });
  return { provider: "satflow", listings: data };
}

// Oracle-internal keys that must never be forwarded to the marketplace.
const SATFLOW_INTERNAL_KEYS = new Set([
  "body",
  "execute",
  "fetchImpl",
  "opts",
  "apiKey",
  "baseUrl",
  "timeoutMs",
  "maxSats",
  "operator",
]);

/**
 * Build an outbound Satflow body from caller args.
 *
 * Spreading `...args` straight into a third-party request is how Oracle-internal
 * control fields (and anything a prompt-injected model appends) leak to an
 * external venue. Only explicitly-named fields cross the boundary.
 */
function satflowBody(args = {}, allowed = null) {
  // The `body` branch used to return the caller's object wholesale after
  // stripping internal names, which meant the field allowlist below was never
  // consulted for it. A prompt-injected model could then put an arbitrary
  // payload — including a swapped buyer/receive address — into a marketplace
  // intent the user is asked to sign. Both branches now go through the SAME
  // allowlist.
  const source = args.body && typeof args.body === "object" ? args.body : args;
  const out = {};
  for (const [k, v] of Object.entries(source)) {
    if (SATFLOW_INTERNAL_KEYS.has(k)) continue;
    if (allowed && !allowed.has(k)) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

const SATFLOW_PURCHASE_FIELDS = new Set([
  "listing_id",
  "listingId",
  "inscription_id",
  "inscriptionId",
  "runes_output",
  "runesOutput",
  "buyer_address",
  "buyerAddress",
  "ord_address",
  "receive_address",
  "payment_address",
  "pay_address",
  "tap_key",
  "public_key",
  "publicKey",
  "fee_rate",
  "feeRate",
  "price",
  "quantity",
  "slug",
  "collection_slug",
]);

const SATFLOW_LIST_FIELDS = new Set([
  "inscription_id",
  "inscriptionId",
  "runes_output",
  "runesOutput",
  "ord_address",
  "receive_address",
  "price",
  "tap_key",
  "collection_slug",
  "expires_at",
]);

/**
 * Create unsigned PSBT for buying on Satflow.
 * Returns PSBT for wallet/local sign — does not broadcast.
 */
/**
 * Pull an authoritative sat price out of a Satflow body or intent response.
 * Returns null when no price can be determined, so callers fail closed.
 */
function purchasePriceSats(obj) {
  if (!obj || typeof obj !== "object") return null;
  const candidates = [
    obj.price,
    obj.priceSats,
    obj.price_sats,
    obj.totalSats,
    obj.total_sats,
    obj.amount,
    obj.satoshis,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    const text = String(c).trim();
    if (!/^\d+$/.test(text)) continue;
    return BigInt(text);
  }
  return null;
}

export async function satflowPreparePurchase(args = {}, opts = {}) {
  const body = satflowBody(args, SATFLOW_PURCHASE_FIELDS);
  if (!body || Object.keys(body).length === 0) {
    throw new Error("satflow: purchase body required (see docs.satflow.com intent/satflow-purchase)");
  }

  // maxSats is a SPEND CEILING, and it was previously stripped as an internal
  // field and then never compared to anything — the caller believed a cap was
  // in force while the returned PSBT could pay any price. Require it, and
  // enforce it against the authoritative price on the intent Satflow returns,
  // not just the price the caller asked for.
  const rawMax = args.maxSats ?? args.body?.maxSats;
  if (rawMax == null) {
    throw new Error("satflow: maxSats is required to prepare a purchase — an uncapped buy has no spend ceiling");
  }
  const maxSats = BigInt(String(rawMax).trim());
  if (maxSats <= 0n) throw new Error("satflow: maxSats must be a positive integer sat amount");

  const requested = purchasePriceSats(body);
  if (requested != null && requested > maxSats) {
    throw new Error(`satflow: requested price ${requested} sats exceeds maxSats cap ${maxSats}`);
  }

  const data = await sfFetch("/intent/satflow-purchase", { method: "POST", body, opts });

  const settled = purchasePriceSats(data) ?? purchasePriceSats(data?.intent);
  if (settled == null) {
    throw new Error("satflow: purchase intent did not report a price — refusing to return an unverifiable PSBT");
  }
  if (settled > maxSats) {
    throw new Error(`satflow: purchase price ${settled} sats exceeds maxSats cap ${maxSats} — PSBT withheld`);
  }

  assertNoSignedMaterial("satflow", data);

  return stampPrepared({
    provider: "satflow",
    kind: "purchase-intent",
    executionReady: false,
    signingReady: false,
    broadcastReady: false,
    requiresUserSignature: true,
    marketplace: "satflow",
    magicEdenOrdinals: "deprecated-dead",
    priceSats: settled.toString(),
    maxSats: maxSats.toString(),
    intent: data,
    // common field names across versions
    unsignedPsbt:
      data?.unsignedPSBTBase64 ||
      data?.unsignedPsbtBase64 ||
      data?.unsigned_psbt ||
      null,
    note: "Sign PSBT in a Bitcoin wallet. Broadcast only through the user's wallet or an explicitly armed Bitcoin execution plane.",
  });
}

/** List intent — unsigned listing PSBTs */
export async function satflowPrepareList(args = {}, opts = {}) {
  const body = satflowBody(args, SATFLOW_LIST_FIELDS);
  if (!body.inscription_id && !body.runes_output && !body.inscriptionId && !body.runesOutput) {
    throw new Error("satflow: list requires inscription_id or runes_output");
  }
  const data = await sfFetch("/intent/sell", { method: "POST", body, opts });
  assertNoSignedMaterial("satflow", data);
  return stampPrepared({
    provider: "satflow",
    kind: "list-intent",
    requiresUserSignature: true,
    marketplace: "satflow",
    listingRequest: body,
    intent: data,
    unsignedPsbt: data?.unsignedListingPSBTBase64 || data?.unsigned_psbt || null,
    note: "Sign listing PSBTs in a Bitcoin wallet; listing broadcast is outside the data plane.",
  });
}
