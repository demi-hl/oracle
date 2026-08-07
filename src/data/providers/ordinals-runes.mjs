// Ordinals + Runes reads via a public `ord` server (ordinals.com) — keyless.
//
// Complements bitcoin-meta: that module covers inscription metadata and the
// keyed indexer gap; this one covers the ord server's block/sat/rune index.
//
// Verified live against ordinals.com:
//   GET /r/blockheight            200  PLAIN TEXT integer, not JSON
//   GET /r/blockhash              200  JSON string
//   GET /r/blockinfo/{height}     200  JSON
//   GET /r/sat/{sat}              200  JSON { ids, more, page }
//   GET /rune/{NAME}              200  JSON  (Accept: application/json required)
//
// KNOWN LIMITS (measured, not assumed):
//   - /runes (the index listing) returns 406 "JSON API disabled" on
//     ordinals.com. Only the per-rune route works, so there is no listAll op.
//   - /r/rune/... and /r/runes/... are 404 on this host — the rune route is
//     the non-recursive /rune/{NAME}.
//   - Rune names must be sent WITHOUT the • spacer (UNCOMMONGOODS, not
//     UNCOMMON•GOODS); the spaced form 406s. Normalized below.

import { httpJson } from "../http.mjs";

export const ORDINALS_BASE = "https://ordinals.com";

function baseUrl(opts = {}) {
  return String(opts.baseUrl || opts.ordinalsBase || process.env.ORDINALS_BASE_URL || ORDINALS_BASE).replace(/\/$/, "");
}

/**
 * Strip the spacer characters ord renders for display. The API indexes the
 * bare name; sending the pretty form is a 406.
 */
export function normalizeRuneName(value, label = "name") {
  const text = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[•.\s_-]/g, "");
  if (!/^[A-Z]{1,28}$/.test(text)) {
    throw new Error(`ordinals-runes: ${label} must be 1-28 letters (spacers are stripped automatically)`);
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
  if (!res.ok) throw new Error(`ordinals-runes GET ${path}: HTTP ${res.status} ${text.slice(0, 160)}`);
  return text.trim();
}

function getJson(path, opts = {}) {
  return httpJson(`${baseUrl(opts)}${path.startsWith("/") ? path : `/${path}`}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
    // ord serves HTML to browsers and JSON only when explicitly asked.
    headers: { Accept: "application/json" },
  });
}

export async function ordHealth(opts = {}) {
  try {
    const text = await getText("/r/blockheight", opts);
    const height = Number(text);
    return {
      ok: Number.isFinite(height) && height > 0,
      provider: "ordinals-runes",
      baseUrl: baseUrl(opts),
      blockHeight: height,
      exec: false,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "ordinals-runes",
      baseUrl: baseUrl(opts),
      error: String(error?.message || error),
      exec: false,
    };
  }
}

/** Indexed tip height. Endpoint returns PLAIN TEXT, so this does not JSON.parse. */
export async function ordBlockHeight(_args = {}, opts = {}) {
  const text = await getText("/r/blockheight", opts);
  const height = Number(text);
  if (!Number.isFinite(height)) throw new Error(`ordinals-runes: unexpected blockheight response ${text.slice(0, 60)}`);
  return { provider: "ordinals-runes", blockHeight: height };
}

export async function ordBlockInfo(args = {}, opts = {}) {
  const raw = args.height ?? args.block ?? args.hash;
  if (raw == null || raw === "") throw new Error("ordinals-runes: blockInfo requires height or hash");
  let ref;
  if (/^[0-9a-f]{64}$/i.test(String(raw))) {
    ref = String(raw).toLowerCase();
  } else {
    const h = Number(raw);
    if (!Number.isInteger(h) || h < 0) throw new Error("ordinals-runes: height must be a non-negative integer or a 64-hex block hash");
    ref = String(h);
  }
  const info = await getJson(`/r/blockinfo/${ref}`, opts);
  return {
    provider: "ordinals-runes",
    height: info.height ?? null,
    hash: info.hash ?? null,
    timestamp: info.timestamp ?? null,
    difficulty: info.difficulty ?? null,
    transactionCount: info.transaction_count ?? null,
    averageFee: info.average_fee ?? null,
    averageFeeRate: info.average_fee_rate ?? null,
    feerangeSats: info.feerange ?? null,
    totalFee: info.total_fee ?? null,
    totalSize: info.total_size ?? null,
    confirmations: info.confirmations ?? null,
    raw: info,
  };
}

/** Inscriptions bound to a given sat ordinal. Empty ids[] means an unused sat. */
export async function ordSatInfo(args = {}, opts = {}) {
  const sat = args.sat ?? args.ordinal;
  const n = Number(sat);
  // 2.1 quadrillion sats total supply — reject out-of-range early rather than
  // paying a round trip for a 400.
  if (!Number.isInteger(n) || n < 0 || n > 2_099_999_997_690_000) {
    throw new Error("ordinals-runes: sat must be an integer in [0, 2099999997690000]");
  }
  const page = Math.max(0, Number(args.page || 0));
  const path = page > 0 ? `/r/sat/${n}/${page}` : `/r/sat/${n}`;
  const info = await getJson(path, opts);
  const ids = Array.isArray(info?.ids) ? info.ids : [];
  return {
    provider: "ordinals-runes",
    sat: n,
    page,
    inscriptionCount: ids.length,
    inscriptionIds: ids,
    more: Boolean(info?.more),
    raw: info,
  };
}

/**
 * Per-rune entry: supply, mint terms, divisibility, mint progress.
 * Only the per-rune route is available keylessly — see the 406 note at the top.
 */
export async function ordRuneInfo(args = {}, opts = {}) {
  const name = normalizeRuneName(args.name || args.rune || args.runeName, "name");
  const info = await getJson(`/rune/${name}`, opts);
  const e = info?.entry || {};
  const terms = e.terms || {};
  const cap = terms.cap == null ? null : Number(terms.cap);
  const mints = e.mints == null ? null : Number(e.mints);
  return {
    provider: "ordinals-runes",
    name,
    spacedRune: e.spaced_rune ?? null,
    number: e.number ?? null,
    symbol: e.symbol ?? null,
    divisibility: e.divisibility ?? null,
    etchingBlock: e.block ?? null,
    etchingTxid: e.etching ?? null,
    premine: e.premine == null ? null : String(e.premine),
    mints: mints == null ? null : String(mints),
    burned: e.burned == null ? null : String(e.burned),
    mintCap: cap == null ? null : String(cap),
    mintProgressPct: cap && cap > 0 && mints != null ? (mints / cap) * 100 : null,
    mintable: info?.mintable ?? null,
    amountPerMint: terms.amount == null ? null : String(terms.amount),
    turbo: e.turbo ?? null,
    parent: info?.parent ?? null,
    raw: info,
  };
}
