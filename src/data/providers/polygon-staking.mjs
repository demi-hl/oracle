// Polygon PoS staking — public validator set via staking-api.polygon.technology.
// Read-only, keyless. No delegation, no signing: this module reports validator
// state only.
//
// PRECISION NOTE: the upstream API serves stake fields as JSON *numbers* in
// wei-scale (e.g. 2.50090722768676e+24), so the low-order digits are already
// gone before Oracle sees them — a float64 carries ~15-17 significant digits and
// these values need 25. Re-deriving a BigInt from that float would manufacture
// exact-looking digits the API never sent. So the raw value is passed through
// untouched and the human-scale POL figure is presented as an approximation.
// Never treat these as settlement-grade amounts; read stake on-chain for that.

import { httpJson } from "../http.mjs";

export const POLYGON_STAKING_API = "https://staking-api.polygon.technology/api/v2";

/** POL/MATIC is an 18-decimal token. */
export const POL_DECIMALS = 18;

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** Numeric fields sorting is applied to, client-side. */
const SORTABLE = new Set([
  "id",
  "totalStaked",
  "selfStake",
  "delegatedStake",
  "commissionPercent",
  "uptimePercent",
  "performanceIndex",
]);

function base(opts = {}) {
  return String(opts.baseUrl || process.env.POLYGON_STAKING_API_URL || POLYGON_STAKING_API).replace(/\/$/, "");
}

/** Validator ids are small positive integers in the Polygon staking registry. */
export function validatorId(value, label = "id") {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw new Error(`polygon-staking: ${label} must be a positive integer validator id`);
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`polygon-staking: ${label} must be a positive integer validator id`);
  return n;
}

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(n)));
}

/**
 * wei-scale float -> approximate whole-token number. Lossy by construction (see
 * the precision note above); the caller gets the raw field alongside it.
 */
function toPolApprox(weiish) {
  const n = Number(weiish);
  if (!Number.isFinite(n)) return null;
  return n / 10 ** POL_DECIMALS;
}

async function get(path, opts = {}) {
  const body = await httpJson(`${base(opts)}${path.startsWith("/") ? path : `/${path}`}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
  if (typeof body === "string") {
    throw new Error(`polygon-staking GET ${path}: non-JSON response`);
  }
  // Upstream envelope: { success, result, summary?, status }. A false `success`
  // still arrives as HTTP 200, so httpJson cannot catch it — check it here.
  if (body?.success === false) {
    const detail = body?.message || body?.error || body?.status || "request rejected";
    throw new Error(`polygon-staking GET ${path}: ${detail}`);
  }
  return body;
}

/** Normalize one upstream validator record into a stable shape. */
export function normalizeValidator(raw = {}) {
  return {
    id: raw.id ?? null,
    name: typeof raw.name === "string" ? raw.name.trim() : null,
    status: raw.status ?? null,
    currentState: raw.currentState ?? null,
    owner: raw.owner ?? null,
    signer: raw.signer ?? null,
    contractAddress: raw.contractAddress ?? null,
    commissionPercent: raw.commissionPercent ?? null,
    uptimePercent: raw.uptimePercent ?? null,
    performanceIndex: raw.performanceIndex ?? null,
    delegationEnabled: raw.delegationEnabled ?? null,
    activationEpoch: raw.activationEpoch ?? null,
    deactivationEpoch: raw.deactivationEpoch ?? null,
    jailEndEpoch: raw.jailEndEpoch ?? null,
    missedLatestCheckpointCount: raw.missedLatestCheckpointcount ?? null,
    // Stake: raw passthrough + lossy human-scale companion. See precision note.
    totalStakedRaw: raw.totalStaked ?? null,
    selfStakeRaw: raw.selfStake ?? null,
    delegatedStakeRaw: raw.delegatedStake ?? null,
    totalStakedPolApprox: toPolApprox(raw.totalStaked),
    selfStakePolApprox: toPolApprox(raw.selfStake),
    delegatedStakePolApprox: toPolApprox(raw.delegatedStake),
    stakePrecision: "approximate — upstream serves wei-scale as float64",
  };
}

/**
 * Validator set.
 *
 * UPSTREAM QUIRK (verified against the live API): /validators ignores `limit`,
 * `offset`, `sortBy` and `direction` — it always returns the entire set and
 * echoes a canned summary of {limit:200, offset:0}. Forwarding those params
 * would make `limit:3` quietly return 105 rows, so pagination and sorting are
 * applied CLIENT-SIDE here against the full response. `total` below is the true
 * upstream count, not the length of the returned page.
 *
 * @param {{ limit?: number, offset?: number, sortBy?: string, direction?: string,
 *           status?: string, currentState?: string, delegationEnabled?: boolean,
 *           raw?: boolean }} [args]
 */
export async function validators(args = {}, opts = {}) {
  const body = await get("/validators", opts);
  let rows = Array.isArray(body?.result) ? body.result : [];
  const upstreamTotal = body?.summary?.total ?? rows.length;

  if (args.status) {
    const want = String(args.status).toLowerCase();
    rows = rows.filter((v) => String(v?.status || "").toLowerCase() === want);
  }
  if (args.currentState) {
    const want = String(args.currentState).toUpperCase();
    rows = rows.filter((v) => String(v?.currentState || "").toUpperCase() === want);
  }
  if (args.delegationEnabled != null) {
    const want = Boolean(args.delegationEnabled);
    rows = rows.filter((v) => Boolean(v?.delegationEnabled) === want);
  }

  const sortBy = SORTABLE.has(String(args.sortBy)) ? String(args.sortBy) : "id";
  const desc = String(args.direction || "").toUpperCase() === "DESC";
  rows = [...rows].sort((a, b) => {
    const x = Number(a?.[sortBy] ?? 0);
    const y = Number(b?.[sortBy] ?? 0);
    const cmp = Number.isFinite(x) && Number.isFinite(y) ? x - y : 0;
    return desc ? -cmp : cmp;
  });

  const matched = rows.length;
  const offset = Math.max(0, Math.trunc(Number(args.offset || 0)) || 0);
  const limit = clampLimit(args.limit);
  const page = rows.slice(offset, offset + limit);

  return {
    provider: "polygon-staking",
    chainId: 137,
    count: page.length,
    matched,
    total: upstreamTotal,
    limit,
    offset,
    sortBy,
    direction: desc ? "DESC" : "ASC",
    paginatedBy: "client — upstream /validators ignores limit/offset",
    validators: args.raw ? page : page.map(normalizeValidator),
  };
}

/**
 * Single validator detail. Returns the richer per-validator record (delegator
 * counts, unclaimed rewards, checkpoint history).
 *
 * @param {{ id?: number|string, validatorId?: number|string, raw?: boolean }} [args]
 */
export async function validatorDetail(args = {}, opts = {}) {
  const id = validatorId(args.id ?? args.validatorId, "id");
  const body = await get(`/validators/${id}`, opts);
  const raw = body?.result;
  if (!raw || typeof raw !== "object") {
    throw new Error(`polygon-staking: validator ${id} not found`);
  }
  return {
    provider: "polygon-staking",
    chainId: 137,
    id,
    validator: args.raw ? raw : {
      ...normalizeValidator(raw),
      delegatorCount: raw.delegatorCount ?? null,
      checkpointsSigned: raw.checkpointsSigned ?? null,
      checkpointsMissed: raw.checkpointsMissed ?? null,
      isInAuction: raw.isInAuction ?? null,
      auctionAmount: raw.auctionAmount ?? null,
      delegatorUnclaimedRewardsRaw: raw.delegatorUnclaimedRewards ?? null,
      validatorUnclaimedRewardsRaw: raw.validatorUnclaimedRewards ?? null,
      claimedRewardRaw: raw.claimedReward ?? null,
      description: typeof raw.description === "string" ? raw.description : null,
      logoUrl: raw.logoUrl ?? null,
    },
    raw: args.raw ? undefined : raw,
  };
}

export async function health(opts = {}) {
  try {
    // Upstream ignores limit, so this is the full set either way.
    const body = await get("/validators", { ...opts, timeoutMs: opts.timeoutMs ?? 10_000 });
    const rows = Array.isArray(body?.result) ? body.result : [];
    return {
      ok: rows.length > 0,
      provider: "polygon-staking",
      chainId: 137,
      baseUrl: base(opts),
      validatorTotal: body?.summary?.total ?? rows.length,
      exec: false,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "polygon-staking",
      chainId: 137,
      baseUrl: base(opts),
      error: String(error?.message || error),
      exec: false,
    };
  }
}
