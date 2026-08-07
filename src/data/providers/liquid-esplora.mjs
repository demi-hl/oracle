// Liquid Network (Blockstream sidechain) via Esplora HTTP — keyless.
//
// Same Esplora schema as bitcoin-esplora, different chain and one extra
// concept: Liquid is multi-asset, so balances are per-asset-id and the
// /asset/{id} endpoint carries peg-in/peg-out issuance stats that have no
// Bitcoin L1 equivalent.
//
// Verified live:
//   GET /liquid/api/blocks/tip/height   200 (plain text height)
//   GET /liquid/api/address/{addr}      200
//   GET /liquid/api/asset/{asset_id}    200
//
// Liquid address forms, all accepted below:
//   Q…            unconfidential p2pkh/p2sh (base58)
//   VJL… / VTp…   confidential (base58, long)
//   ex1… / lq1…   unconfidential / confidential bech32(m)
//
// Read-only. Peg-outs and transfers are user-wallet operations; nothing here
// signs or broadcasts.

import { httpJson } from "../http.mjs";

export const LIQUID_ESPLORA_URL = "https://blockstream.info/liquid/api";
// Policy asset: L-BTC. Used as the default for balance reads.
export const LIQUID_LBTC_ASSET_ID = "6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d";

function baseUrl(opts = {}) {
  return String(opts.baseUrl || process.env.LIQUID_ESPLORA_URL || LIQUID_ESPLORA_URL).replace(/\/$/, "");
}

export function liquidAddress(value, label = "address") {
  const text = String(value || "").trim();
  const bech32 = /^(ex1|lq1|el1|tex1|tlq1)[a-z0-9]{20,200}$/i.test(text);
  const base58 = /^[QVGH][a-km-zA-HJ-NP-Z1-9]{25,110}$/.test(text);
  if (!bech32 && !base58) {
    throw new Error(`liquid-esplora: ${label} must look like a Liquid address (Q…, VJL…, ex1…, lq1…)`);
  }
  return text;
}

export function liquidAssetId(value, label = "assetId") {
  const text = String(value || "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`liquid-esplora: ${label} must be 64-char hex`);
  return text;
}

async function getText(path, opts = {}) {
  const url = `${baseUrl(opts)}${path.startsWith("/") ? path : `/${path}`}`;
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json,text/plain;q=0.9,*/*;q=0.8" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`liquid-esplora GET ${path}: HTTP ${res.status} ${text.slice(0, 160)}`);
  return text;
}

function getJson(path, opts = {}) {
  return httpJson(`${baseUrl(opts)}${path.startsWith("/") ? path : `/${path}`}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 12_000,
  });
}

export async function liquidHealth(opts = {}) {
  try {
    const tip = await getText("/blocks/tip/height", opts);
    const height = Number(tip);
    return {
      ok: Number.isFinite(height) && height > 0,
      provider: "liquid-esplora",
      baseUrl: baseUrl(opts),
      tipHeight: height,
      exec: false,
      signing: "user-wallet",
    };
  } catch (error) {
    return {
      ok: false,
      provider: "liquid-esplora",
      baseUrl: baseUrl(opts),
      error: String(error?.message || error),
      exec: false,
    };
  }
}

export async function liquidTipHeight(_args = {}, opts = {}) {
  const tip = await getText("/blocks/tip/height", opts);
  return { provider: "liquid-esplora", tipHeight: Number(tip) };
}

/**
 * Address stats. NOTE: Liquid is confidential by default — a confidential
 * address returns TXO COUNTS, not amounts, because the amounts are blinded on
 * chain. Only unblinded/unconfidential outputs carry values. The response says
 * so explicitly rather than reporting a misleading zero balance.
 */
export async function liquidAddressInfo(args = {}, opts = {}) {
  const address = liquidAddress(args.address || args.addr, "address");
  const info = await getJson(`/address/${address}`, opts);
  const chain = info.chain_stats || {};
  const mempool = info.mempool_stats || {};
  const hasAmounts = chain.funded_txo_sum != null;
  const funded = Number(chain.funded_txo_sum || 0) + Number(mempool.funded_txo_sum || 0);
  const spent = Number(chain.spent_txo_sum || 0) + Number(mempool.spent_txo_sum || 0);
  return {
    provider: "liquid-esplora",
    address,
    txCount: Number(chain.tx_count || 0) + Number(mempool.tx_count || 0),
    balanceSats: hasAmounts ? String(funded - spent) : null,
    confidential: !hasAmounts,
    note: hasAmounts
      ? undefined
      : "Liquid amounts are blinded — Esplora returns TXO counts only for confidential outputs. Unblind with the wallet's blinding key for values.",
    chainStats: chain,
    mempoolStats: mempool,
    raw: info,
  };
}

/** Asset registry + issuance stats. Defaults to L-BTC (the policy asset). */
export async function liquidAssetInfo(args = {}, opts = {}) {
  const assetId = liquidAssetId(args.assetId || args.asset || LIQUID_LBTC_ASSET_ID, "assetId");
  const info = await getJson(`/asset/${assetId}`, opts);
  const chain = info.chain_stats || {};
  return {
    provider: "liquid-esplora",
    assetId,
    isPolicyAsset: assetId === LIQUID_LBTC_ASSET_ID,
    name: info.name ?? info.entity?.domain ?? null,
    ticker: info.ticker ?? null,
    precision: info.precision ?? null,
    issuanceTxid: info.issuance_txin?.txid ?? null,
    txCount: chain.tx_count ?? null,
    // Peg fields exist only for the policy asset; issued assets carry
    // issued_amount / burned_amount instead.
    pegInAmount: chain.peg_in_amount == null ? null : String(chain.peg_in_amount),
    pegOutAmount: chain.peg_out_amount == null ? null : String(chain.peg_out_amount),
    issuedAmount: chain.issued_amount == null ? null : String(chain.issued_amount),
    burnedAmount: chain.burned_amount == null ? null : String(chain.burned_amount),
    circulatingAmount:
      chain.peg_in_amount != null
        ? String(Number(chain.peg_in_amount) - Number(chain.peg_out_amount || 0) - Number(chain.burned_amount || 0))
        : chain.issued_amount != null
          ? String(Number(chain.issued_amount) - Number(chain.burned_amount || 0))
          : null,
    raw: info,
  };
}
