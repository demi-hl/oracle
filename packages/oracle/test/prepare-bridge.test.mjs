// Bridge prepare tests.
//
// Bridging has failure modes swapping does not, and they are the unrecoverable kind:
// funds leave the origin chain before anything is confirmed on the destination. So
// the properties under test are about not misleading the signer -- the transaction
// count, the origin chain, the destination chain, and the fact that success on one
// side is not arrival on the other.
//
// Deterministic -- no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { supportedBridgePreparers } from "../src/router/prepare-bridge.mjs";

const NATIVE = "0x0000000000000000000000000000000000000000";
const REAL = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const SRC = fs.readFileSync(new URL("../src/router/prepare-bridge.mjs", import.meta.url), "utf8");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

async function prepare(overrides = {}) {
  const { prepareBestBridgeRoute } = await import("../src/router/prepare-bridge.mjs");
  return prepareBestBridgeRoute({
    fromChainId: 42161,
    toChainId: 8453,
    tokenIn: NATIVE,
    tokenOut: NATIVE,
    amountIn: "100000000000000000",
    taker: REAL,
    ...overrides,
  });
}

// --- taker validation ---------------------------------------------------------

test("bridging without a taker is refused", async () => {
  await assert.rejects(() => prepare({ taker: undefined }), /requires taker/);
});

test("a malformed taker is refused before any network call", async () => {
  await assert.rejects(() => prepare({ taker: "not-an-address" }), /valid 20-byte address/);
});

test("placeholder takers are refused, and the message says why it is worse here", async () => {
  // Bridging to a burn address is worse than swapping to one: the funds land on
  // another chain, and there is no revert to save you.
  await assert.rejects(
    () => prepare({ taker: "0x000000000000000000000000000000000000dEaD" }),
    /placeholder\/burn address.*cannot undo/s,
  );
});

// --- the multi-transaction trap ------------------------------------------------

test("transactions are always a LIST, even for single-tx routes", () => {
  // Relay can return an approval plus a deposit. A caller handed a bare `transaction`
  // for one source and a list for another will sign the first item and believe they
  // are done -- leaving funds approved but not bridged.
  assert.match(CODE, /transactions: p\.transaction \? \[p\.transaction\] : \[\]/);
  assert.match(CODE, /transactionCount: txs\.length/);
});

test("multi-transaction routes warn that order matters", () => {
  assert.match(CODE, /signed IN ORDER/);
  assert.match(CODE, /leaves funds approved but not bridged/);
});

test("a route returning no transactions fails instead of returning an empty artifact", () => {
  assert.match(CODE, /returned no executable transaction for this route/);
});

// --- chain correctness --------------------------------------------------------

test("every prepared transaction must be on the ORIGIN chain", () => {
  // A wallet prompted on the wrong network makes the user approve something they
  // cannot reason about.
  assert.match(CODE, /Number\(t\.chainId\) !== Number\(fromChainId\)/);
  assert.match(CODE, /chain-mismatch/);
});

test("both origin and destination chain are reported", () => {
  // The transaction executes on one chain and credits another. Showing only the
  // signing chain hides half the trust decision.
  assert.match(CODE, /fromChainId: Number\(fromChainId\)/);
  assert.match(CODE, /toChainId: Number\(toChainId\)/);
});

// --- non-atomicity ------------------------------------------------------------

test("the artifact states that bridging is not atomic", () => {
  // The most common bridging panic: origin tx confirmed, destination empty. Saying
  // this up front is the difference between waiting and double-sending.
  assert.match(CODE, /NOT atomic/);
  assert.match(CODE, /do not re-send if it is pending/);
});

test("duration is surfaced, not folded into the ranking score", () => {
  assert.match(CODE, /durationSeconds/);
  // The comparison ranks on value; time is reported separately for the caller to weigh.
  assert.ok(
    !/netOut.*durationSeconds|durationSeconds.*\* *[0-9]/.test(CODE),
    "duration must not be arithmetically mixed into the score",
  );
});

// --- custody ------------------------------------------------------------------

test("the bridge prepare module cannot sign or broadcast", () => {
  for (const forbidden of [
    /privateKey/,
    /signTransaction/,
    /sendRawTransaction/,
    /eth_sendTransaction/,
    /new Wallet\(/,
  ]) {
    assert.ok(!forbidden.test(CODE), `must not contain ${forbidden}`);
  }
  assert.ok(!/from ["'].*(keystore|get-signer|local-signer)/.test(CODE));
  assert.match(CODE, /unsigned: true/);
  assert.match(CODE, /signedBy: "user-wallet"/);
});

// --- honesty ------------------------------------------------------------------

test("an unpreparable winner returns a machine-readable alternative", async () => {
  // Across wins on gross often but has no prepare path. The fallback must be readable
  // without regexing the prose, since an agent consumes this.
  assert.match(CODE, /failureKind: "no-prepare-path"/);
  assert.match(CODE, /\.\.\.\(alt \? \{ alternative: alt\.source \} : \{\}\)/);
});

test("preparable bridge sources are all sources the comparison ranks", async () => {
  const { bridgeCandidates } = await import("../src/router/route-sources.mjs");
  const names = bridgeCandidates({
    fromChainId: 42161,
    toChainId: 8453,
    tokenIn: NATIVE,
    tokenOut: NATIVE,
    amountIn: "1",
    taker: REAL,
  }).map((c) => c.source);

  for (const src of supportedBridgePreparers()) {
    assert.ok(names.includes(src), `bridge preparer "${src}" is not a source we quote`);
  }
});

test("quote-only bridge sources are pinned so a silent gap fails CI", async () => {
  // Across quotes but cannot prepare. That is a real gap; it belongs in the test
  // suite rather than being discovered by a user whose winner is unusable.
  const { bridgeCandidates } = await import("../src/router/route-sources.mjs");
  const names = bridgeCandidates({
    fromChainId: 42161,
    toChainId: 8453,
    tokenIn: NATIVE,
    tokenOut: NATIVE,
    amountIn: "1",
    taker: REAL,
  }).map((c) => c.source);

  const unpreparable = names.filter((n) => !supportedBridgePreparers().includes(n));
  assert.deepEqual(
    unpreparable,
    ["across"],
    "the set of quote-only bridge sources changed -- update this test and the docs together",
  );
});

test("drift against the comparison is measured and bounded", () => {
  assert.match(CODE, /driftBps/);
  assert.match(CODE, /DEFAULT_DRIFT_TOLERANCE_BPS/);
  assert.match(CODE, /Re-compare/);
});

test("venue rejections are classified, reading the API body not just the status", () => {
  assert.match(CODE, /approval-required-first/);
  assert.match(CODE, /taker-not-funded/);
  assert.match(CODE, /err\?\.body/);
});
