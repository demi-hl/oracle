// Round-2 red team fixes: capless transfer guard, gas fail-open, uncapped
// Satflow purchase, DNS-rebinding on the data server, and the op denylist that
// was not a boundary. Each test is the attack, not a happy path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface, MaxUint256 } from "ethers";

import { assertTokenTransferGuard } from "../src/token-transfer-guard.mjs";
import { createSessionGrant, assertSessionAuthorized } from "../src/public-control/session-key-model.mjs";
import { satflowPreparePurchase } from "../src/data/providers/satflow.mjs";
import { assertDataOpAllowed } from "../src/data/desk-data.mjs";

const ERC20 = new Interface(["function transfer(address,uint256)"]);
const TOKEN = "0x4444444444444444444444444444444444444444";
const RECIPIENT = "0x5555555555555555555555555555555555555555";

test("a capless transfer guard is refused — it authorized any amount", () => {
  const guard = {
    mode: "token-transfer",
    chainId: 8453,
    token: TOKEN,
    kind: "transfer",
    recipient: RECIPIENT,
    issuedAtMs: Date.now() - 1000,
    expiresAtMs: Date.now() + 20_000,
    // amount and maxAmount both omitted — the reported CRITICAL
  };
  const tx = {
    chainId: 8453,
    to: TOKEN,
    value: "0",
    data: ERC20.encodeFunctionData("transfer", [RECIPIENT, MaxUint256 - 1n]),
  };
  assert.throws(() => assertTokenTransferGuard(guard, tx, { chainId: 8453 }), /must bind an amount or a maxAmount/);
});

test("a guard with a maxAmount still bounds the transfer", () => {
  const base = {
    mode: "token-transfer",
    chainId: 8453,
    token: TOKEN,
    kind: "transfer",
    recipient: RECIPIENT,
    issuedAtMs: Date.now() - 1000,
    expiresAtMs: Date.now() + 20_000,
    maxAmount: "1000",
  };
  const mk = (amount) => ({
    chainId: 8453,
    to: TOKEN,
    value: "0",
    data: ERC20.encodeFunctionData("transfer", [RECIPIENT, amount]),
  });
  assert.ok(assertTokenTransferGuard(base, mk(1000n), { chainId: 8453 }));
  assert.throws(() => assertTokenTransferGuard(base, mk(1001n), { chainId: 8453 }), /exceeds guard maxAmount/);
});

test("a guard whose amount exceeds its own maxAmount is incoherent and refused", () => {
  const guard = {
    mode: "token-transfer",
    chainId: 8453,
    token: TOKEN,
    kind: "transfer",
    recipient: RECIPIENT,
    issuedAtMs: Date.now() - 1000,
    expiresAtMs: Date.now() + 20_000,
    amount: "5000",
    maxAmount: "1000",
  };
  const tx = {
    chainId: 8453,
    to: TOKEN,
    value: "0",
    data: ERC20.encodeFunctionData("transfer", [RECIPIENT, 5000n]),
  };
  assert.throws(() => assertTokenTransferGuard(guard, tx, { chainId: 8453 }), /exceeds its own maxAmount/);
});

test("omitting gasWei no longer satisfies a grant that bounds gas", () => {
  const grant = createSessionGrant({
    provider: "safe",
    owner: "0x1111111111111111111111111111111111111111",
    agent: "0x2222222222222222222222222222222222222222",
    chainId: 8453,
    actions: ["erc20:transfer"],
    targets: ["0x3333333333333333333333333333333333333333"],
    maxValueWei: "0",
    maxGasWei: "1",
    issuedAtMs: Date.now() - 1000,
    expiresAtMs: Date.now() + 60_000,
  });
  const request = {
    action: "erc20:transfer",
    chainId: 8453,
    target: "0x3333333333333333333333333333333333333333",
    valueWei: "0",
    // gasWei deliberately omitted
  };
  assert.throws(() => assertSessionAuthorized(grant, request), /omitted gasWei/);
  assert.ok(assertSessionAuthorized(grant, { ...request, gasWei: "1" }));
  assert.throws(() => assertSessionAuthorized(grant, { ...request, gasWei: "2" }), /exceeds session cap/);
});

test("a Satflow purchase without maxSats is refused before any network call", async () => {
  await assert.rejects(
    () =>
      satflowPreparePurchase(
        { listing_id: "listing-1", price: 100000 },
        { apiKey: "k", fetchImpl: async () => { throw new Error("must not reach the network"); } }
      ),
    /maxSats is required/
  );
});

test("a Satflow purchase above the cap is refused and the PSBT is withheld", async () => {
  await assert.rejects(
    () =>
      satflowPreparePurchase(
        { listing_id: "listing-1", price: 100000, maxSats: 1 },
        { apiKey: "k", fetchImpl: async () => { throw new Error("must not reach the network"); } }
      ),
    /exceeds maxSats cap/
  );
});

test("a venue that settles above the cap has its PSBT withheld", async () => {
  await assert.rejects(
    () =>
      satflowPreparePurchase(
        { listing_id: "listing-1", maxSats: 1000 },
        {
          apiKey: "k",
          // Caller asked for nothing specific; the venue comes back expensive.
          fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ price: 999999, psbt: "cHNidP8" }) }),
        }
      ),
    /exceeds maxSats cap .* PSBT withheld/
  );
});

test("the op denylist blocks settlement verbs the old regex let through", () => {
  for (const op of ["txBroadcast", "doSend", "rawSign", "orderSubmit", "batchWrite", "forceExecute"]) {
    assert.throws(() => assertDataOpAllowed("defillama", op, {}), /forbidden op/, `${op} must be rejected`);
  }
});

test("declared read ops still pass", () => {
  assert.doesNotThrow(() => assertDataOpAllowed("defillama", "prices", {}));
});
