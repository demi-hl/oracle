import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (path) => readFileSync(resolve(ROOT, path), "utf8");

test("strategy is a public prepare-only package subpath", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.exports["./strategy"], "./src/strategy/index.mjs");
  assert.doesNotMatch(JSON.stringify(pkg.exports), /hl-exec|key-vault|private-key/i);
});

test("oracle CLI advertises the deterministic strategy workflow", () => {
  const kernel = read("src/cli/kernel.mjs");
  assert.match(kernel, /oracle strategy\s+validate\|backtest\|optimize\|evidence/);
  assert.match(kernel, /prepare-only/i);
  assert.doesNotMatch(kernel, /oracle strategy\s+(?:execute|sign|submit|broadcast|arm)/i);
  const command = read("src/cli/commands/strategy.mjs");
  assert.match(command, /name:\s*["']strategy["']/);
  assert.doesNotMatch(command, /hl-exec|key-vault|privateKey|mnemonic/);
});

test("strategy MCP tools expose compute, shadow and prepare without execution verbs", () => {
  const source = read("bin/oracle-data-mcp.mjs");
  for (const tool of [
    "strategy_validate",
    "strategy_backtest",
    "strategy_optimize",
    "strategy_evidence",
    "strategy_shadow_start",
    "strategy_shadow_list",
    "strategy_shadow_stop",
    "strategy_prepare_live",
  ]) {
    assert.match(source, new RegExp(`name:\\s*["']${tool}["']`), tool);
  }
  assert.doesNotMatch(source, /name:\s*["']strategy_(?:execute|sign|submit|broadcast|arm)/);
});

test("strategy desk routes are loopback compute and prepare surfaces", () => {
  const source = read("bin/desk-server.mjs");
  for (const route of ["validate", "backtest", "optimize", "evidence", "shadow", "prepare-live"]) {
    assert.match(source, new RegExp(`/strategy/${route}`), route);
  }
  assert.doesNotMatch(source, /\/strategy\/(?:execute|sign|submit|broadcast|arm)/);
});
