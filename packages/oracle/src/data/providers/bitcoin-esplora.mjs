// Bitcoin L1 read/broadcast via Esplora HTTP (mempool.space / Blockstream).
// No Bitcoin Core RPC required. No keys, no signing.

import { httpJson } from "../http.mjs";

export const BTC_NETWORK_MAINNET = "mainnet";
export const BTC_ESPLORA_MAINNET = "https://mempool.space/api";
export const BTC_ESPLORA_TESTNET = "https://mempool.space/testnet/api";

function network(opts = {}) {
  const n = String(opts.network || process.env.BTC_NETWORK || BTC_NETWORK_MAINNET).trim().toLowerCase();
  return n === "testnet" ? "testnet" : "mainnet";
}

function baseUrl(opts = {}) {
  if (opts.baseUrl) return String(opts.baseUrl).replace(/\/$/, "");
  if (process.env.BTC_ESPLORA_URL) return String(process.env.BTC_ESPLORA_URL).replace(/\/$/, "");
  return network(opts) === "testnet" ? BTC_ESPLORA_TESTNET : BTC_ESPLORA_MAINNET;
}

export function btcAddress(value, label = "address") {
  const text = String(value || "").trim();
  // bech32 / bech32m / legacy / p2sh — loose shape check, not full BIP validation
  if (!/^(bc1|tb1|bcrt1)[a-z0-9]{20,90}$/i.test(text) && !/^[13mn2][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(text)) {
    throw new Error(`bitcoin-esplora: ${label} must look like a Bitcoin address`);
  }
  return text;
}

export function btcTxHex(value, label = "txHex") {
  const text = String(value || "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(text) || text.length < 20 || text.length % 2 !== 0) {
    throw new Error(`bitcoin-esplora: ${label} must be even-length hex`);
  }
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
  if (!res.ok) throw new Error(`bitcoin-esplora GET ${path}: HTTP ${res.status} ${text.slice(0, 160)}`);
  return text;
}

async function getJson(path, opts = {}) {
  const text = await getText(path, opts);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function postText(path, body, opts = {}) {
  const url = `${baseUrl(opts)}${path.startsWith("/") ? path : `/${path}`}`;
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "text/plain", accept: "application/json,text/plain;q=0.9,*/*;q=0.8" },
    body: String(body || ""),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`bitcoin-esplora POST ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text.trim();
}

export async function btcHealth(opts = {}) {
  try {
    const tip = await getText("/blocks/tip/height", opts);
    const height = Number(tip);
    return {
      ok: Number.isFinite(height) && height > 0,
      provider: "bitcoin-esplora",
      network: network(opts),
      baseUrl: baseUrl(opts),
      tipHeight: height,
      exec: false,
      signing: "user-wallet",
    };
  } catch (error) {
    return {
      ok: false,
      provider: "bitcoin-esplora",
      network: network(opts),
      baseUrl: baseUrl(opts),
      error: String(error?.message || error),
      exec: false,
    };
  }
}

export async function btcTipHeight(opts = {}) {
  const tip = await getText("/blocks/tip/height", opts);
  return {
    provider: "bitcoin-esplora",
    network: network(opts),
    tipHeight: Number(tip),
  };
}

export async function btcFees(opts = {}) {
  // mempool.space recommended fees; Blockstream may 404 — fall back empty
  try {
    const fees = await getJson("/v1/fees/recommended", opts);
    return {
      provider: "bitcoin-esplora",
      network: network(opts),
      fastestFee: fees.fastestFee ?? null,
      halfHourFee: fees.halfHourFee ?? null,
      hourFee: fees.hourFee ?? null,
      economyFee: fees.economyFee ?? null,
      minimumFee: fees.minimumFee ?? null,
      raw: fees,
    };
  } catch {
    return {
      provider: "bitcoin-esplora",
      network: network(opts),
      fastestFee: null,
      halfHourFee: null,
      hourFee: null,
      note: "fee endpoint unavailable on this Esplora host",
    };
  }
}

export async function btcAddressInfo(args = {}, opts = {}) {
  const address = btcAddress(args.address || args.addr, "address");
  const info = await getJson(`/address/${address}`, opts);
  const chain = info.chain_stats || {};
  const mempool = info.mempool_stats || {};
  const funded = Number(chain.funded_txo_sum || 0) + Number(mempool.funded_txo_sum || 0);
  const spent = Number(chain.spent_txo_sum || 0) + Number(mempool.spent_txo_sum || 0);
  return {
    provider: "bitcoin-esplora",
    network: network(opts),
    address,
    balanceSats: String(funded - spent),
    chainStats: chain,
    mempoolStats: mempool,
    raw: info,
  };
}

export async function btcUtxos(args = {}, opts = {}) {
  const address = btcAddress(args.address || args.addr, "address");
  const utxos = await getJson(`/address/${address}/utxo`, opts);
  const list = Array.isArray(utxos) ? utxos : [];
  return {
    provider: "bitcoin-esplora",
    network: network(opts),
    address,
    count: list.length,
    totalSats: String(list.reduce((n, u) => n + Number(u.value || 0), 0)),
    utxos: list.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: Number(u.value || 0),
      status: u.status || null,
    })),
  };
}

export async function btcTx(args = {}, opts = {}) {
  const txid = String(args.txid || args.txId || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("bitcoin-esplora: txid must be 64-char hex");
  const tx = await getJson(`/tx/${txid}`, opts);
  return {
    provider: "bitcoin-esplora",
    network: network(opts),
    txid,
    confirmed: Boolean(tx.status?.confirmed),
    fee: tx.fee ?? null,
    size: tx.size ?? null,
    weight: tx.weight ?? null,
    vinCount: Array.isArray(tx.vin) ? tx.vin.length : null,
    voutCount: Array.isArray(tx.vout) ? tx.vout.length : null,
    raw: tx,
  };
}

export async function btcDecodeTxHex(args = {}, opts = {}) {
  const txHex = btcTxHex(args.txHex || args.hex || args.transaction, "txHex");
  // Esplora has no universal decode; return structural summary from hex length + optional /tx/hex reverse via broadcast dry path.
  return {
    provider: "bitcoin-esplora",
    network: network(opts),
    encoding: "hex",
    txHex,
    byteLength: txHex.length / 2,
    note: "full decode is wallet/client-side or via bitcoinjs; Esplora returns broadcast acceptance only",
  };
}

/**
 * Broadcast a fully signed raw transaction hex.
 *
 * Posture: broadcasting is ARMED whenever the caller has signed bytes to send —
 * possessing a signed transaction IS the authorization. What is still required
 * is that the SEND be asked for: `execute:true` marks a user-initiated
 * broadcast, so nothing goes out as a side effect of a read path. Oracle never
 * signs here; the caller supplies the bytes.
 */
export async function btcBroadcast(_a = {}, _o = {}) {
  throw new Error("bitcoin-esplora.btcBroadcast refused: @oracle-agent/oracle is prepare-only. Broadcast from the user wallet or a local operator process.");
}

// Keep httpJson import usable for Core RPC optional path later without circular deps.
void httpJson;
