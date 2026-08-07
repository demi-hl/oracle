import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

const pane = readFileSync(new URL("../components/oracle/FarmingMethodsPane.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/oracle/farming/route.ts", import.meta.url), "utf8");

test("Farming Methods exposes both delta-neutral and airdrop farming calculators", () => {
  assert.match(pane, /delta-neutral farming recipes/);
  assert.match(pane, /airdrop farming calculator/);
  assert.match(pane, /AIRDROP_STRATEGIES/);
  assert.match(pane, /breakevenProbability/);
  assert.match(pane, /sybilHaircut/);
  assert.match(pane, /lockupDiscount/);
});

test("airdrop farming surface stays prepare-only and anti-sybil", () => {
  assert.match(pane, /must follow official campaign rules/);
  assert.match(pane, /never bypass sybil, identity, or anti-bot policies/);
  assert.match(pane, /wallet-signed swaps, bridges, mints, or deposits only/);
  assert.match(pane, /Farming methods are not autonomous trading/);
});

test("live farming route remains read-only discovery with no signer imports", () => {
  // Scoring and the posture string now live in the shared
  // @oracle-agent/oracle/farming module so the CLI and this route cannot drift.
  // Follow the logic there rather than asserting against a route file that is
  // now a thin delegate -- otherwise this guard passes on an empty wrapper.
  assert.match(route, /@oracle-agent\/oracle\/farming/);
  assert.doesNotMatch(route, /executePrepared|signTransaction|privateKey|WIF/);

  const shared = readFileSync(
    new URL("../../../packages/oracle/src/data/providers/farming.mjs", import.meta.url),
    "utf8",
  );
  assert.match(shared, /read-only discovery and prepare-plan design; no signing or broadcast/);
  assert.doesNotMatch(shared, /executePrepared|signTransaction|privateKey|WIF/);
});
