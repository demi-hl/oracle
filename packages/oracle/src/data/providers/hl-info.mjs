// Hyperliquid public info client — read-only, no agent key.

import { httpJson } from "../http.mjs";

export const HL_INFO_MAINNET = "https://api.hyperliquid.xyz/info";
export const HL_INFO_TESTNET = "https://api.hyperliquid-testnet.xyz/info";

function infoUrl({ testnet, baseUrl } = {}) {
  if (baseUrl) {
    return baseUrl.replace(/\/$/, "").endsWith("/info")
      ? baseUrl
      : `${baseUrl.replace(/\/$/, "")}/info`;
  }
  if (process.env.HL_INFO_URL) return process.env.HL_INFO_URL;
  if (process.env.HL_API_URL) {
    const b = process.env.HL_API_URL.replace(/\/$/, "");
    return b.endsWith("/info") ? b : `${b}/info`;
  }
  return testnet || process.env.HL_TESTNET === "1" ? HL_INFO_TESTNET : HL_INFO_MAINNET;
}

export async function hlInfo(body, opts = {}) {
  if (!body || !body.type) throw new Error("hlInfo requires body.type");
  const url = infoUrl(opts);
  return httpJson(url, {
    method: "POST",
    body,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

export async function hlHealth(opts = {}) {
  const mids = await hlInfo({ type: "allMids" }, opts);
  const n = mids && typeof mids === "object" ? Object.keys(mids).length : 0;
  return { ok: n > 0, midCount: n };
}

export async function hlAllMids(opts = {}) {
  return hlInfo({ type: "allMids" }, opts);
}

export async function hlL2Book(coin, opts = {}) {
  if (!coin) throw new Error("hlL2Book requires coin");
  return hlInfo({ type: "l2Book", coin: String(coin) }, opts);
}

export async function hlOutcomeMeta(opts = {}) {
  return hlInfo({ type: "outcomeMeta" }, opts);
}

export async function hlClearinghouse(user, opts = {}) {
  if (!user) throw new Error("hlClearinghouse requires user address");
  return hlInfo({ type: "spotClearinghouseState", user }, opts);
}

export async function hlUserFills(user, opts = {}) {
  if (!user) throw new Error("hlUserFills requires user address");
  return hlInfo({ type: "userFills", user }, opts);
}

// D1 expansions
export async function hlMeta(opts = {}) {
  return hlInfo({ type: "meta" }, opts);
}

export async function hlMetaAndAssetCtxs(opts = {}) {
  const body = { type: "metaAndAssetCtxs" };
  if (opts.dex) body.dex = opts.dex;
  return hlInfo(body, opts);
}

export async function hlPerpDexs(opts = {}) {
  return hlInfo({ type: "perpDexs" }, opts);
}

export async function hlCandleSnapshot({ coin, interval = "1h", startTime, endTime }, opts = {}) {
  if (!coin) throw new Error("hlCandleSnapshot requires coin");
  const req = {
    type: "candleSnapshot",
    req: {
      coin: String(coin),
      interval,
      startTime: startTime ?? Date.now() - 24 * 3600 * 1000,
      endTime: endTime ?? Date.now(),
    },
  };
  return hlInfo(req, opts);
}

export async function hlFundingHistory({ coin, startTime, endTime }, opts = {}) {
  if (!coin) throw new Error("hlFundingHistory requires coin");
  return hlInfo({
    type: "fundingHistory",
    coin: String(coin),
    startTime: startTime ?? Date.now() - 24 * 3600 * 1000,
    endTime: endTime ?? Date.now(),
  }, opts);
}

export async function hlOpenOrders(user, opts = {}) {
  if (!user) throw new Error("hlOpenOrders requires user");
  return hlInfo({ type: "openOrders", user }, opts);
}

export async function hlFrontendOpenOrders(user, opts = {}) {
  if (!user) throw new Error("hlFrontendOpenOrders requires user");
  return hlInfo({ type: "frontendOpenOrders", user }, opts);
}

export async function hlUserState(user, opts = {}) {
  if (!user) throw new Error("hlUserState requires user");
  return hlInfo({ type: "clearinghouseState", user }, opts);
}

export async function hlSpotMeta(opts = {}) {
  return hlInfo({ type: "spotMeta" }, opts);
}
