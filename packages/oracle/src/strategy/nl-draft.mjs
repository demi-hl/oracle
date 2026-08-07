// Conservative deterministic natural-language strategy draft parser.
// No LLM, network, clock, eval, Function, or arbitrary expression execution.

import { createHash } from "node:crypto";
import { normalizeStrategy, validateStrategy } from "./schema.mjs";

export class StrategyDraftError extends Error {
  constructor(message) {
    super(message);
    this.name = "StrategyDraftError";
  }
}

const INTERVALS = new Set([
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "8h",
  "12h",
  "1d",
]);

const KNOWN_COINS = new Set(["BTC", "ETH", "SOL", "HYPE"]);

const SECRET_RE =
  /\b(mnemonic|private\s*key|privkey|seed\s*phrase|seed\b|api[_-]?key|secret\s*key|wallet\s*key|passphrase)\b/i;

const GRAMMAR_SUMMARY =
  "Supported grammar: " +
  "(1) EMA cross: <long|short> <COIN> when EMA <n> crosses <above|below> EMA <m> [on <interval>] [, exit on reverse] [, risk knobs]; " +
  "(2) RSI: <long|short> <COIN> when RSI <n> <above|below> <threshold> [on <interval>] [, risk knobs]; " +
  "(3) funding: <long|short> <COIN> when funding rate <above|below> <decimal|percent%> [on <interval>] [, risk knobs]. " +
  "Risk knobs: stop loss %, take profit %, leverage, position size %, max notional USD. " +
  "Coins: BTC ETH SOL HYPE or uppercase token <=12 chars. Intervals: 1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d.";

const DEFAULT_RISK = Object.freeze({
  maxLeverage: 1,
  maxNotionalUsd: 100,
  positionSizePct: 5,
  stopLossPct: 2,
  takeProfitPct: 4,
  cooldownBars: 1,
  maxDailyLossPct: 3,
});

const MS_1H = 3_600_000;
const MS_30D = 30 * 86_400_000;
const DEFAULT_EXPIRES_IN = 86_400_000;

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function deepFreeze(value) {
  if (value == null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function normalizePrompt(prompt) {
  return String(prompt).trim().replace(/\s+/g, " ");
}

function parseSide(text) {
  const m = text.match(/\b(long|short)\b/i);
  if (!m) return null;
  return m[1].toLowerCase();
}

function parseCoin(text) {
  // known coins first
  for (const c of KNOWN_COINS) {
    const re = new RegExp(`\\b${c}\\b`, "i");
    if (re.test(text)) return c;
  }
  // explicit uppercase token 2-12 chars
  const m = text.match(/\b([A-Z][A-Z0-9]{1,11})\b/);
  if (m) return m[1];
  return null;
}

function parseInterval(text) {
  const m = text.match(/\bon\s+(1m|3m|5m|15m|30m|1h|2h|4h|8h|12h|1d)\b/i);
  if (!m) return "15m";
  const iv = m[1].toLowerCase();
  if (!INTERVALS.has(iv)) return null;
  return iv;
}

function parseRisk(text) {
  const risk = { ...DEFAULT_RISK };
  const stop = text.match(/stop\s*loss\s*(\d+(?:\.\d+)?)\s*%?/i);
  if (stop) risk.stopLossPct = Number(stop[1]);
  const tp = text.match(/take\s*profit\s*(\d+(?:\.\d+)?)\s*%?/i);
  if (tp) risk.takeProfitPct = Number(tp[1]);
  const lev = text.match(/leverage\s*(\d+(?:\.\d+)?)/i);
  if (lev) risk.maxLeverage = Number(lev[1]);
  const pos = text.match(/position\s*size\s*(\d+(?:\.\d+)?)\s*%?/i);
  if (pos) risk.positionSizePct = Number(pos[1]);
  const notion = text.match(/max\s*notional\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (notion) risk.maxNotionalUsd = Number(notion[1]);
  return risk;
}

function makeId(normalizedPrompt) {
  const hash = createHash("sha256").update(normalizedPrompt, "utf8").digest("hex").slice(0, 10);
  // slug from prompt words
  const slug = normalizedPrompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const base = slug.length ? slug : "draft";
  const id = `${base}-${hash}`.replace(/[^a-z0-9._-]/g, "").slice(0, 64);
  if (!/^[a-z0-9]/.test(id)) return `d${id}`.slice(0, 64);
  return id;
}

function parseEmaCross(text) {
  // EMA n crosses above/below EMA m
  const m = text.match(
    /\bema\s*(\d+)\s*cross(?:es)?\s*(above|below)\s*ema\s*(\d+)\b/i,
  );
  if (!m) return null;
  const fast = Number(m[1]);
  const direction = m[2].toLowerCase();
  const slow = Number(m[3]);
  if (!(fast > 0) || !(slow > 0) || fast === slow) return null;
  const reverse = /\b(exit\s+on\s+reverse|reverse\s+exit)\b/i.test(text);
  return { kind: "ema_cross", fast, slow, direction, reverse };
}

function parseRsi(text) {
  const m = text.match(/\brsi\s*(\d+)\s*(above|below)\s*(\d+(?:\.\d+)?)\b/i);
  if (!m) return null;
  return {
    kind: "rsi",
    period: Number(m[1]),
    op: m[2].toLowerCase(),
    threshold: Number(m[3]),
  };
}

function parseFunding(text) {
  const m = text.match(
    /\bfunding\s*rate\s*(above|below)\s*(-?\d+(?:\.\d+)?)(%?)\b/i,
  );
  if (!m) return null;
  let thr = Number(m[2]);
  if (m[3] === "%") thr = thr / 100;
  return {
    kind: "funding",
    op: m[1].toLowerCase(),
    threshold: thr,
  };
}

function buildEmaStrategy({ side, coin, interval, risk, expiresAt, id, name, spec }) {
  const fastPeriod = Math.min(spec.fast, spec.slow);
  const slowPeriod = Math.max(spec.fast, spec.slow);
  // If user said EMA 21 crosses above EMA 9, preserve left/right as written
  const leftPeriod = spec.fast;
  const rightPeriod = spec.slow;
  const nodes = [
    { id: "c", type: "input", field: "close" },
    {
      id: "emaLeft",
      type: "indicator",
      indicator: "ema",
      input: "c",
      period: leftPeriod,
    },
    {
      id: "emaRight",
      type: "indicator",
      indicator: "ema",
      input: "c",
      period: rightPeriod,
    },
    {
      id: "cross",
      type: "cross",
      direction: spec.direction,
      left: "emaLeft",
      right: "emaRight",
    },
  ];
  const rules = {
    entryLong: null,
    entryShort: null,
    exitLong: null,
    exitShort: null,
  };
  if (side === "long") {
    rules.entryLong = "cross";
  } else {
    rules.entryShort = "cross";
  }
  if (spec.reverse) {
    const revDir = spec.direction === "above" ? "below" : "above";
    nodes.push({
      id: "crossRev",
      type: "cross",
      direction: revDir,
      left: "emaLeft",
      right: "emaRight",
    });
    if (side === "long") rules.exitLong = "crossRev";
    else rules.exitShort = "crossRev";
  }
  // parameters empty - periods fixed from prompt
  void fastPeriod;
  void slowPeriod;
  return {
    version: 1,
    id,
    name,
    venue: "hyperliquid",
    market: { coin, interval },
    parameters: {},
    nodes,
    rules,
    risk: { ...risk, expiresAt },
  };
}

function buildRsiStrategy({ side, coin, interval, risk, expiresAt, id, name, spec }) {
  const nodes = [
    { id: "c", type: "input", field: "close" },
    {
      id: "rsi",
      type: "indicator",
      indicator: "rsi",
      input: "c",
      period: spec.period,
    },
    { id: "thr", type: "constant", value: spec.threshold },
    {
      id: "sig",
      type: "compare",
      op: spec.op === "above" ? "gt" : "lt",
      left: "rsi",
      right: "thr",
    },
  ];
  const rules = {
    entryLong: side === "long" ? "sig" : null,
    entryShort: side === "short" ? "sig" : null,
    exitLong: null,
    exitShort: null,
  };
  return {
    version: 1,
    id,
    name,
    venue: "hyperliquid",
    market: { coin, interval },
    parameters: {},
    nodes,
    rules,
    risk: { ...risk, expiresAt },
  };
}

function buildFundingStrategy({ side, coin, interval, risk, expiresAt, id, name, spec }) {
  const nodes = [
    { id: "fr", type: "input", field: "fundingRate" },
    { id: "thr", type: "constant", value: spec.threshold },
    {
      id: "sig",
      type: "compare",
      op: spec.op === "above" ? "gt" : "lt",
      left: "fr",
      right: "thr",
    },
  ];
  const rules = {
    entryLong: side === "long" ? "sig" : null,
    entryShort: side === "short" ? "sig" : null,
    exitLong: null,
    exitShort: null,
  };
  return {
    version: 1,
    id,
    name,
    venue: "hyperliquid",
    market: { coin, interval },
    parameters: {},
    nodes,
    rules,
    risk: { ...risk, expiresAt },
  };
}

/**
 * Deterministic conservative parser from a natural-language prompt to a strategy.
 * Fail closed on unsupported ambiguity. options.nowMs required.
 */
export function draftStrategyFromPrompt(prompt, options = {}) {
  if (typeof prompt !== "string") {
    throw new StrategyDraftError("prompt must be a string");
  }
  if (prompt.length > 1000) {
    throw new StrategyDraftError("prompt length must be <= 1000");
  }
  if (!isPlainObject(options)) {
    throw new StrategyDraftError("options must be a plain object");
  }
  if (!Number.isInteger(options.nowMs)) {
    throw new StrategyDraftError("options.nowMs is required integer epoch ms");
  }
  const nowMs = options.nowMs;

  let expiresInMs = DEFAULT_EXPIRES_IN;
  if ("expiresInMs" in options) {
    if (!Number.isInteger(options.expiresInMs)) {
      throw new StrategyDraftError("expiresInMs must be an integer");
    }
    expiresInMs = options.expiresInMs;
    if (expiresInMs < MS_1H || expiresInMs > MS_30D) {
      throw new StrategyDraftError("expiresInMs must be between 1h and 30d");
    }
  }

  if (SECRET_RE.test(prompt)) {
    throw new StrategyDraftError(
      `prompt appears to contain secrets and is rejected. ${GRAMMAR_SUMMARY}`,
    );
  }

  const normalized = normalizePrompt(prompt);
  if (!normalized) {
    throw new StrategyDraftError(`empty prompt. ${GRAMMAR_SUMMARY}`);
  }

  const side = parseSide(normalized);
  const coin = parseCoin(normalized);
  const interval = parseInterval(normalized);
  if (!side || !coin || !interval) {
    throw new StrategyDraftError(
      `could not parse side/coin/interval. ${GRAMMAR_SUMMARY}`,
    );
  }

  const risk = parseRisk(normalized);
  // validate risk ranges lightly before schema
  if (!(risk.maxLeverage > 0) || risk.maxLeverage > 50) {
    throw new StrategyDraftError("leverage out of range");
  }
  if (!(risk.positionSizePct > 0) || risk.positionSizePct > 100) {
    throw new StrategyDraftError("position size out of range");
  }

  const expiresAt = nowMs + expiresInMs;
  const id = makeId(normalized);
  const name = `Draft ${coin} ${side}`.slice(0, 100);

  const ema = parseEmaCross(normalized);
  const rsi = parseRsi(normalized);
  const funding = parseFunding(normalized);

  const matched = [ema, rsi, funding].filter(Boolean);
  if (matched.length !== 1) {
    throw new StrategyDraftError(
      `unsupported or ambiguous prompt. ${GRAMMAR_SUMMARY}`,
    );
  }

  let draft;
  const spec = matched[0];
  const ctx = { side, coin, interval, risk, expiresAt, id, name, spec };
  if (spec.kind === "ema_cross") draft = buildEmaStrategy(ctx);
  else if (spec.kind === "rsi") draft = buildRsiStrategy(ctx);
  else draft = buildFundingStrategy(ctx);

  const result = validateStrategy(draft, { nowMs });
  if (!result.ok) {
    throw new StrategyDraftError(
      `draft failed validation: ${result.errors.map((e) => e.message).join("; ")}`,
    );
  }

  // Return normalized frozen strategy
  return deepFreeze(normalizeStrategy(draft, { nowMs }));
}
