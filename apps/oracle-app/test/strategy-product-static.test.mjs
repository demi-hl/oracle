/**
 * Strategy Lab product surface static guards.
 *
 * Disjoint UI leaf only. Orchestrator owns shell wiring and API routes.
 * These assertions pin workflow honesty and same-origin strategy paths.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const PATHS = {
  pane: join(root, "components/oracle/StrategyPane.tsx"),
  graph: join(root, "components/oracle/strategy/StrategyGraph.tsx"),
  evidence: join(root, "components/oracle/strategy/EvidenceCard.tsx"),
  status: join(root, "components/oracle/strategy/StrategyStatus.tsx"),
};

function read(path) {
  assert.ok(existsSync(path), `missing required file: ${path}`);
  return readFileSync(path, "utf8");
}

const pane = read(PATHS.pane);
const graph = read(PATHS.graph);
const evidence = read(PATHS.evidence);
const status = read(PATHS.status);
const all = [pane, graph, evidence, status].join("\n");

const REQUIRED_API_PATHS = [
  "/api/oracle/strategy/draft",
  "/api/oracle/strategy/validate",
  "/api/oracle/strategy/backtest",
  "/api/oracle/strategy/optimize",
  "/api/oracle/strategy/shadow",
  "/api/oracle/strategy/prepare-live",
];

test("Strategy pane is a client component with Strategy Lab branding", () => {
  assert.match(pane, /["']use client["']/);
  assert.match(pane, /STRATEGY LAB/);
  assert.match(pane, /Turn an idea into a deterministic Hyperliquid strategy\./);
  assert.match(pane, /closed-bar rules/);
  assert.match(pane, /shadow validation/);
  assert.match(pane, /local handoff/);
});

test("all exact strategy API paths are present", () => {
  for (const path of REQUIRED_API_PATHS) {
    assert.match(pane, new RegExp(path.replace(/\//g, "\\/")), `missing ${path}`);
  }
});

test("fetch stays same-origin on strategy routes only", () => {
  const fetches = [...pane.matchAll(/fetch\s*\(\s*(["'`])([^"'`]+)\1/g)].map((m) => m[2]);
  assert.ok(fetches.length >= 1, "expected at least one fetch call");
  for (const target of fetches) {
    assert.match(
      target,
      /^\/api\/oracle\/strategy\//,
      `non-strategy or absolute fetch target: ${target}`,
    );
    assert.doesNotMatch(target, /^https?:\/\//);
  }
  assert.doesNotMatch(pane, /https?:\/\/(?!\/)/);
});

test("no execute/sign/submit/broadcast/arm endpoint or credential input", () => {
  assert.doesNotMatch(all, /\/api\/oracle\/strategy\/(execute|sign|submit|broadcast|arm)\b/);
  assert.doesNotMatch(all, /\b(privateKey|mnemonic|seedPhrase|secretKey|apiKey|api_key)\b/);
  assert.doesNotMatch(all, /type=["']password["']/);
  assert.doesNotMatch(all, /placeholder=["'][^"']*(wallet|key|mnemonic|signer|token)[^"']*["']/i);
  assert.doesNotMatch(all, /\b(eth_sendRawTransaction|signTransaction|sendTransaction|signTypedData)\b/);
  assert.doesNotMatch(all, /innerHTML|dangerouslySetInnerHTML|eval\s*\(|new\s+Function\s*\(/);
  assert.doesNotMatch(all, /<iframe\b/);
});

test("prepare-only and public-never-broadcast copy is present", () => {
  assert.match(pane, /PREPARE ONLY/);
  assert.match(status, /NOT ARMED/);
  assert.match(status, /Local signer required\. Oracle public never broadcasts\./);
  assert.match(all, /never broadcasts/i);
});

test("saved draft, shadowing, and live eligibility are separate states", () => {
  assert.match(pane, /oracle\.strategy\.draft\.v1/);
  assert.match(pane, /SAVED DRAFT/);
  assert.match(pane, /STOPPED/);
  assert.match(pane, /SHADOWING/);
  assert.match(pane, /ERROR/);
  assert.doesNotMatch(pane, /\bLIVE\b(?!\s+ELIGIBLE)/);
  assert.match(evidence, /LIVE ELIGIBLE/);
  assert.match(evidence, /PAPER ONLY/);
  assert.match(evidence, /FAIL/);
  assert.match(status, /DSL VALID|DSL INVALID/);
});

test("evidence card separates train and holdout and never fabricates zeros", () => {
  assert.match(evidence, /train/i);
  assert.match(evidence, /holdout/i);
  assert.match(evidence, /netPnlUsd/);
  assert.match(evidence, /maxDrawdownPct/);
  assert.match(evidence, /sharpe/);
  assert.match(evidence, /exposurePct/);
  assert.match(evidence, /tradeCount/);
  assert.match(evidence, /winRate/);
  assert.match(evidence, /profitFactor/);
  assert.match(evidence, /passRate|walkForward/);
  assert.match(evidence, /UNKNOWN/);
  assert.match(evidence, /does not arm or execute/i);
  assert.match(pane, /\.metrics/);
  assert.match(pane, /flag\.message|f\.message/);
  assert.doesNotMatch(evidence, /netPnl\s*\?\?\s*0|tradeCount\s*\?\?\s*0|winRate\s*\?\?\s*0/);
});

test("graph uses SVG with real geometry and no innerHTML or canvas placeholder", () => {
  assert.match(graph, /<svg\b/);
  assert.match(graph, /viewBox/);
  assert.match(graph, /\b(nodes|node)\b/);
  assert.match(graph, /entry|exit/i);
  assert.doesNotMatch(graph, /innerHTML|dangerouslySetInnerHTML/);
  assert.doesNotMatch(graph, /<canvas\b/);
  assert.match(graph, /<title\b|<desc\b|aria-label|role=["']img["']/);
});

test("workflow controls cover draft validate save evidence shadow and handoff", () => {
  assert.match(pane, /Draft with Oracle/);
  assert.match(pane, /Validate/);
  assert.match(pane, /Save draft|Save Draft/i);
  assert.match(pane, /Backtest/);
  assert.match(pane, /Optimize/);
  assert.match(pane, /Start shadow/i);
  assert.match(pane, /Stop shadow/i);
  assert.match(pane, /Prepare local handoff/i);
  assert.match(pane, /Long BTC when the 20 EMA crosses above the 50 EMA/);
  assert.match(pane, /action:\s*["']start["']/);
  assert.match(pane, /action:\s*["']stop["']/);
});

test("component sources avoid em dash and en dash", () => {
  for (const [name, src] of [
    ["StrategyPane", pane],
    ["StrategyGraph", graph],
    ["EvidenceCard", evidence],
    ["StrategyStatus", status],
  ]) {
    assert.doesNotMatch(src, /[—–]/, `${name} contains em or en dash`);
  }
});
