import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (path) => readFileSync(resolve(ROOT, path), "utf8");

test("Strategy is registered as a real product tab", () => {
  const tabs = read("components/shell/tabs.product.ts");
  assert.match(tabs, /import\s+\{\s*StrategyPane\s*\}/);
  assert.match(tabs, /id:\s*["']strategy["']/);
  assert.match(tabs, /label:\s*["']Strategy["']/);
});

test("the app exposes every strategy workflow route through the shared package boundary", () => {
  const shared = read("app/api/oracle/strategy/_shared.ts");
  assert.match(shared, /@oracle-agent\/oracle\/strategy/);
  assert.doesNotMatch(shared, /hl-exec|key-vault|privateKey|mnemonic/);
  for (const route of ["draft", "validate", "backtest", "optimize", "evidence", "shadow", "prepare-live"]) {
    const path = resolve(ROOT, "app/api/oracle/strategy", route, "route.ts");
    assert.equal(existsSync(path), true, route);
    const source = readFileSync(path, "utf8");
    assert.match(source, /\.\.\/_shared/);
    assert.doesNotMatch(source, /hl-exec|key-vault|privateKey|mnemonic/);
  }
});

test("no public strategy route signs or broadcasts", () => {
  const pane = read("components/oracle/StrategyPane.tsx");
  assert.match(pane, /Oracle public never broadcasts/i);
  assert.match(pane, /PREPARE ONLY|prepare only/i);
  assert.doesNotMatch(pane, /\/api\/oracle\/strategy\/(?:execute|sign|submit|broadcast|arm)/);
});
