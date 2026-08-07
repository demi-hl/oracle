import { test } from "node:test";
import assert from "node:assert/strict";
import { validateNftMintGasWar, assertNftMintGasWar, NftGasWarLimitError } from "../src/nft-gas-war-guard.mjs";

const CHAIN = 8453;

test("NFT mint gas-war guard passes within total, unit, and priority caps", () => {
  const verdict = validateNftMintGasWar({
    chainId: CHAIN,
    tx: { gasLimit: "200000", maxFeePerGas: "2000000000", maxPriorityFeePerGas: "500000000" },
    policy: {
      maxTotalGasWei: "500000000000000",
      maxFeePerGasWei: "3000000000",
      maxPriorityFeePerGasWei: "1000000000",
    },
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.status, "PASS");
  assert.equal(verdict.totalGasWei, "400000000000000");
});

test("NFT mint gas-war guard blocks total gas above cap", () => {
  const verdict = validateNftMintGasWar({
    chainId: CHAIN,
    tx: { gasLimit: "250000", maxFeePerGas: "3000000000" },
    policy: { maxTotalGasWei: "500000000000000" },
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /total gas .* exceeds cap/);
});

test("NFT mint gas-war guard blocks per-unit gas wars even if total cap is high", () => {
  const verdict = validateNftMintGasWar({
    chainId: CHAIN,
    tx: { gasLimit: "100000", maxFeePerGas: "90000000000", maxPriorityFeePerGas: "4000000000" },
    policy: { maxTotalGasWei: "10000000000000000", maxFeePerGasWei: "20000000000", maxPriorityFeePerGasWei: "3000000000" },
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /unit fee .* exceeds cap/);
});

test("NFT mint gas-war guard blocks priority-fee tip above cap", () => {
  const verdict = validateNftMintGasWar({
    chainId: CHAIN,
    tx: { gasLimit: "100000", maxFeePerGas: "1000000000", maxPriorityFeePerGas: "4000000000" },
    policy: { maxTotalGasWei: "10000000000000000", maxPriorityFeePerGasWei: "3000000000" },
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /priority fee .* exceeds cap/);
});

test("NFT mint gas-war guard fails closed when no gas cap is supplied", () => {
  const verdict = validateNftMintGasWar({ chainId: CHAIN, tx: { gasLimit: "100000", maxFeePerGas: "1" } });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /maxTotalGasWei required/);
});

test("assertNftMintGasWar throws typed error on block", () => {
  assert.throws(
    () => assertNftMintGasWar({ chainId: CHAIN, tx: { gasLimit: "100000", maxFeePerGas: "1" } }),
    NftGasWarLimitError,
  );
});

test("root package exports NFT mint gas-war guard", async () => {
  const root = await import("@oracle-agent/oracle");
  assert.equal(typeof root.validateNftMintGasWar, "function");
  assert.equal(typeof root.assertNftMintGasWar, "function");
});
