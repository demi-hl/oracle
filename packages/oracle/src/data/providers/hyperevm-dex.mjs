// HyperEVM (chain 999) discovery via DexScreener + optional RPC health.
// No dedicated public Uniswap QuoterV2 on HyperEVM assumed.

import { dexscreenerSearch, dexscreenerToken } from "./dexscreener.mjs";
import { rpcHealth } from "./evm-rpc.mjs";

export const HYPEREVM_CHAIN_ID = 999;

export async function hyperevmHealth(opts = {}) {
  const out = { chainId: HYPEREVM_CHAIN_ID, rpc: null, dex: null };
  try {
    out.rpc = await rpcHealth(HYPEREVM_CHAIN_ID, opts);
  } catch (e) {
    out.rpc = { ok: false, error: String(e.message || e).slice(0, 120) };
  }
  try {
    const s = await dexscreenerSearch("HYPE", opts);
    const pairs = (s.pairs || []).filter((p) =>
      /hyper|hl|hyperevm/i.test(String(p.chainId || p.chain || ""))
    );
    out.dex = {
      ok: true,
      hypePairs: pairs.length || (s.pairs || []).length,
      sample: (pairs[0] || s.pairs?.[0])?.pairAddress || null,
    };
  } catch (e) {
    out.dex = { ok: false, error: String(e.message || e).slice(0, 120) };
  }
  return {
    ok: Boolean(out.rpc?.ok || out.dex?.ok),
    ...out,
  };
}

export async function hyperevmSearch(q = "HYPE", opts = {}) {
  const s = await dexscreenerSearch(q, opts);
  const pairs = s.pairs || [];
  const hl = pairs.filter((p) => /hyper|hl|hyperevm/i.test(String(p.chainId || "")));
  return {
    query: q,
    hyperPairs: hl,
    allPairs: pairs.slice(0, 20),
    count: hl.length || pairs.length,
  };
}

export async function hyperevmToken(address, opts = {}) {
  return dexscreenerToken(address, opts);
}
