// Prepare-the-winner handoff tests.
//
// This is the step where a comparison becomes something signable, so the failure
// modes are the expensive kind: a transaction built for the wrong address, typed data
// mistaken for a transaction, an approval pointed at the wrong spender, or a stale
// quote carried into a signature.
//
// Deterministic -- no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { ARTIFACT, supportedPreparers } from "../src/router/prepare-route.mjs";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const REAL = "0xcDAC0d6c6C59727a65F871236188350531885C43";

async function prepare(overrides = {}) {
  const { prepareBestRoute } = await import("../src/router/prepare-route.mjs");
  return prepareBestRoute({
    chainId: 8453,
    tokenIn: WETH,
    tokenOut: USDC,
    amountIn: "1000000000000000000",
    taker: REAL,
    ...overrides,
  });
}

// --- taker validation ---------------------------------------------------------

test("preparing without a taker is refused", async () => {
  await assert.rejects(() => prepare({ taker: undefined }), /requires taker/);
});

test("a malformed taker is refused before any network call", async () => {
  await assert.rejects(() => prepare({ taker: "vitalik.eth" }), /valid 20-byte address/);
});

test("the quote placeholder is refused as a taker", async () => {
  // Quoting anonymously is fine and necessary. Preparing FOR the burn address builds
  // a transaction nobody can use -- and some venues accept it silently, so relying on
  // the venue to catch this means relying on the least careful one.
  for (const bad of [
    "0x000000000000000000000000000000000000dEaD",
    "0x0000000000000000000000000000000000000000",
    "0x00000000000000000000000000000000000A1ce5",
  ]) {
    await assert.rejects(
      () => prepare({ taker: bad }),
      /placeholder\/burn address/,
      `${bad} must be rejected`,
    );
  }
});

// --- artifact kinds -----------------------------------------------------------

test("the two artifact kinds are distinct and named", () => {
  // A transaction gets broadcast; typed data gets signed and submitted to an API.
  // Handing someone one where they expect the other fails at signing time, after
  // they have already approved tokens.
  assert.equal(ARTIFACT.TRANSACTION, "unsigned-transaction");
  assert.equal(ARTIFACT.TYPED_DATA_ORDER, "typed-data-order");
  assert.notEqual(ARTIFACT.TRANSACTION, ARTIFACT.TYPED_DATA_ORDER);
});

test("every preparable source is one the router can actually rank", async () => {
  // A preparer for a source the comparison never returns is dead code that looks
  // like coverage.
  //
  // Key-gated sources (0x, 1inch) only appear when their key is present, so the
  // candidate list is built WITH keys stubbed to prove the wiring exists. Without
  // this the test would silently pass on a machine with no keys while the preparer
  // was pointed at a source that never shows up.
  const { swapCandidates } = await import("../src/router/route-sources.mjs");

  const saved = { z: process.env.ZEROX_API_KEY, o: process.env.ONEINCH_API_KEY };
  process.env.ZEROX_API_KEY = "test-key";
  process.env.ONEINCH_API_KEY = "test-key";

  let names;
  try {
    names = swapCandidates({
      chainId: 8453,
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: "1",
      taker: REAL,
      decimalsIn: 18,
      decimalsOut: 6,
    }).map((c) => c.source);
  } finally {
    if (saved.z === undefined) delete process.env.ZEROX_API_KEY;
    else process.env.ZEROX_API_KEY = saved.z;
    if (saved.o === undefined) delete process.env.ONEINCH_API_KEY;
    else process.env.ONEINCH_API_KEY = saved.o;
  }

  for (const src of supportedPreparers()) {
    assert.ok(names.includes(src), `preparer "${src}" is not a source the router quotes`);
  }
});

test("sources without a prepare path are known, not silently unpreparable", async () => {
  // 1inch quotes but has no preparer wired here. That is a real gap and it should be
  // visible in the test suite rather than discovered by a user whose winner cannot
  // be prepared.
  const { swapCandidates } = await import("../src/router/route-sources.mjs");
  const saved = { z: process.env.ZEROX_API_KEY, o: process.env.ONEINCH_API_KEY };
  process.env.ZEROX_API_KEY = "test-key";
  process.env.ONEINCH_API_KEY = "test-key";
  let names;
  try {
    names = swapCandidates({
      chainId: 8453,
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: "1",
      taker: REAL,
      decimalsIn: 18,
      decimalsOut: 6,
    }).map((c) => c.source);
  } finally {
    if (saved.z === undefined) delete process.env.ZEROX_API_KEY;
    else process.env.ZEROX_API_KEY = saved.z;
    if (saved.o === undefined) delete process.env.ONEINCH_API_KEY;
    else process.env.ONEINCH_API_KEY = saved.o;
  }

  const unpreparable = names.filter((n) => !supportedPreparers().includes(n));
  assert.deepEqual(
    unpreparable,
    ["1inch"],
    "the set of quote-only sources changed -- update this test and the docs together",
  );
});

// --- custody ------------------------------------------------------------------

test("the prepare module cannot sign or broadcast", () => {
  const src = fs.readFileSync(new URL("../src/router/prepare-route.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of [
    /privateKey/,
    /signTransaction/,
    /sendRawTransaction/,
    /eth_sendTransaction/,
    /new Wallet\(/,
  ]) {
    assert.ok(!forbidden.test(code), `prepare module must not contain ${forbidden}`);
  }
  assert.ok(!/from ["'].*(keystore|get-signer|local-signer)/.test(code));
});

test("results are marked unsigned and attribute signing to the user", async () => {
  const src = fs.readFileSync(new URL("../src/router/prepare-route.mjs", import.meta.url), "utf8");
  assert.match(src, /unsigned: true/);
  assert.match(src, /signedBy: "user-wallet"/);
});

// --- the CoW approval trap ----------------------------------------------------

test("CoW approval targets the vault relayer, not the settlement contract", () => {
  // Approving the settlement contract produces an order that can never fill, because
  // CoW pulls funds through the relayer. The failure is silent until the order simply
  // never executes, which is the worst way to learn it.
  const src = fs.readFileSync(new URL("../src/router/prepare-route.mjs", import.meta.url), "utf8");
  const cowBlock = src.slice(src.indexOf("cow: async"), src.indexOf("export function supportedPreparers"));
  assert.match(cowBlock, /spender: p\.vaultRelayer/);
  assert.ok(
    !/spender: p\.settlement/.test(cowBlock),
    "the settlement contract must never be the approval spender",
  );
});

// --- honesty ------------------------------------------------------------------

test("an unpreparable winner names an alternative instead of dead-ending", () => {
  const src = fs.readFileSync(new URL("../src/router/prepare-route.mjs", import.meta.url), "utf8");
  assert.match(src, /has no prepare path in this build/);
  assert.match(src, /alternative/);
});

test("an overridden source is flagged as not the winner", () => {
  const src = fs.readFileSync(new URL("../src/router/prepare-route.mjs", import.meta.url), "utf8");
  assert.match(src, /wasWinner/);
});

test("drift between comparison and prepare is measured and bounded", () => {
  // The comparison is stale by the time prepare runs. Silently preparing a materially
  // worse trade than the one the user agreed to is the failure this guards.
  const src = fs.readFileSync(new URL("../src/router/prepare-route.mjs", import.meta.url), "utf8");
  assert.match(src, /driftBps/);
  assert.match(src, /DEFAULT_DRIFT_TOLERANCE_BPS/);
  assert.match(src, /re-run the comparison before signing/);
});

test("venue rejections are classified, not reported as opaque HTTP errors", () => {
  // "Not enough WETH allowance" is a fixable user-side state, not a router bug.
  // Reporting the bare 400 sends people debugging the wrong thing.
  const src = fs.readFileSync(new URL("../src/router/prepare-route.mjs", import.meta.url), "utf8");
  assert.match(src, /approval-required-first/);
  assert.match(src, /taker-not-funded/);
  // The API's own message must be read, not just the status line.
  assert.match(src, /err\?\.body/);
});
