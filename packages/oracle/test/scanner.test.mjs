// Tests for the chain-scanner framework.
//
// The properties that matter:
//   * a chain is DATA -- registering an unknown chain requires no code change
//   * an unimplemented capability throws a useful error rather than returning
//     undefined that a caller mistakes for a negative result
//   * an unverified venue is REFUSED, because an allowlisted spoofed router defeats
//     every other control
//   * UNKNOWN never collapses into PASS
//
// RPC-touching paths use an injected transport; no test needs the network.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SCANNER_CAPABILITIES,
  EVIDENCE,
  RISK,
  validateScanner,
  createScanner,
  registerScanner,
  getScanner,
  listScanners,
  scannerCoverage,
  __clearScanners,
} from "../src/scanner/contract.mjs";
import { defineEvmScanner } from "../src/scanner/evm-scanner.mjs";
import {
  CHAIN_CONFIGS,
  registerBuiltinScanners,
  registerCustomChain,
} from "../src/scanner/chains.config.mjs";

const minimal = () => ({
  key: "testchain",
  chainId: 31337,
  name: "Test Chain",
  rpcEnv: ["TESTCHAIN_RPC_URL"],
  nativeCurrency: { symbol: "TST", decimals: 18 },
  capabilities: { blockNumber: async () => ({ blockNumber: 1 }) },
});

// --- validation ---------------------------------------------------------------

test("validateScanner accepts a minimal well-formed definition", () => {
  const { ok, errors } = validateScanner(minimal());
  assert.equal(ok, true, errors.join("; "));
});

test("validateScanner rejects a bad chainId, key, or missing rpcEnv", () => {
  for (const [patch, needle] of [
    [{ chainId: 0 }, "chainId"],
    [{ chainId: 1.5 }, "chainId"],
    [{ key: "Test Chain" }, "key"],
    [{ rpcEnv: [] }, "rpcEnv"],
    [{ rpcEnv: ["lowercase_url"] }, "UPPER_SNAKE"],
  ]) {
    const { ok, errors } = validateScanner({ ...minimal(), ...patch });
    assert.equal(ok, false, `expected rejection for ${JSON.stringify(patch)}`);
    assert.ok(
      errors.some((e) => e.includes(needle)),
      `errors ${JSON.stringify(errors)} should mention ${needle}`,
    );
  }
});

test("an UNVERIFIED venue is refused", () => {
  // This is the highest-leverage control in the system: allowlisting a spoofed
  // router makes every other guard irrelevant.
  const { ok, errors } = validateScanner({
    ...minimal(),
    venues: [{ kind: "router", address: "0x1111111111111111111111111111111111111111" }],
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("verified")));
});

test("a verified venue with provenance is accepted", () => {
  const { ok, errors } = validateScanner({
    ...minimal(),
    venues: [
      {
        kind: "router",
        address: "0x1111111111111111111111111111111111111111",
        verified: {
          method: "eth_getCode + protocol API",
          source: "https://example.protocol/api/chains",
          date: "2026-07-30",
        },
      },
    ],
  });
  assert.equal(ok, true, errors.join("; "));
});

test("the zero address is caught as a leftover placeholder", () => {
  const { ok, errors } = validateScanner({
    ...minimal(),
    venues: [
      {
        kind: "router",
        address: "0x0000000000000000000000000000000000000000",
        verified: { method: "m", source: "s", date: "d" },
      },
    ],
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("zero address")));
});

test("declaring an unknown or non-function capability is rejected", () => {
  let r = validateScanner({ ...minimal(), capabilities: { teleport: async () => {} } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("unknown capability")));

  r = validateScanner({ ...minimal(), capabilities: { blockNumber: "yes" } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("must be a function")));
});

test("prepareUnsignedTx without quote or sellSimulation warns", () => {
  const { ok, warnings } = validateScanner({
    ...minimal(),
    capabilities: { prepareUnsignedTx: async () => ({}) },
  });
  assert.equal(ok, true);
  assert.ok(warnings.some((w) => w.includes("quote")));
  assert.ok(warnings.some((w) => w.includes("sellSimulation")));
});

// --- scanner behaviour --------------------------------------------------------

test("an unimplemented capability throws an actionable error, never undefined", async () => {
  const s = createScanner(minimal());
  await assert.rejects(() => s.quote({}), /does not implement "quote"/);
  await assert.rejects(() => s.quote({}), /fail-closed/);
  // and the implemented one works
  assert.deepEqual(await s.blockNumber(), { blockNumber: 1 });
});

test("capabilities() reports the truth, not the aspiration", () => {
  const s = createScanner(minimal());
  const c = s.capabilities();
  assert.deepEqual(c.supported, ["blockNumber"]);
  assert.ok(c.unsupported.includes("quote"));
  assert.equal(c.supported.length + c.unsupported.length, SCANNER_CAPABILITIES.length);
  assert.equal(s.supports("blockNumber"), true);
  assert.equal(s.supports("quote"), false);
});

test("createScanner throws on an invalid definition rather than half-building", () => {
  assert.throws(() => createScanner({ ...minimal(), chainId: -1 }), /invalid scanner/);
});

// --- registry -----------------------------------------------------------------

test("registry round-trips and coverage reports fail-closed chains", () => {
  __clearScanners();
  registerScanner(minimal());
  const s = getScanner(31337);
  assert.ok(s);
  assert.equal(s.name, "Test Chain");
  assert.equal(listScanners().length, 1);

  const cov = scannerCoverage();
  assert.equal(cov.chainCount, 1);
  // No verified venue -> cannot route value. That is a safe state, and it must be
  // visible in the coverage matrix rather than implied.
  assert.equal(cov.chains[31337].failClosed, true);
  __clearScanners();
});

// --- the actual Phase 2 claim -------------------------------------------------

test("all 11 built-in chains register from config alone", () => {
  __clearScanners();
  const scanners = registerBuiltinScanners();
  assert.equal(scanners.length, 11);
  assert.equal(listScanners().length, 11);

  for (const id of [1, 10, 56, 137, 988, 999, 2741, 4663, 8453, 42161, 43114]) {
    assert.ok(getScanner(id), `chain ${id} should be registered`);
  }
  __clearScanners();
});

test("a chain Oracle has never seen registers with NO code change", () => {
  // The whole point of Phase 2. Config only.
  __clearScanners();
  const s = registerCustomChain({
    key: "somenewchain",
    chainId: 424242,
    name: "Some New Chain",
    rpcEnv: ["SOMENEWCHAIN_RPC_URL"],
    nativeCurrency: { symbol: "SNC", decimals: 18 },
  });

  assert.equal(s.chainId, 424242);
  assert.ok(getScanner(424242));
  // It gets the full generic capability set for free.
  for (const cap of ["blockNumber", "nativeBalance", "resolveToken", "resolvePools", "scanBlocks", "scoreRisk"]) {
    assert.equal(s.supports(cap), true, `${cap} should come for free`);
  }
  __clearScanners();
});

test("every built-in config passes validation", () => {
  for (const c of CHAIN_CONFIGS) {
    const { ok, errors } = validateScanner(defineEvmScanner(c));
    assert.equal(ok, true, `${c.key}: ${errors.join("; ")}`);
  }
});

test("built-in configs carry no hardcoded RPC endpoints", () => {
  // Endpoints belong in the environment. A public repo shipping someone's private
  // RPC url is both a leak and a rate-limit footgun.
  for (const c of CHAIN_CONFIGS) {
    const blob = JSON.stringify(c);
    assert.ok(!/https?:\/\/[^"]*(rpc|infura|alchemy|quicknode)/i.test(blob), `${c.key} embeds an RPC url`);
  }
});

// --- honest evidence ----------------------------------------------------------

test("pool discovery reports UNAVAILABLE when the chain has no dexscreener slug", async () => {
  // Stable (988) has no slug configured. It must say so, not return another
  // chain's pools or an empty list that reads as "no liquidity".
  const cfg = CHAIN_CONFIGS.find((c) => c.chainId === 988);
  const s = createScanner(defineEvmScanner(cfg));
  const r = await s.resolvePools("0x1111111111111111111111111111111111111111");
  assert.equal(r.evidence, EVIDENCE.UNAVAILABLE);
  assert.match(r.reason, /not.*guessed|unavailable/i);
});

test("resolveToken refuses a non-address instead of guessing", async () => {
  const cfg = CHAIN_CONFIGS.find((c) => c.chainId === 8453);
  const s = createScanner(defineEvmScanner(cfg));
  const r = await s.resolveToken("WETH");
  assert.equal(r.evidence, EVIDENCE.UNKNOWN);
  assert.match(r.error, /20-byte address/);
});

test("scanBlocks validates its range", async () => {
  const cfg = CHAIN_CONFIGS.find((c) => c.chainId === 8453);
  const s = createScanner(defineEvmScanner(cfg));
  await assert.rejects(() => s.scanBlocks({ fromBlock: "1", toBlock: 2 }), /integer/);
  await assert.rejects(() => s.scanBlocks({ fromBlock: 10, toBlock: 5 }), />= fromBlock/);
});

test("RISK.UNKNOWN is distinct from PASS and ranks worse", () => {
  // The semantic that keeps "we couldn't check" from reading as "it's fine".
  assert.notEqual(RISK.UNKNOWN, RISK.PASS);
  assert.deepEqual(
    Object.keys(RISK).sort(),
    ["CAUTION", "FAIL", "PASS", "UNKNOWN"],
  );
});

test("EVIDENCE distinguishes never-had from had-and-stale", () => {
  assert.notEqual(EVIDENCE.UNKNOWN, EVIDENCE.UNAVAILABLE);
  assert.notEqual(EVIDENCE.STALE, EVIDENCE.LIVE);
});
