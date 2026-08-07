import { test } from "node:test";
import assert from "node:assert/strict";

import { registerBuiltinScanners } from "../src/scanner/chains.config.mjs";
import { getScanner } from "../src/scanner/contract.mjs";

// Scanners are registered explicitly, exactly as bin/oracle-scan.mjs does it.
registerBuiltinScanners();

// A sell simulation round-trips a token against the chain's base asset. When the
// token under test IS that base asset, the probe used to quote WETH -> WETH,
// find no pool, and return FAIL -- reporting "you cannot exit" on the single
// most liquid asset on the chain. FAIL there reads as "honeypot", which is the
// most damaging thing this scanner can say incorrectly.

const BASE = 8453;
const WETH_BASE = "0x4200000000000000000000000000000000000006";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

test("sell simulation never reports FAIL for the chain's own base asset", async () => {
  const scanner = getScanner(BASE);
  const r = await scanner.sellSimulation({
    token: WETH_BASE,
    amountIn: (10n ** 18n).toString(),
  });

  assert.notEqual(r.verdict, "FAIL", "base asset must not be reported unsellable");
  assert.equal(r.verdict, "UNKNOWN");
  assert.match(r.reason, /base asset/i);
  // UNKNOWN must not masquerade as a measurement.
  assert.notEqual(r.evidence, "LIVE");
});

test("sell simulation still measures a real non-base token", async () => {
  // The guard must not swallow genuine round trips.
  const scanner = getScanner(BASE);
  // 1 WETH worth of buy-side, not 10^18 units of a 6-decimal token.
  const r = await scanner.sellSimulation({
    token: USDC_BASE,
    amountIn: (10n ** 18n).toString(),
  });

  assert.ok(["PASS", "FAIL", "UNKNOWN"].includes(r.verdict));
  assert.equal(/base asset/i.test(String(r.reason ?? "")), false, "guard must not swallow real tokens");
  if (r.verdict === "PASS") {
    assert.equal(r.evidence, "LIVE");
    assert.ok(r.retentionBps > 9_000, "a liquid stable should retain most value round-trip");
  }
});
