// Uniswap V3 venue adapter tests.
//
// The V3 adapter exists because V2 assumptions silently produce wrong transactions
// on V3 pools. So the properties under test are: the right adapter gets selected,
// fee-tier discovery is real rather than a hardcoded default, custody is preserved,
// and a chain without BOTH a quoter and a router stays fail-closed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  FEE_TIERS,
  applySlippage,
  v3VenueCapabilities,
} from "../src/scanner/v3-venue.mjs";
import { createScanner, EVIDENCE, RISK, __clearScanners } from "../src/scanner/contract.mjs";
import { defineEvmScanner } from "../src/scanner/evm-scanner.mjs";
import { CHAIN_CONFIGS } from "../src/scanner/chains.config.mjs";

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DEAD = "0x000000000000000000000000000000000000dEaD";

const v3Chains = () => CHAIN_CONFIGS.filter((c) => c.venueKind === "uniswap-v3");

// --- adapter selection --------------------------------------------------------

test("V3 chains select the V3 adapter and gain all 10 capabilities", () => {
  __clearScanners();
  const chains = v3Chains();
  assert.ok(chains.length >= 7, `expected 7+ V3 chains, got ${chains.length}`);

  for (const cfg of chains) {
    const s = createScanner(defineEvmScanner(cfg));
    for (const cap of ["quote", "sellSimulation", "prepareUnsignedTx"]) {
      assert.equal(s.supports(cap), true, `${cfg.key} should support ${cap}`);
    }
    assert.equal(s.capabilities().supported.length, 10, `${cfg.key} should have 10 caps`);
  }
  __clearScanners();
});

test("a V3 chain missing its quoter stays fail-closed", () => {
  // Both halves are required. A router without a quoter could still encode a swap,
  // but it would have no priced expectation to guard against -- exactly the state
  // that produces an unbounded fill.
  const cfg = { ...v3Chains()[0] };
  cfg.venues = cfg.venues.filter((v) => v.kind !== "quoter");
  const s = createScanner(defineEvmScanner(cfg));
  assert.equal(s.supports("quote"), false);
  assert.equal(s.supports("prepareUnsignedTx"), false);
});

test("chains with no venue at all remain at 7 capabilities", () => {
  for (const cfg of CHAIN_CONFIGS.filter((c) => !c.venueKind)) {
    const s = createScanner(defineEvmScanner(cfg));
    assert.equal(s.capabilities().supported.length, 7, `${cfg.key} should stay fail-closed`);
  }
});

// --- provenance ---------------------------------------------------------------

test("every shipped venue records per-chain provenance", () => {
  for (const cfg of CHAIN_CONFIGS) {
    for (const v of cfg.venues || []) {
      assert.ok(v.verified, `${cfg.key} venue ${v.address} lacks verification`);
      assert.ok(
        v.verified.method && v.verified.method.length > 30,
        `${cfg.key} venue ${v.address} needs a substantive method`,
      );
      assert.equal(
        v.verified.chainId,
        cfg.chainId,
        `${cfg.key} venue verification must be bound to THIS chain -- an address ` +
          "verified elsewhere is not verified here",
      );
    }
  }
});

test("venue verification is functional, not codesize-only", () => {
  // The Base quoter is the case that proves why: the canonical mainnet address also
  // has bytecode on Base but does not price the pair. If provenance ever regresses to
  // "it has code", that false positive comes back.
  const base = CHAIN_CONFIGS.find((c) => c.chainId === 8453);
  const quoter = base.venues.find((v) => v.kind === "quoter");
  assert.match(quoter.verified.method, /functional probe|quoteExactInputSingle/i);
  assert.ok(
    /scripts\/verify-v3-venues\.mjs/.test(quoter.verified.source),
    "provenance should point at the re-runnable prober",
  );
});

// --- fee tiers ----------------------------------------------------------------

test("all four standard fee tiers are searched", () => {
  // Liquidity concentrates in one tier and which one varies by pair and chain.
  // Defaulting to 0.3% silently misprices stable and exotic pairs alike.
  assert.deepEqual(FEE_TIERS, [100, 500, 3000, 10000]);
});

// --- guards -------------------------------------------------------------------

test("the V3 slippage ceiling also refuses to widen", () => {
  assert.equal(applySlippage(10_000n, 50).toString(), "9950");
  assert.throws(() => applySlippage(10_000n, 101), /exceeds the 100 bps ceiling/);
  assert.throws(() => applySlippage(10_000n, 900), /do not widen the guard/);
});

test("quote reports UNAVAILABLE without a quoter, rather than throwing", async () => {
  const venue = v3VenueCapabilities({ chainId: 1, wrappedNative: WETH });
  const r = await venue.quote(
    { tokenIn: WETH, tokenOut: USDC, amountIn: "1" },
    { scanner: { venues: [] } },
  );
  assert.equal(r.evidence, EVIDENCE.UNAVAILABLE);
  assert.match(r.reason, /fail-closed/);
});

test("quote rejects malformed addresses", async () => {
  const venue = v3VenueCapabilities({ chainId: 1, wrappedNative: WETH });
  const scanner = {
    venues: [{ kind: "quoter", address: WETH, verified: { method: "s", source: "s", date: "d" } }],
  };
  await assert.rejects(
    () => venue.quote({ tokenIn: "WETH", tokenOut: USDC, amountIn: "1" }, { scanner }),
    /20-byte addresses/,
  );
});

test("prepareUnsignedTx refuses without a router and validates the recipient", async () => {
  const venue = v3VenueCapabilities({ chainId: 1, wrappedNative: WETH });
  await assert.rejects(
    () =>
      venue.prepareUnsignedTx(
        { tokenIn: WETH, tokenOut: USDC, amountIn: "1", recipient: DEAD },
        { scanner: { venues: [] } },
      ),
    /fail-closed|verified V3 router/,
  );

  const withRouter = {
    venues: [
      { kind: "quoter", address: WETH, verified: { method: "s", source: "s", date: "d" } },
      { kind: "router", address: USDC, verified: { method: "s", source: "s", date: "d" } },
    ],
  };
  await assert.rejects(
    () =>
      venue.prepareUnsignedTx(
        { tokenIn: WETH, tokenOut: USDC, amountIn: "1", recipient: "me" },
        { scanner: withRouter },
      ),
    /valid recipient/,
  );
});

test("sellSimulation reports UNAVAILABLE with no base asset", async () => {
  const venue = v3VenueCapabilities({ chainId: 1 });
  const scanner = {
    venues: [{ kind: "quoter", address: WETH, verified: { method: "s", source: "s", date: "d" } }],
  };
  const r = await venue.sellSimulation({ token: USDC, amountIn: "1" }, { scanner });
  assert.equal(r.verdict, RISK.UNKNOWN);
  assert.equal(r.evidence, EVIDENCE.UNAVAILABLE);
});

// --- custody ------------------------------------------------------------------

test("the V3 adapter cannot produce a signature", () => {
  const src = fs.readFileSync(new URL("../src/scanner/v3-venue.mjs", import.meta.url), "utf8");
  assert.ok(!/privateKey|signTransaction|sendRawTransaction|new Wallet\(/.test(src));
  assert.ok(!/from ["'].*(keystore|get-signer|local-signer)/.test(src));
  assert.match(src, /unsigned: true/);
});

test("V2 and V3 adapters stay separate", () => {
  // Bending one into the other is how a swap gets silently mis-encoded.
  // Check for the V2 selector and real call sites, not the bare word: the file's
  // header comment legitimately explains WHY V3 has no getAmountsOut, and matching
  // prose would make this test fail on its own documentation.
  const v3 = fs.readFileSync(new URL("../src/scanner/v3-venue.mjs", import.meta.url), "utf8");
  const code = v3.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/getAmountsOut/.test(code), "V3 must not call the V2 pricing function");
  assert.ok(!/d06ca61f/.test(code), "V3 must not carry the V2 getAmountsOut selector");
  assert.match(code, /quoteExactInputSingle/);
  assert.match(code, /c6a5026a/); // the V3 quoter selector
});
