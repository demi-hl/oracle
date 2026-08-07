// Sanctum — Solana liquid staking token (LST) directory, APY, and TVL.
//
// Sanctum's extra-api is the keyless aggregate view across every LST in the
// Sanctum universe (JitoSOL, mSOL, bSOL, and the long tail of validator LSTs).
// Read-only: no stake, unstake, or swap preparation lives here.
//
// Endpoint shape notes learned the hard way:
//   - there is no /v1/apy/indiv; the individual read is the same batch
//     endpoint with one lst= parameter
//   - every apy/tvl endpoint REQUIRES at least one lst= query parameter and
//     returns HTTP 400 "missing field lst" without one
//   - lst= accepts either the symbol (jitoSOL) or the mint

import { httpJson } from "../http.mjs";

export const SANCTUM_API = "https://extra-api.sanctum.so";
// Sanctum's own batch ceiling — larger queries start dropping entries.
const MAX_BATCH = 30;

export const SANCTUM_MAJOR_LSTS = ["jitoSOL", "mSOL", "bSOL", "INF", "hSOL", "bonkSOL", "jupSOL", "dSOL"];

function base(opts = {}) {
  return String(opts.baseUrl || process.env.SANCTUM_API_URL || SANCTUM_API).replace(/\/$/, "");
}

function lstParam(value, label = "lst") {
  const text = String(value ?? "").trim();
  if (!text || /[?&=\s]/.test(text)) throw new Error(`sanctum-lst: ${label} must be an LST symbol or mint`);
  return text;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function batched(path, lsts, opts = {}) {
  const merged = {};
  const errs = {};
  for (const group of chunk(lsts, MAX_BATCH)) {
    const url = new URL(`${base(opts)}/v1/${path}`);
    for (const lst of group) url.searchParams.append("lst", lst);
    const data = await httpJson(url.toString(), {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 20_000,
    });
    // Each endpoint names its payload differently (apys / tvls / solValues).
    const payload = data?.apys || data?.tvls || data?.solValues || {};
    Object.assign(merged, payload);
    Object.assign(errs, data?.errs || {});
  }
  return { values: merged, errs };
}

export async function sanctumHealth(opts = {}) {
  try {
    // Probe the directory AND a live APY read — the directory alone can serve
    // from cache while the pricing side is down.
    const [directory, apy] = await Promise.all([
      httpJson(`${base(opts)}/v1/lsts`, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs ?? 15_000 }),
      batched("apy/inception", ["jitoSOL"], opts),
    ]);
    const lsts = Array.isArray(directory?.lsts) ? directory.lsts : [];
    return {
      ok: lsts.length > 0 && Number.isFinite(Number(apy.values.jitoSOL)),
      provider: "sanctum-lst",
      lstCount: lsts.length,
      jitoSolApyInception: Number(apy.values.jitoSOL) ?? null,
      exec: false,
    };
  } catch (error) {
    return { ok: false, provider: "sanctum-lst", error: String(error?.message || error), exec: false };
  }
}

export async function sanctumLstList(args = {}, opts = {}) {
  const data = await httpJson(`${base(opts)}/v1/lsts`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
  let lsts = (Array.isArray(data?.lsts) ? data.lsts : []).map((l) => ({
    symbol: l.symbol || null,
    name: l.name || null,
    mint: l.mint || null,
    decimals: l.decimals ?? null,
    pool: l.pool?.pool || null,
    poolProgram: l.pool?.program || null,
    voteAccount: l.pool?.vote_account || null,
    logoUri: l.logo_uri || null,
  }));
  if (args.symbol) {
    const want = String(args.symbol).toLowerCase();
    lsts = lsts.filter((l) => String(l.symbol || "").toLowerCase() === want || l.mint === args.symbol);
  }
  const limit = Number(args.limit);
  if (Number.isFinite(limit) && limit > 0) lsts = lsts.slice(0, limit);
  return { provider: "sanctum-lst", chain: "solana-mainnet-beta", count: lsts.length, lsts };
}

/**
 * APY across a set of LSTs. Defaults to the major LSTs rather than all 240+,
 * because the full universe costs 9 upstream round-trips.
 *
 * `latest` is the current-epoch figure and legitimately reads 0 early in an
 * epoch before enough samples land; `inception` is the since-launch figure and
 * is the number to trust for ranking. Both are returned.
 */
export async function sanctumApyAll(args = {}, opts = {}) {
  let symbols = args.lsts || args.symbols || null;
  if (args.all === true) {
    const directory = await sanctumLstList({}, opts);
    symbols = directory.lsts.map((l) => l.symbol).filter(Boolean);
  }
  if (!Array.isArray(symbols) || !symbols.length) symbols = SANCTUM_MAJOR_LSTS;
  const list = [...new Set(symbols.map((s) => lstParam(s, "lsts[]")))];

  const [latest, inception] = await Promise.all([
    batched("apy/latest", list, opts),
    batched("apy/inception", list, opts),
  ]);

  const apys = list.map((symbol) => {
    const epoch = Number(latest.values[symbol]);
    const since = Number(inception.values[symbol]);
    return {
      lst: symbol,
      apyLatest: Number.isFinite(epoch) ? epoch : null,
      apyLatestPct: Number.isFinite(epoch) ? epoch * 100 : null,
      apyInception: Number.isFinite(since) ? since : null,
      apyInceptionPct: Number.isFinite(since) ? since * 100 : null,
      error: latest.errs[symbol] || inception.errs[symbol] || null,
    };
  });
  apys.sort((a, b) => (b.apyInception ?? -1) - (a.apyInception ?? -1));

  return {
    provider: "sanctum-lst",
    chain: "solana-mainnet-beta",
    count: apys.length,
    apys,
    byLst: Object.fromEntries(apys.map((a) => [a.lst, a])),
  };
}

/**
 * Full picture for one LST: current + inception APY, TVL in lamports, and the
 * SOL value of one token (the number that reveals accrued staking value).
 */
export async function sanctumApyIndividual(args = {}, opts = {}) {
  const lst = lstParam(args.lst || args.mint || args.symbol, "lst");
  const [latest, inception, tvl, solValue] = await Promise.all([
    batched("apy/latest", [lst], opts),
    batched("apy/inception", [lst], opts),
    batched("tvl/current", [lst], opts).catch(() => ({ values: {}, errs: {} })),
    batched("sol-value/current", [lst], opts).catch(() => ({ values: {}, errs: {} })),
  ]);
  const epoch = Number(latest.values[lst]);
  const since = Number(inception.values[lst]);
  const err = latest.errs[lst] || inception.errs[lst] || null;
  if (!Number.isFinite(epoch) && !Number.isFinite(since)) {
    throw new Error(`sanctum-lst: no APY for ${lst}${err ? ` (${JSON.stringify(err)})` : ""}`);
  }
  const solValueRaw = solValue.values[lst];
  return {
    provider: "sanctum-lst",
    chain: "solana-mainnet-beta",
    lst,
    apyLatest: Number.isFinite(epoch) ? epoch : null,
    apyLatestPct: Number.isFinite(epoch) ? epoch * 100 : null,
    apyInception: Number.isFinite(since) ? since : null,
    apyInceptionPct: Number.isFinite(since) ? since * 100 : null,
    tvlLamports: tvl.values[lst] ?? null,
    tvlSol: tvl.values[lst] != null ? Number(tvl.values[lst]) / 1e9 : null,
    // Lamports of SOL backing one LST token (9 decimals).
    solValueLamports: solValueRaw ?? null,
    solPerToken: solValueRaw != null ? Number(solValueRaw) / 1e9 : null,
    error: err,
  };
}
