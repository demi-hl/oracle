// Round-7 regressions (Opus 5 + Grok DO_NOT_SHIP).
//
// Grok: allowance selectors were recognised but only approve() decoded —
// legitimate increaseAllowance / permit became unsignable.
// Opus: HL signed any action type; unsigned slippage guards forged floors;
// approval guard skipped fresh-window; approve calldata skipped dest allowlist;
// keyFile contents leaked via ethers errors.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Interface } from "ethers";
process.env.ORACLE_ROUTE_ATTESTATION_SECRET ||= "oracle-unit-test-secret";
process.env.ORACLE_TEST_ISOLATE_SECRETS = "1";

import { enforceTxPolicy } from "../src/exec-policy.mjs";
import {
  createApprovalGuard,
  decodeApproveCalldata,
  isApprovalCall,
} from "../src/approval-guard.mjs";
import { assertAutoSlippageGuard, createAutoSlippageGuard } from "../src/auto-slippage.mjs";
import { assertGmxApprovalAttestation } from "../src/gmx-attestation.mjs";
import { assertVaultApprovalAttestation } from "../src/vault-attestation.mjs";
import { SWAP_VENUES } from "../src/venues.mjs";

const CHAIN = 8453;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ROUTER = SWAP_VENUES[8453][0];
const EVIL = "0x00000000000000000000000000000000deadbeef";
const ERC20 = new Interface(["function approve(address spender,uint256 amount) returns (bool)"]);
const w = (v) => BigInt(v).toString(16).padStart(64, "0");
const addr = (a) => a.slice(2).toLowerCase().padStart(64, "0");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function signedAttestation(payload, secret) {
  return {
    ...payload,
    signature: `0x${createHmac("sha256", secret).update(canonicalJson(payload)).digest("hex")}`,
  };
}

test("every recognised allowance shape decodes AND signs under policy", () => {
  const cases = [
    ["approve", "0x095ea7b3" + addr(ROUTER) + w(1000)],
    ["increaseAllowance", "0x39509351" + addr(ROUTER) + w(1000)],
    ["forceApprove", "0x61f49ed6" + addr(USDC) + addr(ROUTER) + w(1000)],
    ["safeApprove", "0xeb5625d9" + addr(USDC) + addr(ROUTER) + w(1000)],
    ["EIP2612 permit", "0xd505accf" + addr(ROUTER) + addr(ROUTER) + w(1000) + w(9e12) + w(27) + w(0) + w(0)],
    ["Permit2 approve", "0x87517c45" + addr(USDC) + addr(ROUTER) + w(1000) + w(9e12)],
  ];
  for (const [name, data] of cases) {
    assert.equal(isApprovalCall(data), true, `${name} recognised`);
    const d = decodeApproveCalldata(data);
    assert.equal(d.spender, ROUTER.toLowerCase(), `${name} spender`);
    assert.equal(d.amount, "1000", `${name} amount`);
    const madApproval = createApprovalGuard({
      chainId: CHAIN,
      token: USDC,
      spender: ROUTER,
      amount: "1000",
    });
    assert.doesNotThrow(
      () => enforceTxPolicy({ chainId: CHAIN, to: USDC, value: "0", data, madApproval }, "sign"),
      `${name} must be signable`
    );
  }
});

test("over-cap and wrong-spender increaseAllowance stay blocked", () => {
  const madApproval = createApprovalGuard({
    chainId: CHAIN,
    token: USDC,
    spender: ROUTER,
    amount: "1000",
  });
  const over = "0x39509351" + addr(ROUTER) + w("999999999999999999999");
  assert.throws(
    () => enforceTxPolicy({ chainId: CHAIN, to: USDC, value: "0", data: over, madApproval }, "sign"),
    /mismatch|amount/
  );
  const wrong = "0x39509351" + addr("0x000000000000000000000000000000000000dEaD") + w(1000);
  assert.throws(
    () => enforceTxPolicy({ chainId: CHAIN, to: USDC, value: "0", data: wrong, madApproval }, "sign"),
    /spender/
  );
});

test("undecodable-but-recognised allowance selectors fail closed", () => {
  // Permit2 permitBatch is recognised so it cannot skip the guard, but we do
  // not yet decode its nested shape — refuse rather than pass unbound.
  const data = "0x2a2d80d1" + w(0);
  assert.equal(isApprovalCall(data), true);
  assert.throws(() => decodeApproveCalldata(data), /not decodable|recognised but not decodable/);
});

test("approval guard requires fresh-window timestamps and a finite clock", async () => {
  const data = "0x095ea7b3" + addr(ROUTER) + w(1000);
  const good = createApprovalGuard({ chainId: CHAIN, token: USDC, spender: ROUTER, amount: "1000" });
  const { expiresAtMs: _e, issuedAtMs: _i, ...timeless } = good;
  assert.throws(
    () => enforceTxPolicy({ chainId: CHAIN, to: USDC, value: "0", data, madApproval: timeless }, "sign"),
    /expiresAtMs|issuedAtMs|finite|required/
  );
  const expired = { ...good, issuedAtMs: 1_000_000, expiresAtMs: 1_020_000 };
  const { assertApprovalGuard } = await import("../src/approval-guard.mjs");
  for (const nowMs of [NaN, null, "later", {}]) {
    assert.throws(
      () => assertApprovalGuard(expired, { chainId: CHAIN, to: USDC, data, value: "0" }, { chainId: CHAIN, nowMs }),
      /finite|current time/,
      `nowMs=${String(nowMs)}`
    );
  }
  assert.throws(
    () => assertApprovalGuard(expired, { chainId: CHAIN, to: USDC, data, value: "0" }, { chainId: CHAIN, nowMs: Date.now() }),
    /expired/
  );
});

test("approve-shaped calldata cannot bypass the destination allowlist", () => {
  const data = "0x095ea7b3" + addr(ROUTER) + w(1000);
  const madApproval = createApprovalGuard({
    chainId: CHAIN,
    token: EVIL,
    spender: ROUTER,
    amount: "1000",
  });
  assert.throws(
    () => enforceTxPolicy({ chainId: CHAIN, to: EVIL, value: "0", data: "0xdeadbeef" }, "sign"),
    /not allowlisted/
  );
  assert.throws(
    () => enforceTxPolicy({ chainId: CHAIN, to: EVIL, value: "0", data, madApproval }, "sign"),
    /not allowlisted/
  );
});

test("vault and GMX approval attestations require explicit freshness windows", () => {
  const secret = "expiryless-approval-secret";
  const amount = "1000";
  const vault = "0x2222222222222222222222222222222222222222";
  const gmxRouter = "0x1c3fa76e6e1088bce750f23a5bfcffa1efef6a41";

  const vaultAttestation = signedAttestation(
    {
      mode: "vault-attestation",
      version: 1,
      provider: "morpho",
      chainId: CHAIN,
      action: "deposit",
      vault,
      asset: USDC,
      amount,
    },
    secret
  );
  assert.throws(
    () =>
      assertVaultApprovalAttestation(
        vaultAttestation,
        { chainId: CHAIN, to: USDC, data: ERC20.encodeFunctionData("approve", [vault, amount]) },
        { amount, provider: "morpho" },
        { chainId: CHAIN, nowMs: Date.now(), secret }
      ),
    /expiresAtMs|freshness|finite|required/
  );

  const gmxAttestation = signedAttestation(
    {
      mode: "gmx-order-attestation",
      version: 1,
      provider: "gmx",
      chainId: 42161,
      router: gmxRouter,
      initialCollateralToken: USDC,
      initialCollateralDeltaAmount: amount,
    },
    secret
  );
  assert.throws(
    () =>
      assertGmxApprovalAttestation(
        gmxAttestation,
        { chainId: 42161, to: USDC, data: ERC20.encodeFunctionData("approve", [gmxRouter, amount]) },
        { amount, provider: "gmx" },
        { chainId: 42161, nowMs: Date.now(), secret }
      ),
    /expiresAtMs|freshness|finite|required/
  );
});

test("unsigned slippage guards are refused even when bounds look tight", () => {
  const secret = "round7-secret";
  const g = createAutoSlippageGuard({
    chainId: CHAIN,
    venue: ROUTER,
    quoteAmountOut: "1000000",
    liquidityUsd: 250_000,
    secret,
  });
  const forged = {
    mode: "auto",
    chainId: CHAIN,
    venue: ROUTER,
    quoteAmountOut: "1",
    minAmountOut: "1",
    requiredBps: 0,
    selectedBps: 0,
    capBps: 0,
    quotedAtMs: Date.now(),
    expiresAtMs: Date.now() + 20_000,
    // no signature
  };
  const data =
    "0x414bf389" + w(0) + w(0) + w(3000) + w(0) + w(0) + w(100n * 10n ** 18n) + w(1) + w(0);
  assert.throws(
    () => assertAutoSlippageGuard(forged, { chainId: CHAIN, venue: ROUTER, secret, tx: { chainId: CHAIN, to: ROUTER, data } }),
    /signature/
  );
  const goodData =
    "0x414bf389" + w(0) + w(0) + w(3000) + w(0) + w(0) + w("1000") + w(g.minAmountOut) + w(0);
  assert.doesNotThrow(() =>
    assertAutoSlippageGuard(g, { chainId: CHAIN, venue: ROUTER, secret, tx: { chainId: CHAIN, to: ROUTER, data: goodData } })
  );
});

test("missing attestation secret refuses sign/broadcast, not quote", () => {
  // Quotes may attach an unsigned bound. The signer boundary (requireSigned)
  // must refuse rather than going unauthenticated.
  const unsigned = createAutoSlippageGuard({
    chainId: CHAIN,
    venue: ROUTER,
    quoteAmountOut: "1000000",
    liquidityUsd: 250_000,
    secret: "",
  });
  assert.equal(unsigned.signature, undefined);
  const data =
    "0x414bf389" + w(0) + w(0) + w(3000) + w(0) + w(0) + w("1000") + w(unsigned.minAmountOut) + w(0);
  assert.throws(
    () =>
      assertAutoSlippageGuard(unsigned, {
        chainId: CHAIN,
        venue: ROUTER,
        secret: "",
        requireSigned: true,
        tx: { chainId: CHAIN, to: ROUTER, data },
      }),
    /ORACLE_ROUTE_ATTESTATION_SECRET|attestation secret required|required/
  );
});


