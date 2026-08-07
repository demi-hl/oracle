// Golden master for portfolio pricing.
//
// WHY THIS EXISTS
//
// A spoofed ERC-20 named "BTC" was priced at real bitcoin and inflated a test
// wallet's total to $6,113,512,407,825 against an actual $710,490. The full
// suite passed the entire time, because no test asserted on a total. Type
// checks, lint, and unit tests cannot catch a number that is merely wrong.
//
// So: a frozen fixture drawn from a real wallet, including the actual spoofed
// contracts, with a pinned expected total. Any change that moves the total by
// orders of magnitude fails here.
//
// Fixture rows carry real mainnet contract addresses. Prices are injected, so
// this test performs no network I/O and is fully deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  priceKeyForRow,
  valueRows,
  flagImplausible,
  knownValue,
  concentration,
  cappedRows,
  prunedRows,
  IMPLAUSIBLE_ROW_USD,
} from "../app/api/oracle/portfolio/pricingLogic.mjs";

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
// Real contracts from the failing wallet. Each calls itself "BTC" and is not.
const FAKE_BTC_A = "0xc285f60fd04f132fdf0e2e0b5cbbd7d6e1b8b7f9";
const FAKE_BTC_B = "0x08567b6ccae89bce30f6b0b1b1b5c9d2e8e4c111";

function row(overrides) {
  return {
    id: "row",
    chainId: "ethereum",
    chainNumericId: 1,
    kind: "erc20",
    symbol: null,
    amount: null,
    decimals: 18,
    valueUsd: null,
    priced: false,
    address: null,
    collection: null,
    ...overrides,
  };
}

/** The wallet that produced the $6.1T reading. */
const FIXTURE = [
  row({ id: "eth-native", kind: "native", symbol: "ETH", amount: "6650000000000000000", decimals: 18, address: null }),
  row({ id: "weth", symbol: "WETH", amount: "16330000000000000", decimals: 18, address: WETH }),
  row({ id: "usdc", symbol: "USDC", amount: "158021811", decimals: 6, address: USDC }),
  // The attack: tokens claiming a symbol they do not own.
  row({ id: "fake-btc-a", symbol: "BTC", amount: "20000000000000000000", decimals: 18, address: FAKE_BTC_A }),
  row({ id: "fake-btc-b", symbol: "BTC", amount: "19000000000000000000", decimals: 18, address: FAKE_BTC_B }),
];

const PRICES = new Map([
  ["coingecko:ethereum", 1860],
  [`ethereum:${WETH}`, 1865],
  [`ethereum:${USDC}`, 1.0],
  ["coingecko:bitcoin", 64_800],
  // Deliberately absent: neither fake BTC has a by-address quote.
]);

function priceFixture(rows) {
  const valued = valueRows(rows, PRICES);
  const { rows: flagged, suspectCount } = flagImplausible(valued);
  return { rows: flagged, suspectCount, total: Number(knownValue(flagged)) };
}

test("a spoofed symbol is never priced as the asset it impersonates", () => {
  for (const id of ["fake-btc-a", "fake-btc-b"]) {
    const fake = FIXTURE.find((entry) => entry.id === id);
    const key = priceKeyForRow(fake);
    assert.notEqual(key, "coingecko:bitcoin", `${id} must not resolve to the bitcoin price key`);
    assert.match(key, /^ethereum:0x/, `${id} must price by contract address`);
  }
});

test("only assets a third party cannot mint may be priced by symbol", () => {
  assert.equal(priceKeyForRow(row({ kind: "btc-utxo", chainId: "bitcoin", chainNumericId: null })), "coingecko:bitcoin");
  assert.equal(priceKeyForRow(row({ kind: "native", chainNumericId: 1 })), "coingecko:ethereum");
  // An ERC-20 claiming to be the native coin still prices by address.
  assert.equal(
    priceKeyForRow(row({ kind: "erc20", symbol: "ETH", chainNumericId: 1, address: WETH })),
    `ethereum:${WETH}`,
  );
});

test("GOLDEN MASTER: the fixture wallet totals a plausible value", () => {
  const { total, rows } = priceFixture(FIXTURE);

  // ETH 6.65 * 1860 = 12,369.00
  // WETH 0.01633 * 1865 = 30.46
  // USDC 158.021811 * 1.00 = 158.02
  const expected = 12_369 + 30.46 + 158.02;
  assert.ok(
    Math.abs(total - expected) < 1,
    `expected ~$${expected.toFixed(2)}, got $${total.toFixed(2)}`,
  );

  // The specific historical failure, pinned.
  assert.ok(total < 1_000_000, `total must not reach the spoofed-price regime, got $${total}`);

  const unpriced = rows.filter((entry) => !entry.priced).map((entry) => entry.id);
  assert.deepEqual(unpriced.sort(), ["fake-btc-a", "fake-btc-b"]);
});

test("an implausible row is excluded from the total, not summed into it", () => {
  const poisoned = [
    ...FIXTURE,
    // Spoofed decimals: a real contract, an absurd implied balance.
    row({ id: "decimals-attack", symbol: "USDC", amount: "1000000000000000000000000000000", decimals: 6, address: USDC }),
  ];
  const { total, suspectCount, rows } = priceFixture(poisoned);

  assert.equal(suspectCount, 1, "the absurd row must be flagged");
  assert.ok(total < 1_000_000, `total must exclude the flagged row, got $${total}`);

  const suspect = rows.find((entry) => entry.id === "decimals-attack");
  assert.equal(suspect.suspect, true);
  assert.ok(Number(suspect.valueUsd) > IMPLAUSIBLE_ROW_USD, "the row keeps its computed value for display");
});

test("concentration is disclosed but never silently drops a real position", () => {
  const whale = [
    row({ id: "eth-native", kind: "native", symbol: "ETH", amount: "1000000000000000000000", decimals: 18 }),
    row({ id: "usdc", symbol: "USDC", amount: "1000000", decimals: 6, address: USDC }),
  ];
  const { rows, total } = priceFixture(whale);
  const shape = concentration(rows);

  assert.ok(shape.concentrated, "a total resting on one position must be flagged as concentrated");
  assert.ok(shape.ratio > 0.99);
  // Flagged, still counted: concentration is a shape, not an error.
  assert.ok(total > 1_860_000, `the dominant position stays in the total, got $${total}`);
});

test("pruning and capping never change the total", () => {
  const noisy = [
    ...FIXTURE,
    ...Array.from({ length: 200 }, (_, index) =>
      row({ id: `dust-${index}`, symbol: "SPAM", amount: "0", decimals: 18, address: `0x${String(index).padStart(40, "0")}` }),
    ),
  ];

  const before = priceFixture(noisy).total;
  const pruned = prunedRows(noisy);
  const after = priceFixture(pruned.rows).total;

  assert.equal(after, before, "pruning zero-value rows must not move the total");
  assert.ok(pruned.dropped >= 200, "dust must actually be dropped");

  const capped = cappedRows(priceFixture(pruned.rows).rows, 3);
  assert.equal(capped.rows.length, 3, "the cap must bound rows per chain");
  assert.ok(
    Math.abs(Number(knownValue(capped.rows)) - before) < 1,
    "capping keeps the most valuable rows, so the visible total is preserved",
  );
});
