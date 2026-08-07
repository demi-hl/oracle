// Telegram card TEXT renderers.
//
// Implements skills/oracle-chain-graphs-telegram-cards/SKILL.md. That spec has
// existed with no code behind it, so Oracle users were getting raw JSON instead
// of readable alert cards. This module is the text half only: chart/image
// rendering lives elsewhere and MUST NOT be required for a card to send.
//
// Contract for every exported renderer:
//   - pure, synchronous, string in / string out
//   - NO network, NO signing, NO filesystem, NO env reads, NO mutation of input
//   - unknown data renders as the literal string UNKNOWN — never blank, never
//     guessed, never interpolated from a neighbouring field
//   - the only identifier (contract address / mint / market id) is NEVER
//     truncated: a half-address is worse than no address because it still looks
//     actionable
//   - chart failure is cosmetic: the text card always returns
//   - buy/sell affordances only when a valid local grant/session is supplied
//
// Markdown dialect: Telegram *legacy* Markdown. Values are escaped for `_`,
// `*`, `[`, `]` and backtick; card chrome supplies its own markers. We never
// emit `$` at all (the spec calls out repeated `$` spans as a formatting trap)
// — amounts are suffixed with USD instead.

import { chainById } from "./chains.mjs";

/** The one and only stand-in for missing data. */
export const UNKNOWN = "UNKNOWN";

export const CARD_KINDS = Object.freeze(["token", "launch", "hip3", "hip4", "polymarket", "twap", "bridge"]);

const LEGACY_MD_SPECIALS = /[_*[\]`]/g;

/**
 * Escape Telegram legacy-Markdown control characters in a *value*.
 * Card chrome (bold headers) is written unescaped by the renderers themselves.
 * @param {unknown} value
 * @returns {string} escaped text, or UNKNOWN when there is nothing to show
 */
export function escapeMd(value) {
  if (!isPresent(value)) return UNKNOWN;
  return String(value).replace(LEGACY_MD_SPECIALS, (c) => `\\${c}`);
}

function isPresent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

/** A value that must survive verbatim (addresses, mints, market ids). */
function code(value) {
  if (!isPresent(value)) return UNKNOWN;
  // Backticks would close the span; strip rather than truncate the identifier.
  const raw = String(value).replace(/`/g, "");
  return raw === "" ? UNKNOWN : `\`${raw}\``;
}

function num(value, { decimals = 2 } = {}) {
  if (!isPresent(value)) return UNKNOWN;
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isFinite(n)) return UNKNOWN;
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

/** Money. Deliberately no `$` — repeated dollar spans break Telegram parsing. */
function usd(value, { decimals = 2 } = {}) {
  const n = num(value, { decimals });
  return n === UNKNOWN ? UNKNOWN : `${n} USD`;
}

function pct(value, { decimals = 2 } = {}) {
  const n = num(value, { decimals });
  return n === UNKNOWN ? UNKNOWN : `${n}%`;
}

function bps(value) {
  const n = num(value, { decimals: 0 });
  return n === UNKNOWN ? UNKNOWN : `${n} bps`;
}

/**
 * Exact base-unit -> decimal string. BigInt only: a raw quote like
 * 24325001237995579150138 loses precision the moment it touches a float.
 */
export function formatUnits(raw, decimals) {
  if (!isPresent(raw)) return UNKNOWN;
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 77) return UNKNOWN;
  let value;
  try {
    value = BigInt(typeof raw === "string" ? raw.trim() : raw);
  } catch {
    return UNKNOWN;
  }
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(d);
  const whole = (abs / base).toString();
  const frac = (abs % base).toString().padStart(d, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Normalize confidence to a stated band. Every card must state one. */
export function normalizeConfidence(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0 || value > 1) return UNKNOWN;
    if (value >= 0.75) return "HIGH";
    if (value >= 0.4) return "MEDIUM";
    return "LOW";
  }
  if (typeof value === "string") {
    const v = value.trim().toUpperCase();
    if (v === "HIGH" || v === "MEDIUM" || v === "LOW") return v;
  }
  return UNKNOWN;
}

function chainLine(data = {}) {
  const id = data.chainId;
  if (!isPresent(id) || !Number.isFinite(Number(id))) {
    return isPresent(data.chain) ? escapeMd(data.chain) : UNKNOWN;
  }
  const known = chainById(id);
  const name = known?.name || (isPresent(data.chain) ? String(data.chain) : UNKNOWN);
  return `${escapeMd(name)} (chainId ${Number(id)})`;
}

function venueLine(data = {}) {
  return escapeMd(data.venue ?? data.dex ?? data.pool?.venue);
}

/**
 * Chart status. A graph is evidence, not a dependency — if the image failed we
 * say so and the text card still stands.
 */
function chartLine(chart) {
  if (chart === null || chart === undefined) return "NONE (text card only)";
  if (typeof chart === "string") return chart.trim() ? code(chart) : "NONE (text card only)";
  if (chart.error || chart.ok === false || chart.available === false) {
    const why = isPresent(chart.error) ? ` — ${escapeMd(chart.error)}` : "";
    return `UNAVAILABLE${why} (text card stands)`;
  }
  if (isPresent(chart.url)) return code(chart.url);
  return "NONE (text card only)";
}

/**
 * Buy/sell affordances are gated on a valid LOCAL grant or session. Absent or
 * expired grant => prepare-only. This function is the single gate; renderers
 * never decide on their own.
 * @returns {{ allowed: boolean, reason: string, actions: string[] }}
 */
export function cardActions(data = {}, { now = Date.now() } = {}) {
  const grant = data.grant ?? data.session ?? null;
  if (!grant || typeof grant !== "object") {
    return { allowed: false, reason: "no local grant/session", actions: [] };
  }
  if (grant.local === false) {
    return { allowed: false, reason: "grant is not local", actions: [] };
  }
  if (grant.revoked === true) {
    return { allowed: false, reason: "grant revoked", actions: [] };
  }
  const expiry = grant.expiresAt ?? grant.expiry;
  if (isPresent(expiry)) {
    const at = typeof expiry === "number" ? expiry : Date.parse(expiry);
    if (!Number.isFinite(at)) return { allowed: false, reason: "grant expiry unreadable", actions: [] };
    if (at <= now) return { allowed: false, reason: "grant expired", actions: [] };
  }
  const actions = Array.isArray(grant.actions) && grant.actions.length ? grant.actions.slice() : ["BUY", "SELL"];
  return { allowed: true, reason: "valid local grant", actions };
}

function actionsLine(data) {
  const gate = cardActions(data);
  return gate.allowed
    ? `${gate.actions.map((a) => escapeMd(a)).join(" / ")} (${escapeMd(gate.reason)})`
    : `prepare-only — ${escapeMd(gate.reason)}`;
}

function build(title, rows, data = {}) {
  const lines = [`*${title}*`];
  for (const [label, value] of rows) {
    // Labels are authored here and contain no markdown specials by construction.
    lines.push(`${label}: ${value === undefined || value === null || value === "" ? UNKNOWN : value}`);
  }
  lines.push(`Chart: ${chartLine(data.chart)}`);
  lines.push(`Actions: ${actionsLine(data)}`);
  if (Array.isArray(data.warnings) && data.warnings.length) {
    lines.push(`Warnings: ${data.warnings.map((w) => escapeMd(w)).join("; ")}`);
  }
  if (isPresent(data.source) || isPresent(data.fetchedAt)) {
    lines.push(`Source: ${escapeMd(data.source)} at ${escapeMd(data.fetchedAt)}`);
  }
  return lines.join("\n");
}

function confidenceRow(data) {
  return ["Confidence", normalizeConfidence(data.confidence)];
}

function quoteRows(data) {
  const q = data.quote;
  if (!q || typeof q !== "object") return [];
  const human = isPresent(q.decimals) ? formatUnits(q.amountOutRaw ?? q.out ?? q.raw, q.decimals) : UNKNOWN;
  return [
    ["Quote out (raw)", code(q.amountOutRaw ?? q.out ?? q.raw)],
    ["Quote out", human === UNKNOWN ? UNKNOWN : `${escapeMd(human)} ${escapeMd(q.symbol ?? "")}`.trim()],
  ];
}

function slippageRow(data) {
  const s = data.autoSlippage;
  if (!s || typeof s !== "object") return ["Auto-slippage", UNKNOWN];
  const sel = bps(s.selectedBps);
  const cap = bps(s.capBps);
  return ["Auto-slippage", sel === UNKNOWN && cap === UNKNOWN ? UNKNOWN : `${sel} selected, cap ${cap}`];
}

/** Per-chain token card: price, volume, liquidity, market cap, age, venue. */
export function renderTokenCard(data = {}) {
  const d = data || {};
  return build(
    `ORACLE TOKEN — ${escapeMd(d.symbol ?? d.token ?? d.name)}`,
    [
      ["Chain", chainLine(d)],
      ["Venue", venueLine(d)],
      ["Name", escapeMd(d.name)],
      ["Address", code(d.address ?? d.mint ?? d.contract)],
      ["Price", usd(d.priceUsd, { decimals: 8 })],
      ["Market cap", usd(d.marketCapUsd)],
      ["Liquidity", usd(d.liquidityUsd)],
      ["Volume 24h", usd(d.volume24hUsd)],
      ["Change 24h", pct(d.priceChange24h)],
      ["Fee tier", isPresent(d.feeTier) ? `${bps(Number(d.feeTier) / 100)} (${num(d.feeTier, { decimals: 0 })})` : UNKNOWN],
      ["Age", escapeMd(d.age)],
      ...quoteRows(d),
      slippageRow(d),
      confidenceRow(d),
    ],
    d,
  );
}

/** Launch/sniper card: route readiness, sellability, overlap, risk, ticket. */
export function renderLaunchCard(data = {}) {
  const d = data || {};
  return build(
    `ORACLE LAUNCH — ${escapeMd(d.symbol ?? d.token ?? d.name)}`,
    [
      ["Chain", chainLine(d)],
      ["Venue", venueLine(d)],
      ["Address", code(d.address ?? d.mint ?? d.contract)],
      ["Pool", code(d.pool?.address ?? d.poolAddress ?? d.pool)],
      ["Liquidity", usd(d.liquidityUsd)],
      ["Route ready", escapeMd(d.routeReady)],
      ["Sellable", escapeMd(d.sellable)],
      ["Sell sim", escapeMd(d.sellSimulation ?? d.sellSim)],
      ["Smart wallets", escapeMd(d.smartWalletOverlap)],
      ["Risk", escapeMd(d.risk ?? d.riskStatus)],
      ["Prepared ticket", escapeMd(d.preparedTicket ?? d.ticketStatus)],
      slippageRow(d),
      confidenceRow(d),
    ],
    d,
  );
}

/** Hyperliquid HIP-3 builder-dex card. Requires perpDexs + metaAndAssetCtxs. */
export function renderHip3Card(data = {}) {
  const d = data || {};
  return build(
    `ORACLE HIP-3 — ${escapeMd(d.market ?? d.coin ?? d.name)}`,
    [
      ["Venue", `Hyperliquid builder-dex ${escapeMd(d.dex)}`],
      ["Market", escapeMd(d.market ?? d.coin)],
      ["Mark", usd(d.markPx, { decimals: 6 })],
      ["Oracle", usd(d.oraclePx, { decimals: 6 })],
      ["Funding", pct(d.funding, { decimals: 6 })],
      ["Open interest", usd(d.openInterestUsd)],
      ["Depth", escapeMd(d.depth)],
      ["Liquidation notes", escapeMd(d.liquidationNotes ?? d.riskNotes)],
      ["Account context", escapeMd(d.accountContext)],
      confidenceRow(d),
    ],
    d,
  );
}

/** Hyperliquid HIP-4 outcome-market card. Public reads are keyless. */
export function renderHip4Card(data = {}) {
  const d = data || {};
  return build(
    `ORACLE HIP-4 — ${escapeMd(d.event ?? d.market ?? d.name)}`,
    [
      ["Venue", `Hyperliquid HIP-4 ${escapeMd(d.dex ?? "outcome")}`],
      ["Event", escapeMd(d.event)],
      ["Outcome", escapeMd(d.outcome)],
      ["Market id", code(d.marketId ?? d.market)],
      ["Bid", usd(d.bid, { decimals: 6 })],
      ["Ask", usd(d.ask, { decimals: 6 })],
      ["Depth", escapeMd(d.depth)],
      ["Edge", pct(d.edge)],
      ["Position", escapeMd(d.position)],
      confidenceRow(d),
    ],
    d,
  );
}

/** Polymarket card. Public reads keyless; orders stay prepared/user-signed. */
export function renderPolymarketCard(data = {}) {
  const d = data || {};
  return build(
    `ORACLE POLYMARKET — ${escapeMd(d.event ?? d.market ?? d.name)}`,
    [
      ["Venue", "Polymarket CLOB"],
      ["Event", escapeMd(d.event)],
      ["Market", escapeMd(d.market)],
      ["Market id", code(d.marketId ?? d.conditionId ?? d.tokenId)],
      ["Yes", usd(d.yesPrice, { decimals: 4 })],
      ["No", usd(d.noPrice, { decimals: 4 })],
      ["Best bid / ask", `${usd(d.bestBid, { decimals: 4 })} / ${usd(d.bestAsk, { decimals: 4 })}`],
      ["Volume", usd(d.volumeUsd)],
      ["Resolution risk", escapeMd(d.resolutionRisk)],
      ["Order intent", escapeMd(d.orderIntent)],
      confidenceRow(d),
    ],
    d,
  );
}

/** TWAP DCA card: buy or sell accumulation/exit strategy. */
export function renderTwapCard(data = {}) {
  const d = data || {};
  const progress = isPresent(d.completedSplits) && isPresent(d.totalSplits)
    ? `${num(d.completedSplits, { decimals: 0 })} / ${num(d.totalSplits, { decimals: 0 })}`
    : UNKNOWN;
  return build(
    `ORACLE TWAP — ${escapeMd(d.pair ?? d.symbol ?? d.name)}`,
    [
      ["Chain", chainLine(d)],
      ["Side", escapeMd(d.side ?? d.direction)],
      ["Amount", `${escapeMd(formatUnits(d.amountTotal ?? d.amount, d.decimals ?? 18))} ${escapeMd(d.symbol ?? "")}`.trim()],
      ["Splits", `${num(d.totalSplits, { decimals: 0 })} over ${escapeMd(d.window)}`],
      ["Progress", progress],
      ["Avg price", usd(d.averagePrice, { decimals: 6 })],
      ["Next split", escapeMd(d.nextSplitAt)],
      ["Slippage cap", bps(d.slippageBps)],
      ["Status", escapeMd(d.status)],
      confidenceRow(d),
    ],
    d,
  );
}

/** Bridge + revoke card: deBridge · LI.FI · revoke.cash integration. */
export function renderBridgeCard(data = {}) {
  const d = data || {};
  const approval = d.approval ?? d.revokeCheck ?? {};
  const revokeUrl = approval.needsRevoke && approval.spender
    ? `revoke.cash — ${escapeMd(approval.spender)}`
    : approval.needsRevoke === false ? "revoke.cash — clean" : "revoke.cash — unchecked";
  return build(
    `ORACLE BRIDGE — ${escapeMd(d.pair ?? d.fromSymbol)} → ${escapeMd(d.toSymbol ?? "")}`.replace(/→ $/, ""),
    [
      ["Bridging", "deBridge · LI.FI — best route wins"],
      ["From chain", chainLine({ chainId: d.fromChainId, chain: d.fromChain })],
      ["To chain", chainLine({ chainId: d.toChainId, chain: d.toChain })],
      ["Amount", `${escapeMd(formatUnits(d.amount, d.fromDecimals ?? 18))} ${escapeMd(d.fromSymbol ?? "")}`.trim()],
      ["Best route", escapeMd(d.bestRoute ?? d.winner)],
      ["Est. received", `${escapeMd(formatUnits(d.amountOut, d.toDecimals ?? 18))} ${escapeMd(d.toSymbol ?? "")}`.trim()],
      ["Fee", usd(d.feeUsd)],
      ["Est. time", escapeMd(d.estimatedTime)],
      ["Revoke check", revokeUrl],
      ["All providers", escapeMd(d.providers?.join(", "))],
      ["Preparable", escapeMd(d.preparable)],
      confidenceRow(d),
    ],
    d,
  );
}

const RENDERERS = Object.freeze({
  token: renderTokenCard,
  launch: renderLaunchCard,
  hip3: renderHip3Card,
  hip4: renderHip4Card,
  polymarket: renderPolymarketCard,
  twap: renderTwapCard,
  bridge: renderBridgeCard,
});

/**
 * Dispatch by surface kind.
 * @param {"token"|"launch"|"hip3"|"hip4"|"polymarket"} kind
 */
export function renderCard(kind, data = {}) {
  const fn = RENDERERS[String(kind)];
  if (!fn) throw new Error(`unknown card kind: ${kind} (expected one of ${CARD_KINDS.join(", ")})`);
  return fn(data);
}

/**
 * Total soft-fail wrapper. An alert that cannot render is still an alert the
 * user needs to see, so a malformed payload degrades to a minimal card rather
 * than throwing and dropping the notification.
 */
export function safeRenderCard(kind, data = {}) {
  try {
    return renderCard(kind, data);
  } catch (error) {
    return [
      `*ORACLE CARD — DEGRADED*`,
      `Kind: ${escapeMd(kind)}`,
      `Chain: ${UNKNOWN}`,
      `Confidence: ${UNKNOWN}`,
      `Render error: ${escapeMd(error?.message)}`,
    ].join("\n");
  }
}
