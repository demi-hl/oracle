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

test("ignores a malformed address", () => {
  assert.equal(configuredAddress(envFile("ORACLE_EVM_ADDRESS=0xnope\n")), null);
});

test("missing file is no wallet, not a crash", () => {
  assert.equal(configuredAddress("/nonexistent/exec.env"), null);
});

test("holding the NFT returns a 0% Oracle integrator fee", async () => {
  const status = await getHolderStatus({
    address: HOLDER,
    balanceOf: async () => 1n,
  });
  assert.equal(status.holder, true);
  assert.equal(status.reason, "holder");
  assert.equal(status.verified, true);
  assert.equal(status.balance, "1");
  assert.equal(status.oracleIntegratorFeeBps, 0);
});

test("zero balance returns standard fee status without denying access", async () => {
  const status = await getHolderStatus({
    address: HOLDER,
    balanceOf: async () => 0n,
  });
  assert.equal(status.holder, false);
  assert.equal(status.reason, "standard-fee");
  assert.equal(status.verified, true);
  assert.equal(status.oracleIntegratorFeeBps, null);
});

test("no wallet configured is fee status only", async () => {
  const status = await getHolderStatus({
    address: null,
    balanceOf: async () => 0n,
  });
  assert.equal(status.configured, false);
  assert.equal(status.reason, "no-wallet");
  assert.equal(status.oracleIntegratorFeeBps, null);
});

test("an RPC failure is unverifiable, never a denial", async () => {
  const status = await getHolderStatus({
    address: HOLDER,
    balanceOf: async () => {
      throw new Error("hyperevm down");
    },
  });
  assert.equal(status.reason, "unverifiable");
  assert.equal(status.verified, false);
  assert.equal(status.oracleIntegratorFeeBps, null);
});

test("fee lookup targets the verified Locals Only contract on HyperEVM", async () => {
  const status = await getHolderStatus({
    address: HOLDER,
    balanceOf: async () => 1n,
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
