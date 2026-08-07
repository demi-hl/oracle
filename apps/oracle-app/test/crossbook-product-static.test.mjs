/**
 * Crossbook product surface static guards.
 *
 * Separate product inside Oracle. CLI + app + package must stay prepare-only
 * and share one module — no second ranking implementation in the app.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const pane = readFileSync(join(root, "components/oracle/CrossbookPane.tsx"), "utf8");
const venuesRoute = readFileSync(join(root, "app/api/oracle/equities/venues/route.ts"), "utf8");
const quoteRoute = readFileSync(join(root, "app/api/oracle/equities/quote/route.ts"), "utf8");
const prepareRoute = readFileSync(join(root, "app/api/oracle/equities/prepare/route.ts"), "utf8");
const tabs = readFileSync(join(root, "components/shell/tabs.product.ts"), "utf8");

test("Crossbook is registered as its own product tab", () => {
  assert.match(tabs, /id:\s*"equities"/);
  assert.match(tabs, /CrossbookPane/);
  assert.match(tabs, /label: "Crossbook"/);
  assert.match(tabs, /PRODUCT_PRIMARY_TAB_IDS[\s\S]*"equities"/);
});

test("Crossbook pane brands as a separate product and stays prepare-only", () => {
  assert.match(pane, /Crossbook is a separate Oracle product/);
  assert.match(pane, /oracle equities/);
  assert.match(pane, /never signs/i);
  assert.match(pane, /never broadcasts/i);
  assert.doesNotMatch(pane, /privateKey|signTransaction|broadcastTransaction|WIF/);
});

test("Crossbook API routes delegate to the shared package module", () => {
  for (const src of [venuesRoute, quoteRoute, prepareRoute]) {
    assert.match(src, /@oracle-agent\/oracle\/equities/);
    assert.doesNotMatch(src, /executePrepared|signTransaction|privateKey|WIF/);
  }
  assert.match(prepareRoute, /requiresWalletSignature:\s*true/);
  assert.match(prepareRoute, /backendSigner:\s*false/);
  assert.match(prepareRoute, /Never signs/);
});

test("prepare refuses placeholder recipients in the route", () => {
  assert.match(prepareRoute, /0x\[a-fA-F0-9\]\{40\}/);
  assert.match(prepareRoute, /real 0x EVM address/);
});
