// The app's swap prepare route must forward a taker and preserve the desk's
// reason. Both were real, shipped bugs:
//
//   1. The route never sent `taker`, so the desk could not build a transaction
//      FOR anyone and answered 400 on every request. The UI presented a working
//      prepare surface that could not return a quote under any input.
//   2. Any desk failure was flattened to "no executable quote", discarding the
//      only actionable part — e.g. "approve the spender first, then prepare
//      again", which tells the user exactly what to do next.

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

const route = readFileSync(new URL("../app/api/oracle/swap/prepare/route.ts", import.meta.url), "utf8");

test("a taker address is validated and forwarded to the desk", () => {
  assert.match(route, /function cleanAddress/);
  assert.match(route, /const taker = cleanAddress\(body\.taker\)/);
  // Must actually ride the upstream request body, not just be parsed.
  assert.match(route, /body: JSON\.stringify\(\{[\s\S]*?taker,[\s\S]*?\}\)/);
});

test("a missing taker is refused with a wallet-connect reason", () => {
  assert.match(route, /if \(!taker\)/);
  assert.match(route, /Connect a wallet/i);
});

test("the desk's own failure reason survives to the caller", () => {
  assert.match(route, /payload\.ok === false/);
  assert.match(route, /typeof payload\.reason === "string"/);
});

test("custody posture holds on every response path", () => {
  // Including failure paths: a route that cannot quote still must not imply
  // that anything server-side could sign.
  assert.match(route, /requiresWalletSignature: true/);
  assert.match(route, /backendSigner: false/);
  assert.equal(/backendSigner:\s*true/.test(route), false);
});

test("the desk URL stays loopback-only", () => {
  // An off-box desk would ship wallet address, chain, and size to a remote host
  // while the UI still claimed a local topology.
  assert.match(route, /host !== "127\.0\.0\.1" && host !== "localhost" && host !== "::1"/);
});

test("the human-readable buy amount survives to the UI", () => {
  // The desk emits BOTH raw base units and a formatted string. The route once
  // forwarded only the raw integer, so the pane rendered
  // "2,612,616,527,680,376 WETH" -- wei presented as whole tokens. Shape
  // matched, units did not.
  assert.match(route, /buyAmountFormatted: stringOrNull\(q\.buyAmountFormatted\)/);
});
