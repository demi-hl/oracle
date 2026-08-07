// Provider/contract parity for approval classification.
//
// The scanning provider (this package) and the public app classify the same
// approvals, but neither can import the other: the app must not depend on an
// execution-capable package, and this package is published to npm and must not
// gain a dependency edge on the contract package. So the rules exist twice.
//
// Duplication is exactly what let an NFT-shaped approval get classified one way
// upstream and silently dropped downstream. This test is the seam: the two
// copies must agree on every constant and every classification, or CI fails.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT = readFileSync(join(here, "../../contract/src/index.ts"), "utf8");
const PROVIDER = readFileSync(join(here, "../src/data/providers/approvals.mjs"), "utf8");

test("the unlimited floor is identical on both sides", () => {
  // contract: ((1n << 256n) - 1n) / 2n
  assert.match(CONTRACT, /ORACLE_UNLIMITED_FLOOR\s*=\s*\(\(1n\s*<<\s*256n\)\s*-\s*1n\)\s*\/\s*2n/);
  // provider: UINT256_MAX / 2n where UINT256_MAX = (1n << 256n) - 1n
  assert.match(PROVIDER, /UINT256_MAX\s*=\s*\(1n\s*<<\s*256n\)\s*-\s*1n/);
  assert.match(PROVIDER, /UNLIMITED_FLOOR\s*=\s*UINT256_MAX\s*\/\s*2n/);
});

test("the stale window is identical on both sides", () => {
  const window = /180\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/;
  assert.match(CONTRACT, new RegExp(`ORACLE_STALE_AFTER_MS\\s*=\\s*${window.source}`));
  assert.match(PROVIDER, new RegExp(`STALE_AFTER_MS\\s*=\\s*${window.source}`));
});

test("both sides know the same risk tiers", () => {
  for (const tier of ["operator-all", "unlimited", "unknown-spender", "stale", "scoped"]) {
    assert.ok(CONTRACT.includes(`"${tier}"`), `contract must define risk tier ${tier}`);
  }
  // The provider emits operator-all directly and derives the rest via riskFor.
  assert.ok(PROVIDER.includes('risk: "operator-all"'), "provider must emit operator-all");
  for (const tier of ["unlimited", "unknown-spender", "stale", "scoped"]) {
    assert.ok(PROVIDER.includes(`"${tier}"`), `provider must emit risk tier ${tier}`);
  }
});

test("an operator grant outranks an unlimited allowance on both sides", () => {
  // Contract: the erc721 check precedes the unlimited check.
  const contractFn = CONTRACT.slice(CONTRACT.indexOf("export function oracleApprovalRisk"));
  const erc721At = contractFn.indexOf('standard === "erc721"');
  const unlimitedAt = contractFn.indexOf("input.unlimited");
  assert.ok(erc721At !== -1 && unlimitedAt !== -1);
  assert.ok(erc721At < unlimitedAt, "erc721 must be classified before unlimited");

  // Provider: operator grants are emitted with the operator-all tier, never
  // folded into the amount-based scale.
  assert.ok(
    !/risk:\s*riskFor\([^)]*erc721/.test(PROVIDER),
    "provider must not route operator grants through the amount-based classifier",
  );
});

test("operator grants carry no amount on either side", () => {
  assert.ok(
    CONTRACT.includes('if (standard === "erc721") return "ALL ITEMS"'),
    "contract display must special-case operator grants",
  );
  assert.ok(
    PROVIDER.includes('allowanceDisplay: "ALL ITEMS"'),
    "provider must emit ALL ITEMS for operator grants",
  );
  assert.ok(PROVIDER.includes("allowance: null"), "provider operator grants must have a null amount");
});
