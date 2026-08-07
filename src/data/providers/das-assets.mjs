// Digital Asset Standard (DAS) — compressed NFT reads via public Solana RPC.
// No Helius API key needed. Uses the standard Metaplex DAS JSON-RPC methods.

import { httpJson } from "../http.mjs";

export const SOLANA_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

function rpcUrl(opts = {}) {
  return (opts.rpcUrl || process.env.SOLANA_RPC_URL || SOLANA_MAINNET_RPC).replace(/\/$/, "");
}

async function dasRpc(method, params, opts = {}) {
  const url = rpcUrl(opts);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  const json = await res.json();
  if (json.error) throw new Error(`das-assets ${method}: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}

export async function dasHealth(opts = {}) {
  try {
    const result = await dasRpc("getAsset", { id: "12He3nqt2XLbpuWGdwsJBNcomm7r3M8Kh6Dj9w7ZAK9" }, opts);
    return { ok: result && typeof result === "object", provider: "das-assets" };
  } catch (e) {
    return { ok: false, provider: "das-assets", error: String(e.message || e).slice(0, 120) };
  }
}

export async function dasAssetsByOwner(args = {}, opts = {}) {
  const owner = String(args.ownerAddress || "").trim();
  if (!owner) throw new Error("das-assets: ownerAddress is required");
  const page = Math.max(1, Number(args.page || 1));
  const limit = Math.min(1000, Math.max(1, Number(args.limit || 50)));
  return dasRpc("getAssetsByOwner", { ownerAddress: owner, page, limit, ...(args.sortBy ? { sortBy: { sortBy: args.sortBy, sortDirection: args.sortDirection || "asc" } } : {}) }, opts);
}

export async function dasSearchAssets(args = {}, opts = {}) {
  const page = Math.max(1, Number(args.page || 1));
  const limit = Math.min(100, Math.max(1, Number(args.limit || 20)));
  const params = { page, limit };
  if (args.ownerAddress) params.ownerAddress = String(args.ownerAddress);
  if (args.collectionId) params.collectionId = String(args.collectionId);
  if (args.creatorAddress) params.creatorAddress = String(args.creatorAddress);
  if (args.delegate) params.delegate = String(args.delegate);
  return dasRpc("searchAssets", params, opts);
}

export async function dasAssetProof(args = {}, opts = {}) {
  const id = String(args.assetId || "").trim();
  if (!id) throw new Error("das-assets: assetId is required");
  return dasRpc("getAssetProof", { id }, opts);
}
