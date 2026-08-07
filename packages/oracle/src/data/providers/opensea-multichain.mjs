// OpenSea multi-chain NFT scanner.
//
// OpenSea v2 indexes NFTs across every chain it supports, keyed by a chain slug.
// This module is the ONE place Oracle resolves an NFT contract on ANY chain, so
// a user can paste a bare contract address and get back what it actually is
// before deciding to buy.
//
// Reads only. Nothing here signs or broadcasts.

import { httpJson } from "../http.mjs";

// OpenSea chain slugs -> EVM chainId. The slug is what the v2 API wants in the
// path; the chainId is what the rest of Oracle speaks.
export const OPENSEA_CHAINS = Object.freeze({
  ethereum: 1,
  matic: 137,
  base: 8453,
  arbitrum: 42161,
  arbitrum_nova: 42170,
  optimism: 10,
  avalanche: 43114,
  klaytn: 8217,
  zora: 7777777,
  blast: 81457,
  sei: 1329,
  b3: 8333,
  ape_chain: 33139,
  ronin: 2020,
  soneium: 1868,
  unichain: 130,
  berachain: 80094,
  flow: 747,
  abstract: 2741,
  gravity: 1625,
  xai: 660279,
  bsc: 56,
  solana: null, // non-EVM; OpenSea indexes it but there is no chainId
});

export const CHAIN_ID_TO_OPENSEA = Object.freeze(
  Object.fromEntries(
    Object.entries(OPENSEA_CHAINS)
      .filter(([, id]) => id != null)
      .map(([slug, id]) => [id, slug])
  )
);

/** All chains Oracle can scan for NFTs. */
export function openseaSupportedChains() {
  return Object.entries(OPENSEA_CHAINS).map(([slug, chainId]) => ({ slug, chainId }));
}

export function openseaChainSlug(chain) {
  if (chain == null) return null;
  const text = String(chain).trim().toLowerCase();
  if (OPENSEA_CHAINS[text] !== undefined) return text;
  const asId = Number(text);
  if (Number.isFinite(asId) && CHAIN_ID_TO_OPENSEA[asId]) return CHAIN_ID_TO_OPENSEA[asId];
  throw new Error(`opensea: unsupported chain ${chain} — try one of: ${Object.keys(OPENSEA_CHAINS).slice(0, 8).join(", ")}…`);
}

function evmContract(value) {
  const text = String(value ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new Error("opensea: contract must be a 0x-prefixed 20-byte address");
  return text.toLowerCase();
}

/**
 * Resolve a bare contract address on ONE chain.
 * Returns null when the chain has no such collection, so callers can fan out.
 */
export async function openseaContractOnChain(contract, chain, { headers, base, fetchImpl, timeoutMs } = {}) {
  const slug = openseaChainSlug(chain);
  const address = evmContract(contract);
  try {
    const raw = await httpJson(`${base}/chain/${slug}/contract/${address}`, {
      headers,
      fetchImpl,
      timeoutMs: timeoutMs ?? 12_000,
    });
    if (!raw || !raw.collection) return null;
    return {
      chain: slug,
      chainId: OPENSEA_CHAINS[slug],
      contract: address,
      collection: raw.collection,
      name: raw.name ?? null,
      tokenStandard: raw.contract_standard ?? raw.token_standard ?? null,
      supply: raw.supply ?? null,
    };
  } catch (err) {
    // 400/404 simply means "not on this chain" during a fan-out.
    const status = err?.status;
    if (status === 400 || status === 404) return null;
    throw err;
  }
}

/**
 * Find which chain(s) a contract address lives on.
 *
 * Someone pasting an address rarely knows the chain, and guessing wrong is how
 * people buy the wrong asset. Scan the supported set and report every hit.
 */
export async function openseaFindContract(args = {}, ctx = {}) {
  const address = evmContract(args.contract || args.address);
  const chains = args.chains
    ? args.chains.map(openseaChainSlug)
    : Object.entries(OPENSEA_CHAINS)
        .filter(([, id]) => id != null)
        .map(([slug]) => slug);

  const results = [];
  const concurrency = Math.max(1, Math.min(Number(args.concurrency) || 6, 12));
  let cursor = 0;
  async function worker() {
    while (cursor < chains.length) {
      const slug = chains[cursor++];
      try {
        const hit = await openseaContractOnChain(address, slug, ctx);
        if (hit) results.push(hit);
      } catch {
        /* one chain failing must not abort the scan */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chains.length) }, worker));

  return {
    provider: "opensea",
    contract: address,
    chainsScanned: chains.length,
    found: results.length,
    matches: results.sort((a, b) => a.chain.localeCompare(b.chain)),
  };
}
