// Round-5 regressions (Opus 5 final audit — verdict was DO_NOT_SHIP).
//
// The CRITICAL here is the one that matters most in the whole suite: a server
// documented as read-only, reporting exec:false, was signing and submitting
// real orders. Each test is the reproduction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isExecutionProvider, EXECUTION_PROVIDERS } from "../src/data/desk-data.mjs";
import { createAutoSlippageGuard, assertAutoSlippageGuard } from "../src/auto-slippage.mjs";

process.env.ORACLE_ROUTE_ATTESTATION_SECRET ||= "oracle-unit-test-secret";

const VENUE = "0x2626664c2603336E57B271c5C0b26F421741e481";
const word = (v) => BigInt(v).toString(16).padStart(64, "0");

test("the execution provider is identifiable as such", () => {
  assert.equal(isExecutionProvider("hl-exec"), true);
  assert.equal(isExecutionProvider("hl-markets"), false);
  assert.equal(isExecutionProvider("jupiter"), false);
  assert.ok(EXECUTION_PROVIDERS.has("hl-exec"));
});

test("the read-only data server refuses execution providers by NAME, not by verb", () => {
  // op:"trade" matches none of sign/execute/broadcast/submit/place/send/write,
  // so the verb filter alone let the live signing lane through a server whose
  // /health advertises exec:false. The boundary must be the provider.
  const server = readFileSync(new URL("../bin/desk-server.mjs", import.meta.url), "utf8");
  assert.ok(
    server.includes("isExecutionProvider(provider)"),
    "desk-server must reject execution providers at the provider level"
  );
  const verbFilter = server.match(/\/sign\|[^/]*\/i\.test\(op\)/)?.[0] || "";
  assert.ok(/trade/.test(verbFilter), "the verb filter must also cover 'trade'");
});

test("a slippage guard cannot authorize a swap it was not issued for", () => {
  const g = createAutoSlippageGuard({
    chainId: 8453, venue: VENUE, quoteAmountOut: "1000",
    liquidityUsd: 5_000_000, volatilityBps: 10, nowMs: Date.now(), ttlMs: 15_000,
  });
  // exactInputSingle, 500 WETH in, amountOutMinimum = 0
  const evil =
    "0x414bf389" + word(0) + word(0) + word(3000) + word(0) + word(0) +
    word("500000000000000000000") + word(0) + word(0);
  assert.throws(
    () => assertAutoSlippageGuard(g, { chainId: 8453, venue: VENUE, tx: { chainId: 8453, to: VENUE, data: evil } }),
    /not bound to this call/
  );
});

test("a slippage guard still passes the call it WAS issued for", () => {
  const g = createAutoSlippageGuard({
    chainId: 8453, venue: VENUE, quoteAmountOut: "1000",
    liquidityUsd: 5_000_000, volatilityBps: 10, nowMs: Date.now(), ttlMs: 15_000,
  });
  const good =
    "0x414bf389" + word(0) + word(0) + word(3000) + word(0) + word(0) +
    word("1000") + word(g.minAmountOut) + word(0);
  assert.doesNotThrow(() =>
    assertAutoSlippageGuard(g, { chainId: 8453, venue: VENUE, tx: { chainId: 8453, to: VENUE, data: good } })
  );
});

test("the daily spend cap holds when its ledger cannot be written", async () => {
  // writeDaily() swallowed the error and readDaily() returned a zeroed window,
  // so an unwritable ledger reset the counter on every call and the daily
  // aggregate became unlimited. Observed: 0.5 ETH approved against a 0.15 cap.
  const dir = mkdtempSync(join(tmpdir(), "oracle-ro-ledger-"));
  chmodSync(dir, 0o500);
  const prev = { ...process.env };
  process.env.ORACLE_POLICY_STATE = join(dir, "daily.json");
  process.env.ORACLE_MAX_NATIVE_PER_TX_WEI = "50000000000000000";
  process.env.ORACLE_MAX_NATIVE_PER_DAY_WEI = "150000000000000000";

  // Fresh module instance so the in-process ledger starts empty.
  const { enforceTxPolicy } = await import(`../src/exec-policy.mjs?ro=${Date.now()}`);
  const { SWAP_VENUES } = await import("../src/venues.mjs");
  const to = SWAP_VENUES?.[8453]?.[0];

  let approved = 0n;
  for (let i = 0; i < 10; i++) {
    try {
      enforceTxPolicy({ chainId: 8453, to, value: "50000000000000000", data: "0x" }, "broadcast");
      approved += 50_000_000_000_000_000n;
    } catch {
      break;
    }
  }
  chmodSync(dir, 0o700);
  Object.assign(process.env, prev);

  assert.ok(
    approved <= 150_000_000_000_000_000n,
    `daily cap failed open: approved ${approved} wei against a 150000000000000000 cap`
  );
});
