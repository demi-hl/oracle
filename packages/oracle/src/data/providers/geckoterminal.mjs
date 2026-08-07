// GeckoTerminal public market-data API — no key.
import { httpJson } from "../http.mjs";

export const GECKOTERMINAL_API = "https://api.geckoterminal.com/api/v2";
const base = (o={}) => (o.baseUrl || process.env.GECKOTERMINAL_API_URL || GECKOTERMINAL_API).replace(/\/$/, "");
const enc = (v) => encodeURIComponent(String(v));

export async function geckoNetworks(args = {}, opts = {}) {
  const page = Math.max(1, Number(args.page || 1));
  return httpJson(`${base(opts)}/networks?page=${page}`, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}
export async function geckoPool(args = {}, opts = {}) {
  if (!args.network || !args.poolAddress) throw new Error("network and poolAddress required");
  return httpJson(`${base(opts)}/networks/${enc(args.network)}/pools/${enc(args.poolAddress)}`, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}
export async function geckoToken(args = {}, opts = {}) {
  if (!args.network || !(args.address || args.tokenAddress)) throw new Error("network and token address required");
  return httpJson(`${base(opts)}/networks/${enc(args.network)}/tokens/${enc(args.address || args.tokenAddress)}`, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}
export async function geckoPoolOhlcv(args = {}, opts = {}) {
  if (!args.network || !args.poolAddress) throw new Error("network and poolAddress required");
  const timeframe = ["minute","hour","day"].includes(args.timeframe) ? args.timeframe : "hour";
  const p = new URLSearchParams();
  p.set("aggregate", String(Math.max(1, Number(args.aggregate || 1))));
  p.set("limit", String(Math.min(1000, Math.max(1, Number(args.limit || 168)))));
  if (args.beforeTimestamp != null) p.set("before_timestamp", String(args.beforeTimestamp));
  if (args.currency) p.set("currency", String(args.currency));
  if (args.token) p.set("token", String(args.token));
  return httpJson(`${base(opts)}/networks/${enc(args.network)}/pools/${enc(args.poolAddress)}/ohlcv/${timeframe}?${p}`, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}
export async function geckoHealth(opts = {}) {
  const data = await geckoNetworks({ page: 1 }, opts);
  return { ok: Array.isArray(data?.data) && data.data.length > 0, networkSample: data?.data?.length || 0 };
}
