// EVM chain registry — the desk is multi-chain by design (any EVM chain).
// A "venue" (rh/poly/hl) is a product surface; a "chain" is where a tx settles.
// One agent wallet can sign on ANY EVM chain — same key, different
// provider/RPC. This registry keeps chainIds first-class so adapters never
// hardcode a single chain (a real bug we unwound once: an inline chainId===1
// special case in a mint path).

// Known chains the desk touches today. Extensible: add an entry, nothing else changes.
export const CHAINS = {
  robinhood: { chainId: 4663, name: "Robinhood Chain", rpcEnv: ["RH_CHAIN_RPC"], evm: true },
  ethereum:  { chainId: 1,    name: "Ethereum",        rpcEnv: ["ETH_RPC_URL", "ETHEREUM_RPC_URL", "MAINNET_RPC_URL"], evm: true },
  polygon:   { chainId: 137,  name: "Polygon",         rpcEnv: ["POLYGON_RPC_URL", "POLYGON_RPC"], evm: true },
  arbitrum:  { chainId: 42161, name: "Arbitrum One",   rpcEnv: ["ARBITRUM_RPC_URL", "ARB_RPC_URL"], evm: true },
  base:      { chainId: 8453, name: "Base",            rpcEnv: ["BASE_RPC_URL"], evm: true },
  hyperevm:  { chainId: 999,  name: "HyperEVM",        rpcEnv: ["HYPEREVM_RPC_URL", "HYPER_EVM_RPC"], evm: true },
  bsc:       { chainId: 56,   name: "BNB Smart Chain", rpcEnv: ["BSC_RPC_URL", "BNB_RPC_URL"], evm: true },
  avalanche: { chainId: 43114, name: "Avalanche C-Chain", rpcEnv: ["AVALANCHE_RPC_URL", "AVAX_RPC_URL"], evm: true },
  optimism:  { chainId: 10,   name: "OP Mainnet",       rpcEnv: ["OPTIMISM_RPC_URL", "OP_RPC_URL"], evm: true },
  abstract:  { chainId: 2741, name: "Abstract",         rpcEnv: ["ABSTRACT_RPC_URL", "ABS_RPC_URL"], evm: true },
  // Tether/Bitfinex-linked Stable L1 — gas = USDT0/gUSDT; FEFER-class memes (Dyor)
  stable:    { chainId: 988,  name: "Stable Mainnet",  rpcEnv: ["STABLE_RPC_URL", "STABLE_RPC"], evm: true },
};

const BY_ID = new Map(Object.values(CHAINS).map((c) => [c.chainId, c]));

/** Look up a chain by numeric chainId. Returns null if unknown (never throws here). */
export function chainById(chainId) {
  return BY_ID.get(Number(chainId)) || null;
}

/**
 * Register (or override) an EVM chain at runtime so the desk supports ANY EVM
 * chain without a code change. Idempotent.
 * @param {{ key:string, chainId:number, name?:string, rpcEnv?:string[] }} def
 */
export function registerChain({ key, chainId, name, rpcEnv = [] }) {
  if (!key) throw new Error("registerChain requires a key");
  if (!Number.isInteger(Number(chainId))) throw new Error("registerChain requires a numeric chainId");
  const entry = { chainId: Number(chainId), name: name || key, rpcEnv, evm: true };
  CHAINS[key] = entry;
  BY_ID.set(entry.chainId, entry);
  return entry;
}

/**
 * Resolve a usable RPC URL for a chainId from the environment, trying each
 * candidate env var in order. Returns null if none set (caller decides if fatal).
 */
export function rpcUrlFor(chainId, env = process.env) {
  const c = chainById(chainId);
  if (!c) return null;
  for (const name of c.rpcEnv) {
    const v = (env[name] || "").trim();
    if (v) return v;
  }
  return null;
}

/** True if we recognize this chainId as a supported EVM chain. */
export function isSupportedChain(chainId) {
  return BY_ID.has(Number(chainId));
}
