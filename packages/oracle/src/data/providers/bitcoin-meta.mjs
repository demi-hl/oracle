// Bitcoin metaprotocol reads (ordinals / runes).
// Pluggable indexer base. No keys in repo — optional API keys via env.
//
// Free keyless tier: ordinals.com recursive ("/r/*") endpoints. Verified live
// 2026-07: blockheight, blockhash, blockinfo, inscription metadata, children,
// sat. These are the ord node's own recursive API and need no key.
//
// Indexer landscape as probed (do not re-litigate without re-probing):
//   ordinals.com /r/*   200, keyless          -> wired below
//   Hiro ordinals/brc20 410 GONE, deprecated  -> dead, do not use
//   Ordiscan            402 payment required
//   UniSat open-api     403 without Bearer
//   BestInSlot          301 (moved; needs key)
//   Magic Eden BTC      503 "no healthy upstream" -> dead
//   Satflow             403 without x-api-key -> marketplace, separate provider
//
// Known gap: ordinals.com has NO address-indexed endpoint (/r/address 404).
// Address -> inscriptions/runes REQUIRES a keyed indexer. Keyless mode can
// answer "what is this inscription" but not "what does this wallet hold".

import { btcAddress } from "./bitcoin-esplora.mjs";
import { resolveProviderEndpoint, credentialedHeaders } from "../provider-endpoint.mjs";

export const ORDINALS_RECURSIVE_BASE = "https://ordinals.com";

function metaBase(opts = {}) {
  return String(
    opts.baseUrl ||
      process.env.BTC_META_API_URL ||
      process.env.UNISAT_API_URL ||
      ""
  )
    .trim()
    .replace(/\/$/, "");
}

// This provider has NO fixed default endpoint: the operator points it at their
// own UniSat / Best-in-Slot deployment. Trust is therefore decided by an
// explicit host allowlist rather than a built-in default.
const BTC_META_HOSTS = [
  "open-api.unisat.io",
  "open-api-testnet.unisat.io",
  "api.bestinslot.xyz",
  "api.hiro.so",
];

function metaEndpoint(opts = {}) {
  const url = metaBase(opts);
  if (!url) return { baseUrl: "", trusted: false, host: null };
  return resolveProviderEndpoint({
    provider: "bitcoin-meta",
    defaultUrl: url,
    hosts: BTC_META_HOSTS,
    url,
  });
}

function headers(opts = {}) {
  const key =
    opts.apiKey ||
    process.env.UNISAT_API_KEY ||
    process.env.BESTINSLOT_API_KEY ||
    process.env.BTC_META_API_KEY ||
    "";
  // An operator-configured base is only credentialed when its host is one of
  // the known indexers; a redirected base gets the request without the key.
  let trusted = false;
  try {
    const url = metaBase(opts);
    if (url) {
      const host = new URL(url).host;
      const proto = new URL(url).protocol;
      const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
      trusted = BTC_META_HOSTS.includes(host) && (proto === "https:" || loopback);
    }
  } catch {
    trusted = false;
  }
  return credentialedHeaders(
    { accept: "application/json", "user-agent": "oracle-btc-meta/0.1" },
    { authorization: key ? `Bearer ${key}` : "", "x-api-key": key },
    trusted
  );
}

async function getJson(url, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: headers(opts),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`bitcoin-meta GET ${url}: HTTP ${res.status} ${String(text).slice(0, 160)}`);
  }
  return body;
}

export async function btcMetaHealth(opts = {}) {
  const base = metaBase(opts);
  // Always can hit ordinals.com tip as chain liveness (not full meta)
  let tip = null;
  try {
    const fetchImpl = opts.fetchImpl || fetch;
    const r = await fetchImpl("https://ordinals.com/r/blockheight", {
      signal: AbortSignal.timeout(8000),
    });
    tip = Number(await r.text());
  } catch {
    tip = null;
  }

  if (!base) {
    return {
      ok: tip != null,
      provider: "bitcoin-meta",
      indexerConfigured: false,
      ordinalsComTip: tip,
      note: "Set BTC_META_API_URL and/or UNISAT_API_KEY / BESTINSLOT_API_KEY for balances. Marketplace = Satflow (SATFLOW_API_KEY). Magic Eden BTC is dead.",
      capabilities: {
        tip: tip != null,
        runeBalances: false,
        inscriptions: false,
        marketplace: false,
      },
    };
  }

  // Probe common paths; tolerate 404
  let probe = { ok: false, path: null, status: null };
  for (const path of ["/v1/indexer/brc20/best-height", "/v1/health", "/health", "/"]) {
    try {
      const fetchImpl = opts.fetchImpl || fetch;
      const res = await fetchImpl(`${base}${path}`, {
        headers: headers(opts),
        signal: AbortSignal.timeout(8000),
      });
      probe = { ok: res.status > 0 && res.status < 500, path, status: res.status };
      if (res.ok) break;
    } catch {
      /* try next */
    }
  }

  return {
    ok: probe.ok || tip != null,
    provider: "bitcoin-meta",
    indexerConfigured: true,
    baseUrl: base,
    probe,
    ordinalsComTip: tip,
    apiKeyPresent: Boolean(
      process.env.UNISAT_API_KEY ||
        process.env.BESTINSLOT_API_KEY ||
        process.env.BTC_META_API_KEY
    ),
    capabilities: {
      tip: tip != null,
      runeBalances: true,
      inscriptions: true,
      marketplace: Boolean(process.env.SATFLOW_API_KEY),
    },
  };
}

/**
 * Rune balances for an address. Requires configured indexer.
 * Normalizes heterogeneous API shapes into a common list.
 */
export async function btcRuneBalances(args = {}, opts = {}) {
  const address = btcAddress(args.address || args.addr, "address");
  const base = metaBase(opts);
  if (!base) {
    return {
      provider: "bitcoin-meta",
      address,
      ok: false,
      balances: [],
      error: "no indexer configured (set BTC_META_API_URL or vendor API key env)",
    };
  }

  // Try UniSat-shaped path first, then generic
  const candidates = [
    `${base}/v1/indexer/address/${address}/runes/balance-list?start=0&limit=100`,
    `${base}/v1/runes/address/${address}`,
    `${base}/runes/balance/${address}`,
    `${base}/address/${address}/runes`,
  ];

  let lastErr = null;
  for (const url of candidates) {
    try {
      const body = await getJson(url, opts);
      const list = normalizeRuneBalances(body);
      return {
        provider: "bitcoin-meta",
        address,
        ok: true,
        count: list.length,
        balances: list,
        source: url,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  return {
    provider: "bitcoin-meta",
    address,
    ok: false,
    balances: [],
    error: String(lastErr?.message || lastErr || "all indexer paths failed"),
  };
}

function normalizeRuneBalances(body) {
  const raw =
    body?.data?.detail ||
    body?.data?.list ||
    body?.data ||
    body?.balances ||
    body?.results ||
    body?.runes ||
    (Array.isArray(body) ? body : []);
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((r) => ({
    rune: r.rune || r.runeid || r.runeId || r.spacedRune || r.name || r.ticker || null,
    runeId: r.runeid || r.runeId || r.id || null,
    amount: String(r.amount ?? r.balance ?? r.total ?? r.qty ?? "0"),
    symbol: r.symbol || null,
    divisibility: r.divisibility ?? r.div ?? null,
    raw: r,
  }));
}

/**
 * Inscriptions controlled by an address.
 *
 * NOTE: requires a KEYED indexer. ordinals.com recursive has no address index
 * (verified: /r/address -> 404), so the free tier cannot answer this. We say so
 * explicitly rather than returning an empty list that reads like "you own
 * nothing" — a false negative here can get an inscription spent as fee change.
 */
export async function btcInscriptions(args = {}, opts = {}) {
  const address = btcAddress(args.address || args.addr, "address");
  const base = metaBase(opts);
  if (!base) {
    return {
      provider: "bitcoin-meta",
      address,
      ok: false,
      inscriptions: [],
      error:
        "no indexer configured — address-indexed lookups need a keyed indexer " +
        "(BTC_META_API_URL + UNISAT_API_KEY / BESTINSLOT_API_KEY). " +
        "ordinals.com recursive is keyless but has no address index.",
      unknownNotEmpty: true,
      keylessAlternatives: ["btc_inscription_info (by inscription id)", "btc_meta_health"],
    };
  }
  const limit = Math.min(Number(args.limit || 50), 200);
  const candidates = [
    `${base}/v1/indexer/address/${address}/inscription-data?cursor=0&size=${limit}`,
    `${base}/v1/inscriptions/address/${address}?limit=${limit}`,
    `${base}/address/${address}/inscriptions?limit=${limit}`,
  ];
  let lastErr = null;
  for (const url of candidates) {
    try {
      const body = await getJson(url, opts);
      const list = normalizeInscriptions(body);
      return {
        provider: "bitcoin-meta",
        address,
        ok: true,
        count: list.length,
        inscriptions: list,
        source: url,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  return {
    provider: "bitcoin-meta",
    address,
    ok: false,
    inscriptions: [],
    error: String(lastErr?.message || lastErr || "all indexer paths failed"),
  };
}

/**
 * Inscription metadata by inscription id — KEYLESS via ordinals.com recursive.
 * Verified live: returns content_type, content_length, height, sat, fee, etc.
 */
export async function btcInscriptionInfo(args = {}, opts = {}) {
  const id = String(args.inscriptionId || args.id || "").trim();
  if (!/^[0-9a-f]{64}i\d+$/i.test(id)) {
    throw new Error("bitcoin-meta: inscriptionId must look like <64-hex-txid>i<index>");
  }
  const base = opts.ordinalsBase || ORDINALS_RECURSIVE_BASE;
  const info = await getJson(`${base}/r/inscription/${id}`, opts);
  return {
    provider: "bitcoin-meta",
    source: "ordinals.com/r",
    keyless: true,
    inscriptionId: id,
    info,
  };
}

/**
 * Child inscriptions (collection/parent-child) — KEYLESS via ordinals.com.
 */
export async function btcInscriptionChildren(args = {}, opts = {}) {
  const id = String(args.inscriptionId || args.id || "").trim();
  if (!/^[0-9a-f]{64}i\d+$/i.test(id)) {
    throw new Error("bitcoin-meta: inscriptionId must look like <64-hex-txid>i<index>");
  }
  const base = opts.ordinalsBase || ORDINALS_RECURSIVE_BASE;
  const page = Number(args.page || 0);
  const body = await getJson(`${base}/r/children/${id}${page ? `/${page}` : ""}`, opts);
  return {
    provider: "bitcoin-meta",
    source: "ordinals.com/r",
    keyless: true,
    inscriptionId: id,
    page,
    children: Array.isArray(body?.ids) ? body.ids : [],
    more: Boolean(body?.more),
  };
}

/**
 * Block info from the ord node itself — KEYLESS. Useful to confirm the ord
 * indexer is at the same tip as Esplora before trusting any metaprotocol read.
 */
export async function btcOrdBlockInfo(args = {}, opts = {}) {
  const base = opts.ordinalsBase || ORDINALS_RECURSIVE_BASE;
  const height = args.height ?? (await getJson(`${base}/r/blockheight`, opts));
  const info = await getJson(`${base}/r/blockinfo/${Number(height)}`, opts);
  return {
    provider: "bitcoin-meta",
    source: "ordinals.com/r",
    keyless: true,
    height: Number(height),
    info,
  };
}

function normalizeInscriptions(body) {
  const raw =
    body?.data?.inscription ||
    body?.data?.detail ||
    body?.data?.list ||
    body?.data ||
    body?.inscriptions ||
    body?.results ||
    (Array.isArray(body) ? body : []);
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((i) => ({
    id: i.inscriptionId || i.id || i.inscription_id || null,
    number: i.inscriptionNumber ?? i.number ?? null,
    sat: i.sat || i.satoshi || null,
    contentType: i.contentType || i.content_type || null,
    utxo: i.utxo || i.output || (i.txid != null ? `${i.txid}:${i.vout ?? i.n}` : null),
    raw: i,
  }));
}
