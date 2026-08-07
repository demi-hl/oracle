import { dataCatalog, dataHealth } from "./desk-data.mjs";

export const COVERED_CHAINS = Object.freeze({
  1: "Ethereum",
  10: "Optimism",
  56: "BNB Chain",
  137: "Polygon",
  988: "Stable",
  999: "HyperEVM",
  2741: "Abstract",
  4663: "Robinhood Chain",
  8453: "Base",
  42161: "Arbitrum",
  43114: "Avalanche",
});

function providerStatus(record) {
  if (!record) return "not-probed";
  if (!record.ok) return "down";
  if (record.detail?.configured === false) return "key-missing";
  if (record.detail?.ok === false) return "degraded";
  return "healthy";
}

export function buildPublicApiCoverage(catalog, health) {
  const globals = catalog.filter((p) => !p.chainIds.length).map((p) => p.id);
  const providers = Object.fromEntries(catalog.map((p) => [p.id, {
    venue: p.venue,
    auth: p.auth,
    chainIds: p.chainIds,
    ops: p.ops,
    description: p.description,
    status: providerStatus(health?.providers?.[p.id]),
    probe: health?.providers?.[p.id] || null,
  }]));
  const chains = {};
  for (const [chainId, name] of Object.entries(COVERED_CHAINS)) {
    const id = Number(chainId);
    const explicit = catalog.filter((p) => p.chainIds.includes(id)).map((p) => p.id);
    chains[chainId] = {
      name,
      providers: [...new Set([...globals, ...explicit])],
      explicitProviders: explicit,
      failClosed: explicit.length === 0,
    };
  }
  return {
    generatedAt: health?.when || new Date().toISOString(),
    coveredChainCount: Object.keys(COVERED_CHAINS).length,
    providerCount: catalog.length,
    globals,
    chains,
    providers,
  };
}

export async function scanPublicApis({ providers, timeoutMs = 12_000 } = {}) {
  const catalog = dataCatalog();
  const health = await dataHealth({ providers, timeoutMs });
  return buildPublicApiCoverage(catalog, health);
}
