const SIGNAL_TYPES = Object.freeze([
  "wallet",
  "pool",
  "nft_floor",
  "hl_flow",
  "prediction_market",
]);

const TYPE_ALIASES = Object.freeze({
  wallets: "wallet",
  smart_wallet: "wallet",
  pools: "pool",
  new_pool: "pool",
  nft: "nft_floor",
  nft_floors: "nft_floor",
  hyperliquid: "hl_flow",
  prediction: "prediction_market",
  prediction_markets: "prediction_market",
});

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const round = (value) => Math.round(value * 10_000) / 10_000;

function typeOf(event) {
  const raw = String(event?.type ?? event?.surface ?? event?.kind ?? "").toLowerCase();
  return TYPE_ALIASES[raw] ?? raw;
}

function idOf(event, index) {
  return String(event?.id ?? event?.signalId ?? event?.asset ?? event?.market ?? event?.pool ?? event?.collection ?? `${typeOf(event)}:${index}`);
}

function add(contributions, feature, value, observed = true) {
  if (!observed || value === null || !Number.isFinite(value)) return;
  contributions.push({ feature, value: round(value) });
}

function walletFeatures(event, out) {
  const buys = finite(event.repeatBuys ?? event.repeat_buys ?? event.buyCount);
  const winRate = finite(event.walletWinRate ?? event.winRate);
  add(out, "repeat_buys", buys === null ? null : clamp((buys - 1) / 4) * 0.38);
  add(out, "wallet_win_rate", winRate === null ? null : (clamp(winRate) - 0.5) * 0.5);
}

function poolFeatures(event, out) {
  const age = finite(event.ageHours ?? event.poolAgeHours);
  const liquidity = finite(event.liquidityUsd ?? event.liquidity);
  const locked = event.liquidityLocked ?? event.locked;
  add(out, "pool_age", age === null ? null : age < 24 ? -0.42 : clamp(age / 720) * 0.12);
  add(out, "liquidity", liquidity === null ? null : (clamp(Math.log10(Math.max(1, liquidity)) / 7) - 0.5) * 0.28);
  add(out, "liquidity_lock", locked == null ? null : locked ? 0.12 : -0.28);
}

function nftFeatures(event, out) {
  const change = finite(event.floorChange ?? event.floorChangePct);
  const sales = finite(event.sales ?? event.saleCount);
  add(out, "floor_change", change === null ? null : clamp(change, -1, 1) * 0.35);
  add(out, "sales_depth", sales === null ? null : clamp(sales / 50) * 0.18);
}

function hlFeatures(event, out) {
  const imbalance = finite(event.flowImbalance ?? event.imbalance);
  const funding = finite(event.fundingRate ?? event.funding);
  add(out, "flow_imbalance", imbalance === null ? null : clamp(imbalance, -1, 1) * 0.42);
  add(out, "funding", funding === null ? null : -clamp(funding * 100, -1, 1) * 0.12);
}

function predictionFeatures(event, out) {
  const market = finite(event.marketProbability ?? event.marketPrice ?? event.probability);
  const fair = finite(event.fairProbability ?? event.referenceProbability ?? event.fairValue);
  add(out, "probability_mispricing", market === null || fair === null ? null : clamp(fair - market, -1, 1) * 0.65);
  const liquidity = finite(event.liquidityUsd ?? event.liquidity);
  add(out, "market_liquidity", liquidity === null ? null : clamp(Math.log10(Math.max(1, liquidity)) / 6) * 0.12);
}

const FEATURE_BUILDERS = Object.freeze({
  wallet: walletFeatures,
  pool: poolFeatures,
  nft_floor: nftFeatures,
  hl_flow: hlFeatures,
  prediction_market: predictionFeatures,
});

function markoutFor(event, id, markouts) {
  const rows = markouts.filter((row) => {
    const target = row?.signalId ?? row?.eventId ?? row?.id ?? row?.asset ?? row?.market;
    return target != null && String(target) === id;
  });
  if (rows.length === 0) return null;
  const values = rows.map((row) => finite(row.return ?? row.markout ?? row.pnl ?? row.value)).filter((value) => value !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Pure, deterministic scoring of observed onchain events. It never fetches data or executes. */
export function scoreSignals(events = [], markouts = [], options = {}) {
  if (!Array.isArray(events) || !Array.isArray(markouts)) throw new TypeError("events and markouts must be arrays");
  const minimumCoverage = clamp(finite(options.minimumCoverage) ?? 0.5);

  return events.map((event, index) => {
    const type = typeOf(event);
    const id = idOf(event, index);
    const builder = FEATURE_BUILDERS[type];
    const contributions = [];
    if (builder) builder(event, contributions);

    const expected = type === "wallet" ? 2 : type === "pool" ? 3 : 2;
    const coverage = round(clamp(contributions.length / expected));
    const rawFeatureScore = contributions.reduce((sum, item) => sum + item.value, 0);
    const markout = markoutFor(event, id, markouts);
    const markoutContribution = markout === null ? 0 : clamp(markout, -1, 1) * 0.35;
    if (markout !== null) add(contributions, "shadow_markout", markoutContribution);
    const score = round(clamp(0.5 + rawFeatureScore + markoutContribution));
    const markoutFactor = markout === null ? 0.8 : clamp(0.85 + markout * 0.3, 0.35, 1);
    const confidence = round(clamp(coverage * markoutFactor));
    const flags = ["COLD_INTELLIGENCE_ONLY", "NO_HOT_EXECUTION"];
    if (!builder) flags.push("UNSUPPORTED_SIGNAL_TYPE");
    if (coverage < minimumCoverage) flags.push("LOW_COVERAGE", "NO_TRADE");
    if (confidence < 0.5) flags.push("LOW_CONFIDENCE", "NO_TRADE");
    if (type === "pool" && (finite(event.ageHours ?? event.poolAgeHours) ?? Infinity) < 24) flags.push("NEW_POOL_RISK", "NO_TRADE");
    if (markout !== null && markout < 0) flags.push("NEGATIVE_MARKOUT");

    return {
      id,
      type,
      score,
      confidence,
      coverage,
      contributions,
      flags: [...new Set(flags)],
      noTrade: flags.includes("NO_TRADE"),
      executionAllowed: false,
    };
  }).sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.id.localeCompare(b.id));
}

export function createSignalsEngine(defaults = {}) {
  return Object.freeze({
    score(events, markouts = [], options = {}) {
      return scoreSignals(events, markouts, { ...defaults, ...options });
    },
  });
}

export { SIGNAL_TYPES };
