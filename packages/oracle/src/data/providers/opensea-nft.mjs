// OpenSea NFT floors — uses OPENSEA_API_KEY from env or ~/.config/locals-only/opensea.env

import { readFileSync, existsSync } from "node:fs";
import { getAddress } from "ethers";
import { httpJson } from "../http.mjs";
import { resolveProviderEndpoint, credentialedHeaders } from "../provider-endpoint.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";

export const OPENSEA_API = "https://api.opensea.io/api/v2";

export const OPENSEA_ACCOUNT_CHAINS = Object.freeze([
  "blast",
  "base",
  "ethereum",
  "zora",
  "arbitrum",
  "sei",
  "avalanche",
  "polygon",
  "optimism",
  "ape_chain",
  "flow",
  "b3",
  "soneium",
  "ronin",
  "bera_chain",
  "solana",
  "shape",
  "unichain",
  "gunzilla",
  "abstract",
  "animechain",
  "hyperevm",
  "somnia",
  "monad",
  "hyperliquid",
  "megaeth",
  "ink",
  "robinhood",
  "stablechain",
]);

const OPENSEA_CHAIN_SET = new Set(OPENSEA_ACCOUNT_CHAINS);
const OPENSEA_NON_EVM_CHAINS = new Set(["solana", "flow"]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function loadKeyFromDisk() {
  const p = process.env.OPENSEA_ENV_FILE || `${process.env.HOME || ""}/.config/locals-only/opensea.env`;
  if (!existsSync(p)) return "";
  try {
    for (const ln of readFileSync(p, "utf8").split("\n")) {
      const m = ln.match(/^\s*OPENSEA_API_KEY\s*=\s*(.+)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, "").trim();
    }
  } catch {
    /* ignore */
  }
  return "";
}

function apiKey(opts = {}) {
  return opts.apiKey || process.env.OPENSEA_API_KEY || process.env.OPEN_SEA_API_KEY || loadKeyFromDisk();
}

function endpoint(opts = {}) {
  return resolveProviderEndpoint({
    provider: "opensea",
    defaultUrl: OPENSEA_API,
    hosts: ["api.opensea.io", "testnets-api.opensea.io"],
    url: opts.baseUrl || process.env.OPENSEA_API_URL,
  });
}

function base(opts = {}) {
  return endpoint(opts).baseUrl;
}

function headers(opts = {}) {
  // x-api-key is attached only for a pinned OpenSea host.
  return credentialedHeaders({ accept: "application/json" }, { "x-api-key": apiKey(opts) }, endpoint(opts).trusted);
}

function accountChain(value) {
  const chain = String(value || "ethereum").trim().toLowerCase();
  if (!OPENSEA_CHAIN_SET.has(chain)) throw new Error(`opensea: unsupported account chain ${chain}`);
  return chain;
}

function evmAddress(value, label = "address") {
  try {
    return getAddress(String(value || "").trim().toLowerCase());
  } catch {
    throw new Error(`opensea: invalid ${label}`);
  }
}

function accountAddress(value, chain = null) {
  const address = String(value || "").trim();
  if (!address) throw new Error("opensea: account address required");
  if (chain && !OPENSEA_NON_EVM_CHAINS.has(chain)) return evmAddress(address, "account address");
  if (!chain && /^0x[0-9a-fA-F]{40}$/.test(address)) return evmAddress(address, "account address");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(address)) throw new Error("opensea: invalid account address");
  return address;
}

function positiveDecimal(value, label) {
  const text = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) || Number(text) <= 0) {
    throw new Error(`opensea: ${label} must be a positive plain decimal`);
  }
  return text;
}

function positiveInteger(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`opensea: ${label} must be a positive integer`);
  return n;
}

function isoTime(value, label) {
  const text = String(value || "").trim();
  const ms = Date.parse(text);
  if (!text || !Number.isFinite(ms)) throw new Error(`opensea: ${label} must be an ISO 8601 timestamp`);
  return { text: new Date(ms).toISOString(), ms };
}

function normalizeAccountNft(raw = {}, chain, owner) {
  return {
    chain,
    owner,
    contract: raw.contract || null,
    tokenId: raw.identifier == null ? null : String(raw.identifier),
    tokenStandard: raw.token_standard || null,
    collection: raw.collection || null,
    name: raw.name || null,
    description: raw.description || null,
    imageUrl: raw.display_image_url || raw.image_url || raw.original_image_url || null,
    originalImageUrl: raw.original_image_url || raw.image_url || null,
    animationUrl: raw.display_animation_url || raw.original_animation_url || null,
    metadataUrl: raw.metadata_url || null,
    marketplaceUrl: raw.opensea_url || null,
    estimatedValueUsd: raw.estimated_value_usd != null && Number.isFinite(Number(raw.estimated_value_usd))
      ? Number(raw.estimated_value_usd)
      : null,
    spam: raw.is_disabled === true || raw.is_nsfw === true,
    disabled: raw.is_disabled === true,
    nsfw: raw.is_nsfw === true,
    traits: Array.isArray(raw.traits) ? raw.traits : [],
    updatedAt: raw.updated_at || null,
    acquisitionCost: null,
    itemPnl: {
      status: "unavailable",
      reason: "OpenSea account inventory does not expose trustworthy per-item acquisition cost",
    },
  };
}

/** Shared request context for the multichain scanner. */
export function openseaContext(opts = {}) {
  return {
    base: base(opts),
    headers: headers(opts),
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  };
}

export async function openseaHealth(opts = {}) {
  if (!apiKey(opts)) {
    return { ok: false, configured: false, error: "OPENSEA_API_KEY not set" };
  }
  try {
    const c = await openseaCollection("boredapeyachtclub", opts);
    return { ok: true, configured: true, name: c.name || c.collection };
  } catch (e) {
    return { ok: false, configured: true, error: String(e.message || e).slice(0, 160) };
  }
}

export async function openseaCollection(slug, opts = {}) {
  if (!slug) throw new Error("collection slug required");
  if (!apiKey(opts)) throw new Error("OPENSEA_API_KEY required");
  return httpJson(`${base(opts)}/collections/${encodeURIComponent(slug)}`, {
    headers: headers(opts),
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
}

/** Best-effort floor from collection stats / collection payload. */
export async function openseaFloor(slug, opts = {}) {
  const c = await openseaCollection(slug, opts);
  const stats = c.stats || c.total || {};
  const floor =
    c.floor_price ??
    c.floorPrice ??
    stats.floor_price ??
    stats.floorPrice ??
    null;
  return {
    slug: c.collection || slug,
    name: c.name || null,
    floor,
    totalSupply: c.total_supply ?? stats.total_supply ?? null,
    numOwners: c.num_owners ?? stats.num_owners ?? null,
    raw: {
      contracts: c.contracts,
      fees: c.fees,
      category: c.category,
    },
  };
}

/** Paginated account NFT inventory for one OpenSea-supported chain. */
export async function openseaAccountNfts(args = {}, opts = {}) {
  if (!apiKey(opts)) throw new Error("OPENSEA_API_KEY required");
  const chain = accountChain(args.chain);
  const owner = accountAddress(args.address || args.owner, chain);
  const pageSize = Math.min(Math.max(Number(args.pageSize ?? args.limit ?? 200) || 200, 1), 200);
  const maxPages = Math.min(Math.max(Number(args.maxPages ?? 5) || 5, 1), 25);
  const nfts = [];
  let next = args.next ? String(args.next) : null;
  let pages = 0;

  do {
    const url = new URL(`${base(opts)}/chain/${encodeURIComponent(chain)}/account/${encodeURIComponent(owner)}/nfts`);
    url.searchParams.set("limit", String(pageSize));
    if (args.collection) url.searchParams.set("collection", String(args.collection));
    if (next) url.searchParams.set("next", next);
    const raw = await httpJson(url.toString(), {
      headers: headers(opts),
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 20_000,
    });
    for (const item of Array.isArray(raw?.nfts) ? raw.nfts : []) {
      nfts.push(normalizeAccountNft(item, chain, owner));
    }
    next = raw?.next ? String(raw.next) : null;
    pages += 1;
  } while (next && pages < maxPages);

  return {
    provider: "opensea-nft",
    source: "opensea-account-inventory",
    chain,
    owner,
    count: nfts.length,
    pages,
    complete: !next,
    next,
    nfts,
    exec: false,
    readOnly: true,
  };
}

/** OpenSea-indexed account PnL. This is account-level, not per-NFT cost basis. */
export async function openseaAccountPnl(args = {}, opts = {}) {
  if (!apiKey(opts)) throw new Error("OPENSEA_API_KEY required");
  const address = accountAddress(args.address || args.owner);
  const raw = await httpJson(`${base(opts)}/account/${encodeURIComponent(address)}/pnl`, {
    headers: headers(opts),
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
  return {
    provider: "opensea-nft",
    source: "opensea-indexed-account-pnl",
    address,
    scope: "OpenSea-indexed account trading PnL across supported currencies, not per-item NFT cost basis",
    methodology: "provider-indexed",
    realizedPnlUsd: raw?.realized_pnl_usd ?? null,
    unrealizedPnlUsd: raw?.unrealized_pnl_usd ?? null,
    totalPnlUsd: raw?.total_pnl_usd ?? null,
    netInvestedUsd: raw?.net_invested_usd ?? null,
    currentValueUsd: raw?.current_value_usd ?? null,
    returnPercentage: raw?.return_percentage ?? null,
    itemLevelPnlAvailable: false,
    raw,
    exec: false,
    readOnly: true,
  };
}

function normalizeListingItem(raw = {}) {
  const chain = accountChain(raw.chain);
  if (OPENSEA_NON_EVM_CHAINS.has(chain)) {
    throw new Error("opensea: listing actions currently require an EVM NFT chain");
  }
  const start = raw.startTime || raw.start_time
    ? isoTime(raw.startTime || raw.start_time, "startTime")
    : { text: new Date().toISOString(), ms: Date.now() };
  const end = isoTime(raw.endTime || raw.end_time, "endTime");
  if (end.ms <= start.ms) throw new Error("opensea: endTime must be after startTime");
  const tokenId = String(raw.tokenId ?? raw.token_id ?? "").trim();
  if (!/^\d+$/.test(tokenId)) throw new Error("opensea: tokenId must be an unsigned integer string");
  return {
    chain,
    contract: evmAddress(raw.contract, "NFT contract"),
    token_id: tokenId,
    quantity: positiveInteger(raw.quantity ?? 1, "quantity"),
    price: {
      amount: positiveDecimal(raw.price?.amount ?? raw.amount ?? raw.priceAmount, "price amount"),
      currency: evmAddress(raw.price?.currency ?? raw.currency ?? ZERO_ADDRESS, "price currency"),
    },
    start_time: start.text,
    end_time: end.text,
  };
}

function containsApprovalStep(steps = []) {
  return steps.some((step) => /approv|setapprovalforall/i.test(JSON.stringify(step)));
}

/**
 * Ask OpenSea for approval and Seaport signing actions. Nothing is signed,
 * submitted, or broadcast. The user's wallet handles every returned action.
 */
export async function openseaPrepareList(args = {}, opts = {}) {
  if (!apiKey(opts)) throw new Error("OPENSEA_API_KEY required");
  if (args.userConfirmed !== true) {
    throw new Error("opensea: userConfirmed=true required after NFT, marketplace, price, currency, and expiry review");
  }
  const seller = evmAddress(args.seller || args.address || args.owner, "seller");
  const sourceItems = Array.isArray(args.items) && args.items.length ? args.items : [args];
  if (sourceItems.length > 50) throw new Error("opensea: at most 50 listing items per preparation");
  const items = sourceItems.map(normalizeListingItem);
  const chains = new Set(items.map((item) => item.chain));
  if (chains.size !== 1) throw new Error("opensea: all prepared listing items must be on one chain");
  const useCreatorFee = args.useCreatorFee !== false;
  const request = {
    address: seller,
    items,
    use_creator_fee: useCreatorFee,
  };
  if (args.taker) request.taker = evmAddress(args.taker, "taker");

  const raw = await httpJson(`${base(opts)}/listings/actions`, {
    method: "POST",
    headers: headers(opts),
    body: request,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 25_000,
    retries: 0,
    dedupe: false,
  });
  const steps = Array.isArray(raw?.steps) ? raw.steps : [];
  if (!steps.length) throw new Error("opensea: listing action response contained no wallet steps");

  return stampPrepared({
    provider: "opensea-nft",
    marketplace: "opensea",
    chain: items[0].chain,
    kind: "nft-list-actions",
    prepareReady: true,
    executionReady: false,
    signingReady: false,
    broadcastReady: false,
    requiresUserSignature: true,
    requiresSeparateApproval: containsApprovalStep(steps),
    seller,
    items,
    useCreatorFee,
    taker: request.taker || null,
    feeDisclosure: useCreatorFee
      ? "Creator fees requested. Inspect the returned Seaport consideration recipients and wallet simulation before signing."
      : "Creator fees disabled by explicit request. Marketplace protocol fees may still apply and must be inspected before signing.",
    steps,
    note: "Execute approvals separately, then sign the Seaport order in the user's wallet. Oracle does not submit or broadcast the listing.",
  });
}
