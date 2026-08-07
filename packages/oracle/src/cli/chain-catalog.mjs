// Working chain surface for the oracle chat/CLI selector.
// Keys stay lowercase. Hyperliquid is the product name; HyperEVM is chain 999.

export const WORKING_CHAINS = Object.freeze([
  {
    key: "hyperliquid",
    aliases: ["hl", "hyperevm", "hype", "999"],
    chainId: 999,
    name: "hyperliquid",
    kind: "evm",
    family: "hyperliquid",
    agent: "hyperliquid-agent",
    note: "perps · hip-3/4 · hyperevm 999",
    build: true,
  },
  {
    key: "ethereum",
    aliases: ["eth", "mainnet", "1"],
    chainId: 1,
    name: "ethereum",
    kind: "evm",
    family: "evm",
    agent: "oracle",
    note: "l1 · bridge hub",
    build: true,
  },
  {
    key: "base",
    aliases: ["8453"],
    chainId: 8453,
    name: "base",
    kind: "evm",
    family: "evm",
    agent: "oracle",
    note: "evm l2",
    build: true,
  },
  {
    key: "arbitrum",
    aliases: ["arb", "42161"],
    chainId: 42161,
    name: "arbitrum",
    kind: "evm",
    family: "evm",
    agent: "oracle",
    note: "evm l2",
    build: true,
  },
  {
    key: "optimism",
    aliases: ["op", "10"],
    chainId: 10,
    name: "optimism",
    kind: "evm",
    family: "evm",
    agent: "oracle",
    note: "op mainnet",
    build: true,
  },
  {
    key: "polygon",
    aliases: ["matic", "137"],
    chainId: 137,
    name: "polygon",
    kind: "evm",
    family: "evm",
    agent: "oracle",
    note: "evm l2",
    build: true,
  },
  {
    key: "bsc",
    aliases: ["bnb", "56"],
    chainId: 56,
    name: "bnb chain",
    kind: "evm",
    family: "evm",
    agent: "oracle",
    note: "bsc",
    build: true,
  },
  {
    key: "avalanche",
    aliases: ["avax", "43114"],
    chainId: 43114,
    name: "avalanche",
    kind: "evm",
    family: "evm",
    agent: "oracle",
    note: "c-chain",
    build: true,
  },
  {
    key: "abstract",
    aliases: ["abs", "2741"],
    chainId: 2741,
    name: "abstract",
    kind: "evm",
    family: "evm",
    agent: "oracle",
    note: "open / add agent",
    build: true,
  },
  {
    key: "stable",
    aliases: ["988"],
    chainId: 988,
    name: "stable",
    kind: "evm",
    family: "stable",
    agent: "stable-agent",
    note: "usdt0 gas · stable agent",
    build: true,
  },
  {
    key: "robinhood",
    aliases: ["rh", "4663"],
    chainId: 4663,
    name: "robinhood",
    kind: "evm",
    family: "robinhood",
    agent: "robinhood-agent",
    note: "rh chain 4663",
    build: true,
  },
  {
    key: "solana",
    aliases: ["sol"],
    chainId: "SOL",
    name: "solana",
    kind: "svm",
    family: "solana",
    agent: "solana-agent",
    note: "jup · nfts · dexs",
    build: true,
  },
  {
    key: "bitcoin",
    aliases: ["btc"],
    chainId: "BTC",
    name: "bitcoin",
    kind: "utxo",
    family: "bitcoin",
    agent: "bitcoin-agent",
    note: "ord · runes · l1",
    build: true,
  },
  {
    key: "polymarket",
    aliases: ["poly", "polygon-poly"],
    chainId: 137,
    name: "polymarket",
    kind: "venue",
    family: "polymarket",
    agent: "polymarket-agent",
    note: "prediction markets (polygon venue)",
    build: false,
  },
]);

function normalize(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/\s+/g, "-");
}

export function listWorkingChains({ buildOnly = false } = {}) {
  return WORKING_CHAINS.filter((c) => (buildOnly ? c.build : true));
}

export function findWorkingChain(query) {
  const q = normalize(query);
  if (!q) return null;
  for (const chain of WORKING_CHAINS) {
    if (chain.key === q) return chain;
    if (String(chain.chainId).toLowerCase() === q) return chain;
    if ((chain.aliases || []).map(normalize).includes(q)) return chain;
    if (normalize(chain.name) === q) return chain;
  }
  return null;
}

export function renderChainList({ selectedKey = null, buildOnly = false } = {}) {
  const rows = listWorkingChains({ buildOnly });
  const lines = [
    "oracle chains",
    "",
    "pick a build/trade surface:",
    "",
  ];
  for (const c of rows) {
    const mark = selectedKey && selectedKey === c.key ? "*" : " ";
    const id = String(c.chainId).padEnd(6);
    const key = c.key.padEnd(12);
    lines.push(`${mark} ${key} ${id}  ${c.note}`);
  }
  lines.push("");
  lines.push("usage:");
  lines.push("  /chain                 list");
  lines.push("  /chain hyperliquid     select");
  lines.push("  /chain show            current");
  lines.push("  /chain clear           unset");
  lines.push("  oracle chain use base  same from shell");
  if (selectedKey) lines.push("", `active: ${selectedKey}`);
  return lines.join("\n") + "\n";
}

export default {
  WORKING_CHAINS,
  listWorkingChains,
  findWorkingChain,
  renderChainList,
};
