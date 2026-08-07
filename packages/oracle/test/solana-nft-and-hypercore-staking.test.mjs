// Solana NFT (Magic Eden) + HyperCore staking lanes: offline unit tests.
//
// Proves the guard posture without network: prepare paths never claim signing or
// broadcast readiness, caps are enforced, unit math is exact, and the keyed
// instruction builders refuse to run without an API key.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  magicEdenSolStats,
  magicEdenSolListings,
  magicEdenSolPrepareBuy,
  magicEdenSolPrepareList,
  magicEdenSolPrepareMint,
  LAMPORTS_PER_SOL,
} from "../src/data/providers/magiceden-sol.mjs";

import {
  hlPrepareStakeDeposit,
  hlPrepareStakeWithdraw,
  hlPrepareDelegate,
  hlStakingSubmitShape,
  hypeToWei,
  weiToHype,
  HL_UNSTAKING_QUEUE_DAYS,
} from "../src/data/providers/hl-staking.mjs";

const VALIDATOR = "0x0000000000000000000000000000000000000abc";
// Public, well-known mint addresses used purely as valid base58 pubkey fixtures.
const PUBKEY = "So11111111111111111111111111111111111111112";
const PUBKEY_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function stubFetch(payload, { status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  });
}

// ------------------------------------------------------------ magic eden

test("magiceden stats normalizes lamports to SOL without touching keys", async () => {
  const out = await magicEdenSolStats(
    { symbol: "mad_lads" },
    { fetchImpl: stubFetch({ floorPrice: 7_387_000_000, listedCount: 244, volume24hr: 1_000_000_000 }) }
  );
  assert.equal(out.floorPriceLamports, 7_387_000_000);
  assert.equal(out.floorPriceSol, 7.387);
  assert.equal(out.listedCount, 244);
  assert.equal(out.exec, false);
});

test("magiceden listings normalize mint/seller/auctionHouse and price", async () => {
  const out = await magicEdenSolListings(
    { symbol: "mad_lads", limit: 1 },
    {
      fetchImpl: stubFetch([
        {
          tokenMint: PUBKEY,
          tokenAddress: PUBKEY_B,
          seller: PUBKEY_B,
          auctionHouse: PUBKEY,
          price: 2.5,
          tokenSize: 1,
        },
      ]),
    }
  );
  assert.equal(out.count, 1);
  assert.equal(out.listings[0].priceSol, 2.5);
  assert.equal(out.listings[0].priceLamports, 2.5 * LAMPORTS_PER_SOL);
  assert.equal(out.exec, false);
});

test("magiceden symbol argument rejects path traversal and junk", async () => {
  await assert.rejects(() => magicEdenSolStats({ symbol: "../../etc/passwd" }, { fetchImpl: stubFetch({}) }), /symbol/);
  await assert.rejects(() => magicEdenSolStats({ symbol: "" }, { fetchImpl: stubFetch({}) }), /symbol/);
});

test("magiceden buy/list/mint refuse to build without an API key", async () => {
  const args = { buyer: PUBKEY, seller: PUBKEY_B, auctionHouse: PUBKEY, tokenMint: PUBKEY, tokenATA: PUBKEY_B, priceSol: 1 };
  const noKey = { apiKey: "", fetchImpl: stubFetch({}) };
  await assert.rejects(() => magicEdenSolPrepareBuy(args, noKey), /MAGICEDEN_API_KEY/);
  await assert.rejects(() => magicEdenSolPrepareList({ ...args, seller: PUBKEY }, noKey), /MAGICEDEN_API_KEY/);
  await assert.rejects(() => magicEdenSolPrepareMint({ buyer: PUBKEY, symbol: "some_drop" }, noKey), /MAGICEDEN_API_KEY/);
});

test("magiceden buy enforces the maxPriceSol cap before building anything", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, status: 200, text: async () => "{}" };
  };
  await assert.rejects(
    () =>
      magicEdenSolPrepareBuy(
        { buyer: PUBKEY, seller: PUBKEY_B, auctionHouse: PUBKEY, tokenMint: PUBKEY, tokenATA: PUBKEY_B, priceSol: 9, maxPriceSol: 2 },
        { apiKey: "test-key", fetchImpl }
      ),
    /exceeds maxPriceSol cap/
  );
  assert.equal(called, false, "cap must be checked before any network call");
});

test("magiceden prepared buy never claims signing or broadcast readiness", async () => {
  const txBytes = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = await magicEdenSolPrepareBuy(
    { buyer: PUBKEY, seller: PUBKEY_B, auctionHouse: PUBKEY, tokenMint: PUBKEY, tokenATA: PUBKEY_B, priceSol: 1, maxPriceSol: 5 },
    { apiKey: "test-key", fetchImpl: stubFetch({ v0: { tx: { data: txBytes } } }) }
  );
  assert.equal(out.prepareReady, true);
  assert.equal(out.executionReady, false);
  assert.equal(out.signingReady, false);
  assert.equal(out.broadcastReady, false);
  assert.equal(out.requiresUserSignature, true);
  assert.equal(out.transactionEncoding, "base64");
  assert.equal(out.lamports, LAMPORTS_PER_SOL);
});

// ------------------------------------------------------- hypercore staking

test("HYPE unit math is exact at 8 decimals and rejects overflow precision", () => {
  assert.equal(hypeToWei("1"), "100000000");
  assert.equal(hypeToWei("1.5"), "150000000");
  assert.equal(hypeToWei("0.00000001"), "1");
  assert.equal(weiToHype("150000000"), "1.5");
  assert.equal(weiToHype("100000000"), "1");
  assert.throws(() => hypeToWei("1.123456789"), /decimals/);
  assert.throws(() => hypeToWei("0"), /greater than zero/);
  assert.throws(() => hypeToWei("-1"), /positive decimal/);
  assert.throws(() => hypeToWei("abc"), /positive decimal/);
});

test("stake deposit prepares cDeposit typed data, never signs", () => {
  const p = hlPrepareStakeDeposit({ amountHype: "2.5", maxHype: "10", nonce: 1_700_000_000_000 });
  assert.equal(p.kind, "hype-stake-deposit");
  assert.equal(p.action.type, "cDeposit");
  assert.equal(p.action.wei, 250_000_000);
  assert.equal(p.typedData.primaryType, "HyperliquidTransaction:CDeposit");
  assert.equal(p.prepareReady, true);
  assert.equal(p.signingReady, false);
  assert.equal(p.broadcastReady, false);
  assert.equal(p.executionReady, false);
  assert.equal(p.requiresUserSignature, true);
});

test("stake deposit enforces maxHype cap", () => {
  assert.throws(() => hlPrepareStakeDeposit({ amountHype: "50", maxHype: "10" }), /exceeds maxHype cap/);
});

test("unstake prepares cWithdraw and warns about the unstaking queue", () => {
  const p = hlPrepareStakeWithdraw({ amountHype: "1" });
  assert.equal(p.action.type, "cWithdraw");
  assert.equal(p.kind, "hype-stake-withdraw");
  assert.ok(p.notes.join(" ").includes(`${HL_UNSTAKING_QUEUE_DAYS} day`), "must warn about the unstaking queue");
  assert.equal(p.broadcastReady, false);
});

test("delegate and undelegate share tokenDelegate but flip isUndelegate", () => {
  const stake = hlPrepareDelegate({ validator: VALIDATOR, amountHype: "1", isUndelegate: false });
  const unstake = hlPrepareDelegate({ validator: VALIDATOR, amountHype: "1", isUndelegate: true });
  assert.equal(stake.action.type, "tokenDelegate");
  assert.equal(stake.action.isUndelegate, false);
  assert.equal(stake.kind, "hype-delegate");
  assert.equal(unstake.action.isUndelegate, true);
  assert.equal(unstake.kind, "hype-undelegate");
  assert.equal(stake.typedData.primaryType, "HyperliquidTransaction:TokenDelegate");
  for (const p of [stake, unstake]) {
    assert.equal(p.signingReady, false);
    assert.equal(p.broadcastReady, false);
  }
});

test("delegate rejects a malformed validator address", () => {
  assert.throws(() => hlPrepareDelegate({ validator: "nope", amountHype: "1" }), /validator/);
  assert.throws(() => hlPrepareDelegate({ validator: "0x1234", amountHype: "1" }), /validator/);
});

test("staking module exposes the submit shape but no submit function", async () => {
  const shape = hlStakingSubmitShape();
  assert.equal(shape.method, "POST");
  assert.ok(String(shape.url).includes("/exchange"));
  assert.ok(/does not submit/i.test(shape.note));
  const mod = await import("../src/data/providers/hl-staking.mjs");
  const allowed = new Set(["hlStakingSubmitShape", "HL_SIGNATURE_CHAIN_ID"]);
  for (const name of Object.keys(mod)) {
    if (allowed.has(name)) continue;
    assert.equal(/submit|broadcast|send|sign/i.test(name), false, `hl-staking must not export ${name}`);
  }
});

test("staking prepares carry no private key, mnemonic, or bearer material", () => {
  const blobs = [
    JSON.stringify(hlPrepareStakeDeposit({ amountHype: "1" })),
    JSON.stringify(hlPrepareStakeWithdraw({ amountHype: "1" })),
    JSON.stringify(hlPrepareDelegate({ validator: VALIDATOR, amountHype: "1" })),
  ];
  for (const blob of blobs) {
    assert.equal(/0x[0-9a-fA-F]{64}/.test(blob), false, "no raw 32-byte key shape");
    assert.equal(/mnemonic|privateKey|seed phrase|Bearer /i.test(blob), false, "no secret-ish material");
  }
});
