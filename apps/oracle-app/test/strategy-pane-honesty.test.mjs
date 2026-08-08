/**
 * Strategy pane honesty guards.
 *
 * Draft failure must not invent a strategy. localStorage holds DSL only.
 * Evidence eligibility, shadow, and execution stay independent labels.
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

test("prompt does not invent a strategy locally when draft API fails", () => {
  assert.match(pane, /\/api\/oracle\/strategy\/draft/);
  // Failure path must surface unavailable/error; must not assign a canned DSL body.
  assert.match(pane, /unavailable|draft failed|Draft unavailable|error/i);
  assert.doesNotMatch(
    pane,
    /setDsl\([`'"]\s*\{[\s\S]{0,200}ema[\s\S]{0,200}\}/i,
    "draft failure path appears to invent a local EMA strategy body",
  );
  assert.doesNotMatch(
    pane,
    /catch\s*\([^)]*\)\s*\{[\s\S]{0,400}set(Strategy|Dsl)\([^)]*\{/,
    "catch block fabricates a strategy object",
  );
  // No offline NL compiler stub that synthesizes nodes from the prompt text.
  assert.doesNotMatch(pane, /fake\s*AI|mockDraft|inventStrateg|localDraft|compilePromptLocally/i);
});

test("localStorage stores DSL only under the versioned draft key", () => {
  assert.match(pane, /oracle\.strategy\.draft\.v1/);
  assert.match(pane, /localStorage\.setItem\(\s*["']oracle\.strategy\.draft\.v1["']/);
  // setItem should write the DSL string (or JSON of strategy only), not evidence/shadow blobs.
  const setItemBlocks = [...pane.matchAll(/localStorage\.setItem\(\s*["']oracle\.strategy\.draft\.v1["']\s*,\s*([^)]+)\)/g)];
  assert.ok(setItemBlocks.length >= 1, "expected setItem for draft key");
  for (const m of setItemBlocks) {
    const arg = m[1];
    assert.doesNotMatch(arg, /evidence|shadow|prepare|pass_live|SHADOWING/i);
  }
  assert.match(pane, /SAVED DRAFT/);
  assert.doesNotMatch(pane, /SAVED DRAFT[\s\S]{0,80}\bACTIVE\b/);
});

test("evidence LIVE ELIGIBLE never means armed execution", () => {
  assert.match(evidence, /LIVE ELIGIBLE/);
  assert.match(evidence, /does not arm or execute/i);
  assert.match(status, /NOT ARMED/);
  assert.match(status, /Oracle public never broadcasts/);
  assert.doesNotMatch(all, /execution active|live execution|armed live|now live/i);
  assert.doesNotMatch(status, /\bLIVE\b(?!\s+ELIGIBLE)/);
});

test("shadow labels stay STOPPED SHADOWING ERROR and never LIVE", () => {
  assert.match(pane, /STOPPED/);
  assert.match(pane, /SHADOWING/);
  assert.match(pane, /ERROR/);
  // Shadow status assignment must not use LIVE as a label.
  assert.doesNotMatch(pane, /shadow[A-Za-z]*\s*=\s*["']LIVE["']/i);
  assert.doesNotMatch(pane, /label:\s*["']LIVE["']/);
});

test("prepare local handoff is gated on bound live-eligible evidence and active matching shadow", () => {
  assert.match(pane, /prepare-live/);
  assert.match(pane, /pass_live_eligible/);
  assert.match(pane, /evidenceArtifact\s*!=\s*null/);
  assert.match(pane, /evidence:\s*evidenceArtifact/);
  assert.match(pane, /setEvidenceArtifact\(null\)/);
  assert.match(pane, /Prepare local handoff/i);
  assert.match(pane, /PREPARE ONLY/);
  assert.match(pane, /shadowMatchesEvidence\(shadowRunner,\s*evidenceArtifact\)/);
  assert.match(pane, /runner\.evidenceId\s*===\s*evidence\.id/);
  assert.match(pane, /runner\.strategyHash\s*===\s*evidence\.strategyHash/);
  assert.match(pane, /runner\.compilerHash\s*===\s*evidence\.compilerHash/);
  assert.match(pane, /shadowId/);
});

test("DSL is valid only after explicit deterministic validation success", () => {
  assert.match(pane, /if\s*\(\s*!ok\s*\)\s*\{[\s\S]{0,240}setDslState\(["']invalid["']\)/);
  assert.doesNotMatch(pane, /setDslState\(\s*ok\s*\|\|\s*res\.ok/);
});

test("StrategyStatus tracks four independent states", () => {
  assert.match(status, /DSL VALID|INVALID/);
  assert.match(status, /Evidence|evidence/);
  assert.match(status, /Shadow|shadow/);
  assert.match(status, /Execution|NOT ARMED/);
  assert.match(status, /Local signer required\. Oracle public never broadcasts\./);
});

test("StrategyGraph empty or invalid state is explicit", () => {
  assert.match(graph, /empty|invalid|no nodes|unable to parse|parse/i);
  assert.doesNotMatch(graph, /placeholder graph|sample nodes|demo strategy/i);
});

test("TypeScript components use unknown guards without any", () => {
  for (const [name, src] of [
    ["StrategyPane", pane],
    ["StrategyGraph", graph],
    ["EvidenceCard", evidence],
    ["StrategyStatus", status],
  ]) {
    assert.doesNotMatch(src, /:\s*any\b|as\s+any\b/, `${name} uses any`);
  }
});

test("no wallet key mnemonic token signer or broadcast input controls", () => {
  assert.doesNotMatch(pane, /name=["'](privateKey|mnemonic|seed|secret|apiKey|token|signer)["']/i);
  assert.doesNotMatch(pane, /label[^>]*>\s*(Private key|Mnemonic|Seed phrase|API token|Signer key)/i);
  assert.doesNotMatch(all, /\bbroadcast\b(?!\.)/i);
  // "broadcasts" in the never-broadcasts disclaimer is allowed; bare broadcast verb as action is not.
  assert.doesNotMatch(pane, />\s*Broadcast\s*</);
  assert.doesNotMatch(pane, />\s*Execute\s*</);
  assert.doesNotMatch(pane, />\s*Arm\s*</);
  assert.doesNotMatch(pane, />\s*Sign\s*</);
  assert.doesNotMatch(pane, />\s*Submit\s*</);
});

test("component copy contains no em dash or en dash", () => {
  for (const [name, src] of Object.entries({
    StrategyPane: pane,
    StrategyGraph: graph,
    EvidenceCard: evidence,
    StrategyStatus: status,
  })) {
    assert.doesNotMatch(src, /[—–]/, `${name} contains em or en dash`);
  }
});
