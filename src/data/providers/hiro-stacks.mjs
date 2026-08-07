// Stacks (Bitcoin L2) via Hiro's public API — keyless.
//
// Stacks is the Bitcoin L2 whose consensus (PoX) recycles BTC: stackers lock
// STX and are paid in BTC by miners who bid BTC for block rights. So the two
// interesting reads are network liveness and the PoX cycle state.
//
// Verified live:
//   GET /v2/info                200  node/chain tip + burn block height
//   GET /v2/pox                 200  PoX params, current cycle, stacked totals
//   GET /extended/v2/blocks     200  recent blocks (limit param)
//   GET /extended/v2/pox/cycles 200  historical cycle table
//
// RATE LIMIT: Hiro serves the keyless tier at ~20 requests/second per IP.
// Exceeding it returns 429; http.mjs honours Retry-After and backs off. Set
// HIRO_API_KEY only if the operator has a paid Hiro plan — it is not required.

import { httpJson } from "../http.mjs";

export const HIRO_API_URL = "https://api.hiro.so";
/** Documented keyless ceiling. Callers batching loops should stay under this. */
export const HIRO_RATE_LIMIT_RPS = 20;

function baseUrl(opts = {}) {
  return String(opts.baseUrl || process.env.HIRO_API_URL || HIRO_API_URL).replace(/\/$/, "");
}

function headers(opts = {}) {
  const h = { Accept: "application/json" };
  const key = opts.apiKey || process.env.HIRO_API_KEY;
  // Optional: raises the shared 20 rps ceiling. Absent by design in the
  // keyless posture — never required.
  if (key) h["x-api-key"] = String(key);
  return h;
}

function get(path, opts = {}) {
  return httpJson(`${baseUrl(opts)}${path.startsWith("/") ? path : `/${path}`}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
    headers: headers(opts),
  });
}

export async function stacksHealth(opts = {}) {
  try {
    const info = await get("/v2/info", opts);
    const burn = Number(info?.burn_block_height ?? 0);
    return {
      ok: Number.isFinite(burn) && burn > 0,
      provider: "hiro-stacks",
      baseUrl: baseUrl(opts),
      burnBlockHeight: info?.burn_block_height ?? null,
      stacksTipHeight: info?.stacks_tip_height ?? null,
      serverVersion: info?.server_version ?? null,
      rateLimitRps: HIRO_RATE_LIMIT_RPS,
      keyed: Boolean(opts.apiKey || process.env.HIRO_API_KEY),
      exec: false,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "hiro-stacks",
      baseUrl: baseUrl(opts),
      error: String(error?.message || error),
      exec: false,
    };
  }
}

export async function stacksNetworkInfo(_args = {}, opts = {}) {
  const info = await get("/v2/info", opts);
  return {
    provider: "hiro-stacks",
    peerVersion: info.peer_version ?? null,
    serverVersion: info.server_version ?? null,
    networkId: info.network_id ?? null,
    burnBlockHeight: info.burn_block_height ?? null,
    stableBurnBlockHeight: info.stable_burn_block_height ?? null,
    stacksTipHeight: info.stacks_tip_height ?? null,
    stacksTip: info.stacks_tip ?? null,
    poxConsensus: info.pox_consensus ?? null,
    raw: info,
  };
}

/** PoX state: the BTC-yield mechanism. Cycle number, stacked totals, thresholds. */
export async function stacksStackingInfo(_args = {}, opts = {}) {
  const pox = await get("/v2/pox", opts);
  const total = Number(pox.total_liquid_supply_ustx || 0);
  const stacked = Number(pox.current_cycle?.stacked_ustx || 0);
  return {
    provider: "hiro-stacks",
    contractId: pox.contract_id ?? null,
    currentCycleId: pox.current_cycle?.id ?? null,
    currentCycleStackedUstx: pox.current_cycle?.stacked_ustx == null ? null : String(pox.current_cycle.stacked_ustx),
    currentCycleIsPoX: pox.current_cycle?.is_pox_active ?? null,
    nextCycleId: pox.next_cycle?.id ?? null,
    nextCycleStackedUstx: pox.next_cycle?.stacked_ustx == null ? null : String(pox.next_cycle.stacked_ustx),
    nextCycleMinThresholdUstx: pox.next_cycle?.min_threshold_ustx == null ? null : String(pox.next_cycle.min_threshold_ustx),
    blocksUntilNextCycle: pox.next_cycle?.blocks_until_prepare_phase ?? null,
    minAmountUstx: pox.min_amount_ustx == null ? null : String(pox.min_amount_ustx),
    totalLiquidSupplyUstx: pox.total_liquid_supply_ustx == null ? null : String(pox.total_liquid_supply_ustx),
    participationPct: total > 0 ? (stacked / total) * 100 : null,
    rewardCycleLength: pox.reward_cycle_length ?? null,
    rewardSlots: pox.reward_slots ?? null,
    currentBurnchainBlockHeight: pox.current_burnchain_block_height ?? null,
    raw: pox,
  };
}

/** Historical PoX cycles (newest first). */
export async function stacksPoxCycles(args = {}, opts = {}) {
  const limit = Math.min(60, Math.max(1, Number(args.limit || 20)));
  const offset = Math.max(0, Number(args.offset || 0));
  const res = await get(`/extended/v2/pox/cycles?limit=${limit}&offset=${offset}`, opts);
  const rows = Array.isArray(res?.results) ? res.results : [];
  return {
    provider: "hiro-stacks",
    total: res?.total ?? null,
    limit,
    offset,
    cycles: rows.map((c) => ({
      cycleNumber: c.cycle_number ?? null,
      blockHeight: c.block_height ?? null,
      totalStackedAmount: c.total_stacked_amount == null ? null : String(c.total_stacked_amount),
      totalWeight: c.total_weight ?? null,
      totalSigners: c.total_signers ?? null,
    })),
  };
}

/** Recent Stacks blocks. Cheap tip probe; default limit 1. */
export async function stacksBlocks(args = {}, opts = {}) {
  const limit = Math.min(30, Math.max(1, Number(args.limit || 1)));
  const res = await get(`/extended/v2/blocks?limit=${limit}`, opts);
  const rows = Array.isArray(res?.results) ? res.results : [];
  return {
    provider: "hiro-stacks",
    total: res?.total ?? null,
    limit,
    blocks: rows.map((b) => ({
      height: b.height ?? null,
      hash: b.hash ?? null,
      burnBlockHeight: b.burn_block_height ?? null,
      burnBlockTime: b.burn_block_time ?? null,
      txCount: b.tx_count ?? null,
      canonical: b.canonical ?? null,
    })),
  };
}
