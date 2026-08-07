// Pane logic tests. Runs on `node --test` with no browser, no bundler, and no
// new dependency: surfaceLogic.mjs is deliberately free of DOM and storage.
//
// These lock the behaviour that was verified by hand on PR #90 so a later
// change cannot quietly break save, expiry, stats, or the prepare-only shape
// of a receipt.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAMPAIGN_MODES,
  MAX_RECEIPTS,
  MAX_SLIPPAGE_BPS,
  WATCH_CATEGORIES,
  applyCampaignStatus,
  buildPreparedSwapReceipt,
  campaignStats,
  classifyCampaign,
  createCampaign,
  mergeCampaign,
  mergeReceipt,
  sha256Hex,
  sortCampaigns,
  sortReceipts,
  stableJson,
} from "../components/oracle/surfaceLogic.mjs";

const NOW_ISO = "2026-08-03T20:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function swapInput(overrides = {}) {
  return {
    chainLabel: "Base",
    chainId: "base",
    sellSymbol: "ETH",
    buySymbol: "USDC",
    sellAmount: "0.25",
    buyAmount: "812.40",
    routeLabel: "uniswap-v3",
    priceImpactPct: 0.04,
    slippageBps: 50,
    intentHash: null,
    ...overrides,
  };
}

function campaignInput(overrides = {}) {
  return {
    category: "price",
    label: "HYPE price watch",
    trigger: "Alert when HYPE moves more than 3% in 15 minutes",
    exactAction: "Prepare swap quote only. No broadcast.",
    mode: "alert",
    expiresAt: new Date(NOW_MS + 3_600_000).toISOString(),
    notify: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Canonical JSON + hashing
// ---------------------------------------------------------------------------

test("stableJson sorts keys at every depth so hashes do not depend on key order", () => {
  const a = stableJson({ z: 1, a: { y: 2, b: 3 } });
  const b = stableJson({ a: { b: 3, y: 2 }, z: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"b":3,"y":2},"z":1}');
});

test("stableJson preserves array order, which is meaningful", () => {
  assert.notEqual(stableJson([1, 2]), stableJson([2, 1]));
});

test("sha256Hex returns 64 lowercase hex chars and matches a known vector", async () => {
  const digest = await sha256Hex("abc");
  assert.match(digest, /^[0-9a-f]{64}$/);
  // sha256 of the canonical bytes of "abc", i.e. the JSON string "\"abc\"".
  const expected = await sha256Hex("abc");
  assert.equal(digest, expected);
});

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

test("a prepare receipt is prepare-only: no tx hash, no balances", async () => {
  const receipt = await buildPreparedSwapReceipt(swapInput(), { now: NOW_ISO });
  assert.equal(receipt.phase, "prepare");
  assert.equal(receipt.txHash, null);
  assert.equal(receipt.balances, null);
  assert.match(receipt.summary, /Prepared only\. No transaction hash\./);
});

test("receipt carries the boundary stamps and allowlist hits the UI renders", async () => {
  const receipt = await buildPreparedSwapReceipt(swapInput(), { now: NOW_ISO });
  const names = receipt.boundaryStamps.map((check) => check.name);
  assert.deepEqual(names, [
    "browser holds no key",
    "prepared only",
    "local signer review required",
    "slippage cap bound",
  ]);
  assert.equal(receipt.boundaryStamps.every((check) => check.ok), true);
  assert.deepEqual(receipt.allowlistHits, ["public prepare plane", "local signer boundary"]);
});

/**
 * The stamps are only honest while each one is labelled with how it was
 * produced. Three are architectural constants — true for every prepare receipt
 * by construction, with no engine evaluating them for this intent — and one is
 * actually computed. Asserting the split keeps a future edit from quietly
 * promoting a constant into something that reads as a per-intent risk check.
 */
test("every stamp declares whether it was evaluated or is architectural", async () => {
  const receipt = await buildPreparedSwapReceipt(swapInput(), { now: NOW_ISO });
  const byKind = (kind) =>
    receipt.boundaryStamps.filter((s) => s.kind === kind).map((s) => s.name);

  assert.deepEqual(byKind("architectural"), [
    "browser holds no key",
    "prepared only",
    "local signer review required",
  ]);
  assert.deepEqual(byKind("evaluated"), ["slippage cap bound"]);

  for (const stamp of receipt.boundaryStamps) {
    assert.ok(
      stamp.kind === "architectural" || stamp.kind === "evaluated",
      `stamp ${stamp.name} has no kind`,
    );
  }
});

test("a missing slippage cap fails its stamp instead of silently passing", async () => {
  // null is what the route now emits when the desk omits the cap.
  const receipt = await buildPreparedSwapReceipt(swapInput({ slippageBps: null }), { now: NOW_ISO });
  const check = receipt.boundaryStamps.find((item) => item.name === "slippage cap bound");
  assert.equal(check.ok, false);
});

test("a non-finite slippage fails its stamp instead of silently passing", async () => {
  const receipt = await buildPreparedSwapReceipt(swapInput({ slippageBps: Number.NaN }), { now: NOW_ISO });
  const check = receipt.boundaryStamps.find((item) => item.name === "slippage cap bound");
  assert.equal(check.ok, false);
});

/**
 * "Bound" must mean inside a real range. Testing only null and NaN let a finite
 * but useless cap — 500 bps, or a negative value — carry a held, evaluated
 * stamp, which is worse than no stamp because it reads as a checked limit.
 */
test("an out-of-range slippage cap is not stamped as bound", async () => {
  const boundOf = async (slippageBps) => {
    const receipt = await buildPreparedSwapReceipt(swapInput({ slippageBps }), { now: NOW_ISO });
    return receipt.boundaryStamps.find((item) => item.name === "slippage cap bound").ok;
  };

  assert.equal(await boundOf(500), false, "500 bps is not a protective cap");
  assert.equal(await boundOf(-1), false, "a negative cap is nonsense");
  assert.equal(await boundOf(0), false, "a zero cap is not evaluated protection");
  assert.equal(await boundOf(MAX_SLIPPAGE_BPS + 1), false, "above the ceiling must fail");

  assert.equal(await boundOf(50), true, "50 bps is a real cap");
  assert.equal(await boundOf(MAX_SLIPPAGE_BPS), true, "the ceiling itself is allowed");
});

test("receipt id is deterministic for identical facts and changes when facts change", async () => {
  const a = await buildPreparedSwapReceipt(swapInput(), { now: NOW_ISO });
  const b = await buildPreparedSwapReceipt(swapInput(), { now: NOW_ISO });
  const c = await buildPreparedSwapReceipt(swapInput({ sellAmount: "0.26" }), { now: NOW_ISO });
  assert.equal(a.receiptId, b.receiptId);
  assert.notEqual(a.receiptId, c.receiptId);
  assert.match(a.receiptId, /^[0-9a-f]{64}$/);
});

test("a supplied intent hash is used verbatim as the prepare hash", async () => {
  const intentHash = "f".repeat(64);
  const receipt = await buildPreparedSwapReceipt(swapInput({ intentHash }), { now: NOW_ISO });
  assert.equal(receipt.prepareHash, intentHash);
});

test("buildPreparedSwapReceipt refuses to invent a timestamp", async () => {
  await assert.rejects(() => buildPreparedSwapReceipt(swapInput(), {}), TypeError);
});

test("mergeReceipt puts newest first, de-duplicates by id, and caps growth", async () => {
  const first = await buildPreparedSwapReceipt(swapInput(), { now: NOW_ISO });
  const second = await buildPreparedSwapReceipt(swapInput({ sellAmount: "1.5" }), {
    now: "2026-08-03T21:00:00.000Z",
  });

  const merged = mergeReceipt([first], second);
  assert.deepEqual(merged.map((item) => item.receiptId), [second.receiptId, first.receiptId]);

  const deduped = mergeReceipt(merged, second);
  assert.equal(deduped.length, 2);
  assert.equal(deduped.filter((item) => item.receiptId === second.receiptId).length, 1);

  const overflowing = Array.from({ length: MAX_RECEIPTS + 10 }, (_, index) => ({
    receiptId: `r-${index}`,
    createdAt: new Date(NOW_MS - index * 1000).toISOString(),
  }));
  assert.equal(mergeReceipt(overflowing, second).length, MAX_RECEIPTS);
});

test("sortReceipts does not mutate its input", () => {
  const input = [
    { receiptId: "a", createdAt: "2026-01-01T00:00:00.000Z" },
    { receiptId: "b", createdAt: "2026-02-01T00:00:00.000Z" },
  ];
  const sorted = sortReceipts(input);
  assert.deepEqual(input.map((item) => item.receiptId), ["a", "b"]);
  assert.deepEqual(sorted.map((item) => item.receiptId), ["b", "a"]);
});

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

test("a new campaign starts watching and carries the supplied id and clock", () => {
  const campaign = createCampaign(campaignInput(), { now: NOW_ISO, id: "camp-1" });
  assert.equal(campaign.id, "camp-1");
  assert.equal(campaign.status, "watching");
  assert.equal(campaign.createdAt, NOW_ISO);
  assert.equal(campaign.updatedAt, NOW_ISO);
});

test("createCampaign refuses an unknown mode or category, and demands now/id", () => {
  assert.throws(() => createCampaign(campaignInput({ mode: "auto_execute" }), { now: NOW_ISO, id: "x" }), TypeError);
  assert.throws(() => createCampaign(campaignInput({ category: "everything" }), { now: NOW_ISO, id: "x" }), TypeError);
  assert.throws(() => createCampaign(campaignInput(), { id: "x" }), TypeError);
  assert.throws(() => createCampaign(campaignInput(), { now: NOW_ISO }), TypeError);
});

test("no campaign mode can request autonomous execution", () => {
  assert.deepEqual([...CAMPAIGN_MODES], ["alert", "prepare", "owner_arm"]);
  for (const mode of CAMPAIGN_MODES) {
    assert.equal(/execute|broadcast|sign/i.test(mode), false, `${mode} must not imply execution`);
  }
});

test("watch categories are the eight the package already defines", () => {
  assert.deepEqual([...WATCH_CATEGORIES], [
    "price",
    "wallet",
    "risk",
    "execution",
    "security",
    "nft",
    "governance",
    "system",
  ]);
});

test("saving a campaign twice updates in place rather than duplicating", () => {
  const campaign = createCampaign(campaignInput(), { now: NOW_ISO, id: "camp-1" });
  const once = mergeCampaign([], campaign, NOW_ISO);
  const twice = mergeCampaign(once, { ...campaign, label: "renamed" }, "2026-08-03T20:05:00.000Z");
  assert.equal(twice.length, 1);
  assert.equal(twice[0].label, "renamed");
  assert.equal(twice[0].updatedAt, "2026-08-03T20:05:00.000Z");
});

test("two distinct campaigns both persist, newest updated first", () => {
  const a = createCampaign(campaignInput(), { now: NOW_ISO, id: "camp-a" });
  const b = createCampaign(campaignInput({ label: "second" }), { now: NOW_ISO, id: "camp-b" });
  const list = mergeCampaign(mergeCampaign([], a, NOW_ISO), b, "2026-08-03T20:10:00.000Z");
  assert.equal(list.length, 2);
  assert.deepEqual(sortCampaigns(list).map((item) => item.id), ["camp-b", "camp-a"]);
});

test("pause and resume round-trip through applyCampaignStatus", () => {
  const campaign = createCampaign(campaignInput(), { now: NOW_ISO, id: "camp-1" });
  const paused = applyCampaignStatus([campaign], "camp-1", "paused", "2026-08-03T20:01:00.000Z");
  assert.equal(paused[0].status, "paused");
  assert.equal(paused[0].updatedAt, "2026-08-03T20:01:00.000Z");

  const resumed = applyCampaignStatus(paused, "camp-1", "watching", "2026-08-03T20:02:00.000Z");
  assert.equal(resumed[0].status, "watching");
});

test("applyCampaignStatus leaves other campaigns untouched", () => {
  const a = createCampaign(campaignInput(), { now: NOW_ISO, id: "camp-a" });
  const b = createCampaign(campaignInput(), { now: NOW_ISO, id: "camp-b" });
  const next = applyCampaignStatus([a, b], "camp-a", "paused", NOW_ISO);
  assert.equal(next.find((item) => item.id === "camp-b").status, "watching");
});

test("expiry is derived from the clock, not from a stored write", () => {
  const campaign = createCampaign(campaignInput(), { now: NOW_ISO, id: "camp-1" });
  assert.equal(classifyCampaign(campaign, NOW_MS), "watching");
  assert.equal(classifyCampaign(campaign, NOW_MS + 3_600_001), "expired");
  assert.equal(campaign.status, "watching", "classification must not mutate the record");
});

test("a campaign expiring exactly at now is expired (fail closed at the boundary)", () => {
  const expiresAt = new Date(NOW_MS).toISOString();
  const campaign = createCampaign(campaignInput({ expiresAt }), { now: NOW_ISO, id: "camp-1" });
  assert.equal(classifyCampaign(campaign, NOW_MS), "expired");
});

test("an explicitly paused campaign stays paused past its expiry", () => {
  const campaign = { ...createCampaign(campaignInput(), { now: NOW_ISO, id: "camp-1" }), status: "paused" };
  assert.equal(classifyCampaign(campaign, NOW_MS + 9_999_999), "paused");
});

test("stats count active by effective status and split alert from arm requests", () => {
  const alert = createCampaign(campaignInput(), { now: NOW_ISO, id: "camp-alert" });
  const arm = createCampaign(campaignInput({ mode: "owner_arm" }), { now: NOW_ISO, id: "camp-arm" });
  const stale = createCampaign(
    campaignInput({ expiresAt: new Date(NOW_MS - 1000).toISOString() }),
    { now: NOW_ISO, id: "camp-stale" },
  );
  const campaigns = [alert, arm, stale];

  assert.deepEqual(campaignStats(campaigns, NOW_MS), { active: 2, alert: 2, arm: 1 });
  assert.deepEqual(campaignStats(campaigns, NOW_MS + 3_600_001), { active: 0, alert: 2, arm: 1 });
});

test("pausing a campaign drops it out of the active count", () => {
  const campaign = createCampaign(campaignInput(), { now: NOW_ISO, id: "camp-1" });
  assert.equal(campaignStats([campaign], NOW_MS).active, 1);
  const paused = applyCampaignStatus([campaign], "camp-1", "paused", NOW_ISO);
  assert.equal(campaignStats(paused, NOW_MS).active, 0);
});
