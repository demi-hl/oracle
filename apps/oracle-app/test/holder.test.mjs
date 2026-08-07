/**
 * Holder gate behaviour for the desktop app.
 *
 * The gate decides what a user can DO in the app, so its edge cases matter more
 * than its happy path: an RPC blip must not lock out a real holder, and a
 * missing wallet must be reported as "not set up" rather than "denied".
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { configuredAddress, getHolderStatus, isAddress } from "../lib/oracle/holder.ts";

const HOLDER = "0x1111111111111111111111111111111111111111";

function envFile(contents) {
  const dir = mkdtempSync(path.join(tmpdir(), "oracle-holder-"));
  const file = path.join(dir, "exec.env");
  writeFileSync(file, contents);
  return file;
}

test("reads the configured wallet from exec.env", () => {
  const file = envFile(`ORACLE_EVM_ADDRESS=${HOLDER}\nOTHER=1\n`);
  assert.equal(configuredAddress(file), HOLDER);
});

test("accepts export- and quote-wrapped forms", () => {
  assert.equal(configuredAddress(envFile(`export ORACLE_EVM_ADDRESS="${HOLDER}"\n`)), HOLDER);
  assert.equal(configuredAddress(envFile(`ORACLE_EVM_ADDRESS='${HOLDER}'\n`)), HOLDER);
});

test("ignores a malformed address rather than trusting it", () => {
  assert.equal(configuredAddress(envFile("ORACLE_EVM_ADDRESS=0xnope\n")), null);
});

test("missing file is no wallet, not a crash", () => {
  assert.equal(configuredAddress("/nonexistent/exec.env"), null);
});

test("holding the NFT unlocks", async () => {
  const status = await getHolderStatus({
    address: HOLDER,
    balanceOf: async () => 1n,
    env: {},
    operator: () => false,
  });
  assert.equal(status.holder, true);
  assert.equal(status.reason, "holder");
  assert.equal(status.verified, true);
  assert.equal(status.balance, "1");
});

test("zero balance denies", async () => {
  const status = await getHolderStatus({
    address: HOLDER,
    balanceOf: async () => 0n,
    env: {},
    operator: () => false,
  });
  assert.equal(status.holder, false);
  assert.equal(status.reason, "denied");
  assert.equal(status.verified, true);
});

test("no wallet configured is its own state, not a denial", async () => {
  const status = await getHolderStatus({
    address: null,
    balanceOf: async () => 0n,
    env: {},
    operator: () => false,
  });
  assert.equal(status.configured, false);
  assert.equal(status.reason, "no-wallet");
});

test("an RPC failure is unverifiable, never a silent denial", async () => {
  const status = await getHolderStatus({
    address: HOLDER,
    balanceOf: async () => {
      throw new Error("hyperevm down");
    },
    env: {},
    operator: () => false,
  });
  assert.equal(status.reason, "unverifiable");
  assert.equal(status.verified, false);
});

test("bypass is honoured for CI only when explicitly set", async () => {
  const status = await getHolderStatus({
    address: HOLDER,
    balanceOf: async () => 0n,
    env: { ORACLE_GATE_BYPASS: "1" },
    operator: () => false,
  });
  assert.equal(status.holder, true);
  assert.equal(status.reason, "bypass");
  // Bypass must never claim to be a real on-chain verification.
  assert.equal(status.verified, false);
});

test("the admin operator is never gated behind the user token", async () => {
  // Operator holds the keys and signs; requiring it to also hold a Locals Only
  // NFT would lock the owner out of their own executor wallet.
  const status = await getHolderStatus({
    address: HOLDER,
    balanceOf: async () => {
      throw new Error("must not be consulted for an operator");
    },
    env: {},
    operator: () => true,
  });
  assert.equal(status.holder, true);
  assert.equal(status.reason, "operator");
  assert.equal(status.verified, false);
});

test("operator unlock does not depend on a configured wallet", async () => {
  const status = await getHolderStatus({
    address: null,
    balanceOf: async () => 0n,
    env: {},
    operator: () => true,
  });
  assert.equal(status.holder, true);
  assert.equal(status.reason, "operator");
});

test("gate targets the verified Locals Only contract on HyperEVM", async () => {
  const status = await getHolderStatus({
    address: HOLDER,
    balanceOf: async () => 1n,
    env: {},
    operator: () => false,
  });
  assert.equal(status.contract, "0x62FCFAf7573AD8B41a0FBF347AfEb85e06599A75");
  assert.equal(status.chainId, 999);
});

test("address validation rejects near-misses", () => {
  assert.equal(isAddress(HOLDER), true);
  assert.equal(isAddress(HOLDER.slice(0, -1)), false);
  assert.equal(isAddress(`${HOLDER}ff`), false);
  assert.equal(isAddress(""), false);
  assert.equal(isAddress(null), false);
});
