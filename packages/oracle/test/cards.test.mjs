// Telegram card renderer tests.
//
// These cards are what a non-technical user actually reads before deciding to
// touch money. The failure modes that matter are silent ones: a blank field
// that looks like zero, a truncated address that looks like an address, an
// unescaped underscore that eats half the message, or a whole card lost because
// an image failed to render. Each of those has a test here.

import test from "node:test";
import assert from "node:assert/strict";
import {
  UNKNOWN,
  CARD_KINDS,
  escapeMd,
  formatUnits,
  normalizeConfidence,
  cardActions,
  renderCard,
  safeRenderCard,
  renderTokenCard,
  renderLaunchCard,
  renderHip3Card,
  renderHip4Card,
  renderPolymarketCard,
} from "../src/cards.mjs";

// Verified live on Robinhood chain 4663.
const CASHCAT = {
  symbol: "CASHCAT",
  name: "CashCat",
  address: "0x020bfC650A365f8BB26819deAAbF3E21291018b4",
  chainId: 4663,
  venue: "uniswap-v3",
  liquidityUsd: 3365568.41,
  feeTier: 10000,
  quote: { amountOutRaw: "24325001237995579150138", decimals: 18, symbol: "CASHCAT" },
  autoSlippage: { selectedBps: 30, capBps: 100 },
  confidence: "high",
};

const ALL_RENDERERS = [renderTokenCard, renderLaunchCard, renderHip3Card, renderHip4Card, renderPolymarketCard];

test("every renderer emits a string for a fully populated payload", () => {
  const out = renderTokenCard(CASHCAT);
  assert.equal(typeof out, "string");
  assert.match(out, /CASHCAT/);
  assert.match(out, /Robinhood Chain \(chainId 4663\)/);
  assert.match(out, /3,365,568\.41 USD/);
});

test("missing fields render the literal UNKNOWN, never blank and never guessed", () => {
  for (const render of ALL_RENDERERS) {
    const out = render({});
    assert.equal(typeof out, "string");
    assert.ok(out.includes(UNKNOWN), `${render.name} should surface UNKNOWN`);
    // No field may be left dangling with an empty value.
    for (const line of out.split("\n").slice(1)) {
      assert.doesNotMatch(line, /: *$/, `${render.name} left an empty field: ${line}`);
    }
  }
});

test("null, undefined, empty string and NaN all collapse to UNKNOWN", () => {
  const out = renderTokenCard({
    symbol: "",
    name: null,
    address: undefined,
    priceUsd: Number.NaN,
    liquidityUsd: "",
    confidence: "not-a-band",
  });
  assert.match(out, /Address: UNKNOWN/);
  assert.match(out, /Price: UNKNOWN/);
  assert.match(out, /Liquidity: UNKNOWN/);
  assert.match(out, /Confidence: UNKNOWN/);
});

test("every card states chain or venue and confidence", () => {
  const cards = [
    renderTokenCard(CASHCAT),
    renderLaunchCard(CASHCAT),
    renderHip3Card({ dex: "test", confidence: 0.9 }),
    renderHip4Card({ event: "test", confidence: 0.5 }),
    renderPolymarketCard({ event: "test", confidence: 0.1 }),
  ];
  for (const card of cards) {
    assert.match(card, /^(.*\n)?(Chain|Venue): .+$/m, `card must state chain/venue:\n${card}`);
    assert.match(card, /^Confidence: (HIGH|MEDIUM|LOW|UNKNOWN)$/m, `card must state confidence:\n${card}`);
  }
});

test("the contract address is never truncated — a half address is worse than none", () => {
  const out = renderTokenCard(CASHCAT);
  assert.ok(out.includes(CASHCAT.address), "full address must appear verbatim");
  assert.doesNotMatch(out, /0x020bfC65\u2026|0x020bfC65\.\.\./, "address must not be ellipsised");

  // Same rule for launch cards and for long Solana-style mints.
  const mint = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
  const launch = renderLaunchCard({ mint, chainId: 4663 });
  assert.ok(launch.includes(mint), "full mint must appear verbatim");
});

test("underscores in labels and values are escaped for Telegram markdown", () => {
  const out = renderTokenCard({ ...CASHCAT, symbol: "CASH_CAT", venue: "uniswap_v3_pool" });
  assert.ok(out.includes("CASH\\_CAT"), "symbol underscore must be escaped");
  assert.ok(out.includes("uniswap\\_v3\\_pool"), "venue underscores must be escaped");
  // Nothing may be left as a bare underscore that Telegram would read as italics.
  assert.doesNotMatch(out.replace(/\\_/g, ""), /_/, "no unescaped underscore may survive");
});

test("escapeMd covers the legacy markdown control set and handles empties", () => {
  assert.equal(escapeMd("a_b*c[d]e`f"), "a\\_b\\*c\\[d\\]e\\`f");
  assert.equal(escapeMd(null), UNKNOWN);
  assert.equal(escapeMd(undefined), UNKNOWN);
  assert.equal(escapeMd("   "), UNKNOWN);
  assert.equal(escapeMd(0), "0");
});

test("cards never emit dollar signs — repeated $ spans break Telegram parsing", () => {
  const cards = [
    renderTokenCard(CASHCAT),
    renderLaunchCard(CASHCAT),
    renderPolymarketCard({ event: "e", yesPrice: 0.61, noPrice: 0.39, volumeUsd: 12345 }),
  ];
  for (const card of cards) assert.doesNotMatch(card, /\$/, `card must not contain a $ span:\n${card}`);
});

test("a card renders in full when optional chart data is absent", () => {
  const out = renderTokenCard(CASHCAT);
  assert.match(out, /Chart: NONE \(text card only\)/);
  assert.ok(out.includes(CASHCAT.address), "text card still carries the identifier");
});

test("chart rendering soft-fails: the text card still returns when the image fails", () => {
  const failed = renderTokenCard({ ...CASHCAT, chart: { error: "renderer timeout", ok: false } });
  assert.match(failed, /Chart: UNAVAILABLE — renderer timeout \(text card stands\)/);
  assert.match(failed, /3,365,568\.41 USD/, "card body survives a failed chart");

  const ok = renderTokenCard({ ...CASHCAT, chart: { url: "https://example.test/c.png" } });
  assert.match(ok, /Chart: `https:\/\/example\.test\/c\.png`/);
});

test("no buy/sell actions without a valid local grant or session", () => {
  assert.match(renderTokenCard(CASHCAT), /Actions: prepare-only — no local grant\/session/);

  const expired = renderTokenCard({ ...CASHCAT, grant: { expiresAt: 1 } });
  assert.match(expired, /Actions: prepare-only — grant expired/);

  const remote = renderTokenCard({ ...CASHCAT, grant: { local: false, expiresAt: Date.now() + 60_000 } });
  assert.match(remote, /Actions: prepare-only — grant is not local/);

  const revoked = cardActions({ grant: { revoked: true } });
  assert.deepEqual(revoked, { allowed: false, reason: "grant revoked", actions: [] });
});

test("a valid local grant enables actions", () => {
  const out = renderTokenCard({ ...CASHCAT, grant: { local: true, expiresAt: Date.now() + 60_000 } });
  assert.match(out, /Actions: BUY \/ SELL \(valid local grant\)/);

  const scoped = cardActions({ grant: { actions: ["SELL"], expiresAt: Date.now() + 1000 } });
  assert.deepEqual(scoped.actions, ["SELL"]);
  assert.equal(scoped.allowed, true);
});

test("raw quote amounts keep exact precision through BigInt formatting", () => {
  assert.equal(formatUnits("24325001237995579150138", 18), "24325.001237995579150138");
  assert.equal(formatUnits("1000000", 6), "1");
  assert.equal(formatUnits(0n, 18), "0");
  assert.equal(formatUnits("-1500", 3), "-1.5");
  assert.equal(formatUnits("not-a-number", 18), UNKNOWN);
  assert.equal(formatUnits("100", undefined), UNKNOWN);

  const out = renderTokenCard(CASHCAT);
  assert.ok(out.includes("24325001237995579150138"), "raw amount stays verifiable");
  assert.ok(out.includes("24325.001237995579150138"), "human amount is exact, not float-rounded");
});

test("auto-slippage is shown as selected plus cap", () => {
  assert.match(renderTokenCard(CASHCAT), /Auto-slippage: 30 bps selected, cap 100 bps/);
  assert.match(renderTokenCard({ ...CASHCAT, autoSlippage: undefined }), /Auto-slippage: UNKNOWN/);
});

test("confidence normalizes from numbers and strings, else UNKNOWN", () => {
  assert.equal(normalizeConfidence(0.9), "HIGH");
  assert.equal(normalizeConfidence(0.5), "MEDIUM");
  assert.equal(normalizeConfidence(0.1), "LOW");
  assert.equal(normalizeConfidence("high"), "HIGH");
  assert.equal(normalizeConfidence(2), UNKNOWN);
  assert.equal(normalizeConfidence("probably"), UNKNOWN);
  assert.equal(normalizeConfidence(undefined), UNKNOWN);
});

test("an unknown chainId still renders without inventing a chain name", () => {
  const out = renderTokenCard({ ...CASHCAT, chainId: 999999, chain: undefined });
  assert.match(out, /Chain: UNKNOWN \(chainId 999999\)/);
});

test("hip3, hip4 and polymarket cards name their venue explicitly", () => {
  assert.match(renderHip3Card({ dex: "flex", market: "BTC" }), /Venue: Hyperliquid builder-dex flex/);
  assert.match(renderHip4Card({ event: "election" }), /Venue: Hyperliquid HIP-4 outcome/);
  assert.match(renderPolymarketCard({ event: "election" }), /Venue: Polymarket CLOB/);
});

test("renderCard dispatches every declared surface and rejects unknown kinds", () => {
  for (const kind of CARD_KINDS) assert.equal(typeof renderCard(kind, {}), "string");
  assert.throws(() => renderCard("nope", {}), /unknown card kind/);
});

test("safeRenderCard degrades instead of dropping the alert", () => {
  const out = safeRenderCard("nope", {});
  assert.match(out, /DEGRADED/);
  assert.match(out, /Confidence: UNKNOWN/);
  assert.equal(typeof out, "string");
});

test("renderers are pure: input objects are not mutated", () => {
  const input = structuredClone(CASHCAT);
  renderTokenCard(input);
  renderLaunchCard(input);
  assert.deepEqual(input, CASHCAT);
});

test("warnings and provenance surface when supplied", () => {
  const out = renderTokenCard({
    ...CASHCAT,
    warnings: ["stale quote", "sparse candles"],
    source: "uniswap-v3",
    fetchedAt: "2026-07-31T00:00:00Z",
  });
  assert.match(out, /Warnings: stale quote; sparse candles/);
  assert.match(out, /Source: uniswap-v3 at 2026-07-31T00:00:00Z/);
});
