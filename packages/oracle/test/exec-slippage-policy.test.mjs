import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { enforceTxPolicy } from "../src/exec-policy.mjs";
import { SWAP_VENUES, isSwapVenue, venuesFor } from "../src/venues.mjs";
import {
  bindAutoSlippageGuardToCall,
  createAutoSlippageGuard,
  signAutoSlippageGuard,
} from "../src/auto-slippage.mjs";
import { createApprovalGuard, buildApprovalRevokeTransaction } from "../src/approval-guard.mjs";
import { createTokenTransferGuard } from "../src/token-transfer-guard.mjs";
import { createRouteAttestation } from "../src/route-attestation.mjs";
import { createVaultAttestation } from "../src/vault-attestation.mjs";
import { createGmxOrderAttestation } from "../src/gmx-attestation.mjs";

// Isolated test runs have no ~/.config secret; signing is mandatory.
process.env.ORACLE_ROUTE_ATTESTATION_SECRET = "oracle-test-route-attestation";

// A REAL, decodable router call whose encoded amountOutMinimum matches the
// guard under test. Placeholder calldata like "0x12345678" is now refused at
// swap venues (unknown selectors fail closed), so tests that exercise OTHER
// invariants must carry calldata the guard can actually verify.
const padWord = (v) => BigInt(v).toString(16).padStart(64, "0");
function swapCalldata(minOut) {
  // V3 exactInputSingle: amountOutMinimum is head word 6.
  return "0x414bf389" + padWord(0) + padWord(0) + padWord(3000) + padWord(0) +
         padWord(0) + padWord("1000") + padWord(minOut) + padWord(0);
}


const ERC20 = new Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);

const LIFI_DIAMONDS = {
  1: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae",
  10: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae",
  56: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae",
  137: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae",
  988: "0x026f252016a7c47cdef1f05a3fc9e20c92a49c37",
  999: "0x0a0758d937d1059c356d4714e57f5df0239bce1a",
  2741: "0x4f8c9056bb8a3616693a76922fa35d53c056e5b3",
  4663: "0xb477751b76cf82d00a686a1232f5fcd772414af3",
  8453: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae",
  42161: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae",
  43114: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae",
};

function guard(chainId, venue) {
  return createAutoSlippageGuard({
    chainId,
    venue,
    quoteAmountOut: "1000000",
    liquidityUsd: 250_000,
  });
}

test("every registered multichain swap venue fails closed without call-bound auto-slippage proof", () => {
  const data = "0x12345678";
  for (const [rawChainId, venues] of Object.entries(SWAP_VENUES)) {
    const chainId = Number(rawChainId);
    for (const to of venues) {
      assert.equal(isSwapVenue(chainId, to), true);
      assert.throws(
        () => enforceTxPolicy({ chainId, to, value: "0", data }, "sign"),
        /bounded auto-slippage guard required/
      );
      const unbound = guard(chainId, to);
      assert.throws(
        () => enforceTxPolicy({ chainId, to, value: "0", data, madSlippage: unbound }, "sign"),
        /cannot verify the output floor/,
      );
      const bound = bindAutoSlippageGuardToCall(unbound, { chainId, venue: to, data });
      assert.doesNotThrow(() =>
        enforceTxPolicy({ chainId, to, value: "0", data, madSlippage: bound }, "sign")
      );
      const decodable = guard(chainId, to);
      assert.doesNotThrow(() =>
        enforceTxPolicy(
          { chainId, to, value: "0", data: swapCalldata(decodable.minAmountOut), madSlippage: decodable },
          "sign"
        )
      );
    }
  }
});

test("LI.FI diamond is a swap venue on every desk-provided EVM chain", () => {
  for (const [rawChainId, diamond] of Object.entries(LIFI_DIAMONDS)) {
    const chainId = Number(rawChainId);
    assert.ok(venuesFor(chainId).has(diamond), `LI.FI diamond missing from venues for ${chainId}`);
    assert.equal(isSwapVenue(chainId, diamond), true, `LI.FI diamond missing from swap venues for ${chainId}`);
  }
});

test("ERC20 token transfers fail closed unless an exact transfer guard binds recipient and amount", () => {
  const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const recipient = "0x2222222222222222222222222222222222222222";
  const amount = "1000000";
  const data = ERC20.encodeFunctionData("transfer", [recipient, amount]);
  assert.equal(isSwapVenue(8453, usdc), false);
  assert.throws(
    () => enforceTxPolicy({ chainId: 8453, to: usdc, value: "0", data }, "sign"),
    /token transfer guard required/,
  );
  const madTokenTransfer = createTokenTransferGuard({
    chainId: 8453,
    token: usdc,
    kind: "transfer",
    recipient,
    amount,
    purpose: "controlled-withdrawal",
  });
  assert.doesNotThrow(() =>
    enforceTxPolicy({ chainId: 8453, to: usdc, value: "0", data, madTokenTransfer }, "sign"),
  );
  const wrongRecipient = ERC20.encodeFunctionData("transfer", ["0x3333333333333333333333333333333333333333", amount]);
  assert.throws(
    () => enforceTxPolicy({ chainId: 8453, to: usdc, value: "0", data: wrongRecipient, madTokenTransfer }, "sign"),
    /token transfer recipient mismatch/,
  );
});

test("ERC20 approvals require bounded approval guard and vetted spender", () => {
  const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const router = SWAP_VENUES[8453][0];
  const amount = "1000000";
  const tx = {
    chainId: 8453,
    to: usdc,
    value: "0",
    data: ERC20.encodeFunctionData("approve", [router, amount]),
  };
  assert.throws(() => enforceTxPolicy(tx, "sign"), /approval guard required/);
  const madApproval = createApprovalGuard({
    chainId: 8453,
    token: usdc,
    spender: router,
    amount,
    provider: "uniswap-v3",
    routeVenue: router,
  });
  assert.doesNotThrow(() => enforceTxPolicy({ ...tx, madApproval }, "sign"));
  assert.throws(
    () => enforceTxPolicy({ ...tx, data: ERC20.encodeFunctionData("approve", [SWAP_VENUES[8453][1], amount]), madApproval }, "sign"),
    /approval spender mismatch/
  );
  assert.throws(
    () => enforceTxPolicy({ ...tx, madApproval: { ...madApproval, expiresAtMs: 1 } }, "sign"),
    /approval guard expired/
  );
});

test("ERC20 approval revokes use the same vetted-spender guard and zero amount", () => {
  const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const router = SWAP_VENUES[8453][0];
  const tx = buildApprovalRevokeTransaction({ token: usdc, spender: router }, { chainId: 8453, provider: "lifi" });
  assert.equal(tx.to, usdc.toLowerCase());
  assert.equal(tx.madApproval.amount, "0");
  const decoded = ERC20.decodeFunctionData("approve", tx.data);
  assert.equal(decoded[0].toLowerCase(), router.toLowerCase());
  assert.equal(decoded[1].toString(), "0");
  assert.throws(() => enforceTxPolicy({ chainId: 8453, to: tx.to, value: "0", data: tx.data }, "sign"), /approval guard required/);
  assert.doesNotThrow(() => enforceTxPolicy({ ...tx, madApproval: tx.madApproval }, "sign"));
});

test("stale or over-cap metadata is refused at the signer boundary", () => {
  const to = SWAP_VENUES[8453][0];
  const good = guard(8453, to);
  // Re-sign the mutations: this test is about the BOUNDS check at the signer
  // boundary. Forgery (mutation without re-signing) is covered in
  // auto-slippage.test.mjs.
  assert.throws(
    () =>
      enforceTxPolicy(
        { chainId: 8453, to, data: swapCalldata(good.minAmountOut), madSlippage: signAutoSlippageGuard({ ...good, selectedBps: 101 }) },
        "sign"
      ),
    /100 bps/
  );
  assert.throws(
    () =>
      enforceTxPolicy(
        { chainId: 8453, to, data: swapCalldata(good.minAmountOut), madSlippage: signAutoSlippageGuard({ ...good, expiresAtMs: 1 }) },
        "sign"
      ),
    /expired/
  );
});

test("dynamic 0x targets require fresh route attestation bound to calldata and slippage", () => {
  const prev = process.env.MAD_ROUTE_ATTESTATION_SECRET;
  process.env.MAD_ROUTE_ATTESTATION_SECRET = "route-test-key";
  try {
    const chainId = 8453;
    const sender = "0x00000000000000000000000000000000000A1ce5";
    const to = "0x2222222222222222222222222222222222222222";
    const data = "0x12345678";
    // 0x returns opaque aggregator calldata, so its output floor is not
    // decodable by selector. That is exactly the case bindAutoSlippageGuardToCall
    // exists for: bind the guard to this exact calldata by hash. The route path
    // now enforces the same authenticated, call-bound guard as the signer
    // boundary, so an unbound guard here is correctly refused.
    const madSlippage = bindAutoSlippageGuardToCall(guard(chainId, to), { chainId, venue: to, data });
    const tx = { chainId, to, from: sender, value: "0", data, madSlippage };
    assert.throws(() => enforceTxPolicy(tx, "sign"), /destination .* not allowlisted/);
    const madRoute = createRouteAttestation({ provider: "zerox", chainId, sender, to, data, value: "0", slippageGuard: madSlippage });
    assert.doesNotThrow(() => enforceTxPolicy({ ...tx, madRoute }, "sign"));
    assert.throws(() => enforceTxPolicy({ ...tx, data: "0x12345679", madRoute }, "sign"), /route attestation calldata mismatch/);
    assert.throws(
      () => enforceTxPolicy({ ...tx, madRoute: { ...madRoute, expiresAtMs: 1 } }, "sign"),
      /route attestation expired/
    );
  } finally {
    if (prev == null) delete process.env.MAD_ROUTE_ATTESTATION_SECRET;
    else process.env.MAD_ROUTE_ATTESTATION_SECRET = prev;
  }
});

test("dynamic Morpho ERC4626 vault targets require fresh vault attestation bound to calldata and approval", () => {
  const prev = process.env.MAD_ROUTE_ATTESTATION_SECRET;
  process.env.MAD_ROUTE_ATTESTATION_SECRET = "vault-test-key";
  try {
    const chainId = 8453;
    const owner = "0x00000000000000000000000000000000000A1ce5";
    const vault = "0x4444444444444444444444444444444444444444";
    const asset = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const amount = "1000000";
    const vaultIface = new Interface(["function deposit(uint256 assets,address receiver) returns (uint256)"]);
    const data = vaultIface.encodeFunctionData("deposit", [amount, owner]);
    const tx = { chainId, to: vault, from: owner, value: "0", data };
    assert.throws(() => enforceTxPolicy(tx, "sign"), /destination .* not allowlisted/);
    const madVault = createVaultAttestation({ provider: "morpho", chainId, action: "deposit", vault, asset, owner, receiver: owner, amount, data });
    assert.doesNotThrow(() => enforceTxPolicy({ ...tx, madVault }, "sign"));
    assert.throws(() => enforceTxPolicy({ ...tx, data: "0x12345678", madVault }, "sign"), /vault attestation calldata mismatch/);
    assert.throws(() => enforceTxPolicy({ ...tx, madVault: { ...madVault, expiresAtMs: 1 } }, "sign"), /vault attestation expired/);

    const approveTx = {
      chainId,
      to: asset,
      value: "0",
      data: ERC20.encodeFunctionData("approve", [vault, amount]),
    };
    const madApproval = createApprovalGuard({ chainId, token: asset, spender: vault, amount, provider: "morpho", routeVenue: vault });
    assert.throws(() => enforceTxPolicy({ ...approveTx, madApproval }, "sign"), /vault attestation required/);
    assert.doesNotThrow(() => enforceTxPolicy({ ...approveTx, madApproval, madVault }, "sign"));
    const wrongAmount = createVaultAttestation({ provider: "morpho", chainId, action: "deposit", vault, asset, owner, receiver: owner, amount: "2", data });
    assert.throws(() => enforceTxPolicy({ ...approveTx, madApproval, madVault: wrongAmount }, "sign"), /vault attestation amount mismatch/);
  } finally {
    if (prev == null) delete process.env.MAD_ROUTE_ATTESTATION_SECRET;
    else process.env.MAD_ROUTE_ATTESTATION_SECRET = prev;
  }
});

test("GMX ExchangeRouter orders require fresh order attestation bound to multicall and approval", () => {
  const prev = process.env.MAD_ROUTE_ATTESTATION_SECRET;
  process.env.MAD_ROUTE_ATTESTATION_SECRET = "gmx-test-key";
  try {
    const chainId = 42161;
    const account = "0x00000000000000000000000000000000000A1ce5";
    const exchangeRouter = "0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41";
    const router = "0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6";
    const orderVault = "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5";
    const market = "0x47c031236e19d024b42f8AE6780E44A573170703";
    const collateral = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
    const amount = "1000000";
    const executionFee = "300000000000000";
    const data = "0x12345678";
    const tx = { chainId, to: exchangeRouter, from: account, value: executionFee, data };
    assert.throws(() => enforceTxPolicy(tx, "sign"), /gmx order attestation required/);
    const madGmx = createGmxOrderAttestation({
      provider: "gmx",
      chainId,
      account,
      exchangeRouter,
      router,
      orderVault,
      orderType: "marketIncrease",
      market,
      initialCollateralToken: collateral,
      initialCollateralDeltaAmount: amount,
      sizeDeltaUsd: "5000000000000000000000000000000000",
      executionFee,
      acceptablePrice: "65000000000000000000000000000000000",
      isLong: true,
      data,
      value: executionFee,
    });
    assert.doesNotThrow(() => enforceTxPolicy({ ...tx, madGmx }, "sign"));
    assert.throws(() => enforceTxPolicy({ ...tx, data: "0x12345679", madGmx }, "sign"), /gmx attestation calldata mismatch/);
    assert.throws(() => enforceTxPolicy({ ...tx, value: "1", madGmx }, "sign"), /gmx attestation value mismatch/);

    const approveTx = {
      chainId,
      to: collateral,
      value: "0",
      data: ERC20.encodeFunctionData("approve", [router, amount]),
    };
    const madApproval = createApprovalGuard({ chainId, token: collateral, spender: router, amount, provider: "gmx", routeVenue: exchangeRouter });
    assert.throws(() => enforceTxPolicy({ ...approveTx, madApproval }, "sign"), /gmx order attestation required/);
    assert.doesNotThrow(() => enforceTxPolicy({ ...approveTx, madApproval, madGmx }, "sign"));
  } finally {
    if (prev == null) delete process.env.MAD_ROUTE_ATTESTATION_SECRET;
    else process.env.MAD_ROUTE_ATTESTATION_SECRET = prev;
  }
});
