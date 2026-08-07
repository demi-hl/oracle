// Blockscout REST API v2 — verified public explorer instances, no key.
import { httpJson } from "../http.mjs";
export const BLOCKSCOUT_CHAINS=Object.freeze({
  1:"https://eth.blockscout.com",
  10:"https://optimism.blockscout.com",
  137:"https://polygon.blockscout.com",
  42161:"https://arbitrum.blockscout.com",
  8453:"https://base.blockscout.com",
});
function base(chainId,o={}) { const id=Number(chainId); const u=o.baseUrl || BLOCKSCOUT_CHAINS[id]; if(!u) throw new Error(`Blockscout not configured for chainId ${id}`); return u.replace(/\/$/,""); }
export async function blockscoutStats(args={},opts={}) { return httpJson(`${base(args.chainId||1,opts)}/api/v2/stats`,{fetchImpl:opts.fetchImpl,timeoutMs:opts.timeoutMs}); }
export async function blockscoutAddress(args={},opts={}) { if(!args.address)throw new Error("address required"); return httpJson(`${base(args.chainId||1,opts)}/api/v2/addresses/${encodeURIComponent(args.address)}`,{fetchImpl:opts.fetchImpl,timeoutMs:opts.timeoutMs}); }
export async function blockscoutToken(args={},opts={}) { if(!args.address && !args.tokenAddress)throw new Error("token address required"); return httpJson(`${base(args.chainId||1,opts)}/api/v2/tokens/${encodeURIComponent(args.address||args.tokenAddress)}`,{fetchImpl:opts.fetchImpl,timeoutMs:opts.timeoutMs}); }
export async function blockscoutHealth(opts={}) { const data=await blockscoutStats({chainId:8453},opts); return {ok:data?.total_blocks!=null || data?.total_transactions!=null,chainId:8453}; }
