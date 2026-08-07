import test from "node:test";
import assert from "node:assert/strict";
import { FARMING_METHODS, scorePool, classifyPool, riskHaircut, airdropEV, discoverFarms } from "../src/data/providers/farming.mjs";
import farmCommand from "../src/cli/commands/farm.mjs";

test("farming methods expose the full playbook contract", () => {
  assert.equal(FARMING_METHODS.length, 6);
  for (const m of FARMING_METHODS) {
    for (const key of ["id", "label", "risk", "setup", "exposure", "hedge", "monitor", "exit"]) {
      assert.ok(typeof m[key] === "string" && m[key].length > 0, `${m.id} missing ${key}`);
    }
  }
  // The pane advertises these ids; the CLI must expose the same set.
  const ids = FARMING_METHODS.map((m) => m.id);
  assert.deepEqual(ids, [
    "stable-loop", "collateral-hedge", "lp-hedge",
    "quest-farming", "liquidity-usage", "governance-usage",
  ]);
});

test("pool classification routes by exposure shape", () => {
  assert.equal(classifyPool({ symbol: "USDC", stablecoin: true, apy: 9, tvlUsd: 5e6 }), "stable-loop");
  assert.equal(classifyPool({ symbol: "WETH-USDC", apy: 20, tvlUsd: 5e6 }), "lp-hedge");
  assert.equal(classifyPool({ symbol: "ETH", apy: 12, tvlUsd: 5e6 }), "collateral-hedge");
  // Zero or negative yield is not an opportunity.
  assert.equal(classifyPool({ symbol: "USDC", stablecoin: true, apy: 0, tvlUsd: 5e6 }), null);
  assert.equal(classifyPool({ symbol: "USDC", stablecoin: true, apy: 9, tvlUsd: 0 }), null);
});

test("risk haircut widens as TVL thins", () => {
  const deep = riskHaircut({ tvlUsd: 50_000_000 }, "stable-loop");
  const mid = riskHaircut({ tvlUsd: 5_000_000 }, "stable-loop");
  const thin = riskHaircut({ tvlUsd: 500_000 }, "stable-loop");
  assert.ok(thin > mid && mid > deep, `expected thin>${mid}>deep, got ${thin}/${mid}/${deep}`);
  assert.ok(riskHaircut({ tvlUsd: 1 }, "lp-hedge") <= 35, "haircut must stay capped");
});

test("scorePool subtracts real costs and never inflates a thin pool", () => {
  const scored = scorePool({ symbol: "USDC", stablecoin: true, apy: 30, apyBase: 5, tvlUsd: 50_000_000, pool: "x" });
  assert.equal(scored.recipe, "stable-loop");
  // net = apy - borrow - funding - gas - haircut, all subtractive
  assert.ok(scored.netApr < 30, "net apr must be below headline apy");
  assert.equal(scored.netApr, 30 - scored.estimatedBorrowApr - scored.estimatedFundingApr - scored.gasApr - scored.riskHaircut);
  // A big APY on a shallow pool is a warning, never "Farmable".
  const thin = scorePool({ symbol: "USDC", stablecoin: true, apy: 120, tvlUsd: 2_000_000, pool: "y" });
  assert.equal(thin.verdict, "Watchlist");
  assert.ok(scored.prepareSteps.length >= 4);
  assert.match(scored.prepareSteps[1], /wallet grant/);
});

test("airdrop EV subtracts cost and haircuts, and can go negative", () => {
  const ev = airdropEV({});
  assert.ok(ev.monthlyCost > 0);
  assert.ok(ev.adjustedExpectedValue < ev.grossExpectedValue, "haircuts must reduce gross");
  assert.equal(Math.round(ev.netExpectedValue), Math.round(ev.adjustedExpectedValue - ev.monthlyCost));
  assert.ok(ev.lockupDiscount <= 1);
  // An expensive campaign with poor odds must report negative EV, not a floor of 0.
  const bad = airdropEV({ wallets: 1, expectedReward: 10, probability: 1, hoursWeekly: 40, hourlyCost: 100 });
  assert.ok(bad.netExpectedValue < 0);
  assert.equal(bad.verdict, "negative-ev");
  assert.match(ev.posture, /not a payout promise/);
});

test("airdrop EV clamps hostile input instead of returning NaN", () => {
  const ev = airdropEV({ wallets: -5, probability: 999, hourlyCost: "abc", lockupMonths: 10_000 });
  for (const v of [ev.monthlyCost, ev.netExpectedValue, ev.grossExpectedValue]) {
    assert.ok(Number.isFinite(v), "every output must be finite");
  }
  assert.ok(ev.inputs.wallets >= 1);
  assert.ok(ev.inputs.probabilityPct <= 100);
  assert.ok(ev.lockupDiscount >= 0, "lockup discount must not go negative");
});

test("discoverFarms fails soft when the upstream feed is down", async () => {
  const result = await discoverFarms({}, { fetchImpl: async () => { throw new Error("feed offline"); } });
  assert.equal(result.live, false);
  assert.equal(result.configured, false);
  assert.deepEqual(result.candidates, []);
  assert.match(result.error, /feed offline/);
  // Posture must survive the failure path too.
  assert.match(result.posture, /no signing or broadcast/);
});

test("discoverFarms ranks by net APR and respects the TVL floor", async () => {
  const fakePools = {
    data: [
      { pool: "a", symbol: "USDC", stablecoin: true, apy: 40, tvlUsd: 80_000_000, chain: "Base", project: "aave" },
      { pool: "b", symbol: "USDC", stablecoin: true, apy: 12, tvlUsd: 90_000_000, chain: "Base", project: "moonwell" },
      { pool: "c", symbol: "USDC", stablecoin: true, apy: 99, tvlUsd: 1_000, chain: "Base", project: "rug" },
    ],
  };
  const fetchImpl = async () => new Response(JSON.stringify(fakePools), { status: 200, headers: { "content-type": "application/json" } });
  const result = await discoverFarms({ limit: 10 }, { fetchImpl });
  assert.equal(result.live, true);
  const ids = result.candidates.map((c) => c.id);
  assert.ok(!ids.includes("c"), "sub-floor TVL pool must be excluded");
  assert.equal(ids[0], "a", "higher net APR must rank first");
  for (let i = 1; i < result.candidates.length; i += 1) {
    assert.ok(result.candidates[i - 1].netApr >= result.candidates[i].netApr, "must be sorted by net apr");
  }
});

test("oracle farm command is registered and handles its subcommands", async () => {
  assert.equal(farmCommand.name, "farm");
  assert.ok(typeof farmCommand.run === "function");
  assert.match(farmCommand.usage, /methods\|discover\|airdrop/);

  const writes = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    assert.equal(await farmCommand.run({ argv: ["methods"] }), 0);
    assert.equal(await farmCommand.run({ argv: ["airdrop", "--json"] }), 0);
    // Unknown subcommands must fail loudly rather than silently no-op.
    assert.equal(await farmCommand.run({ argv: ["nonsense"] }), 1);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  const all = writes.join("");
  assert.match(all, /stable-loop/);
  assert.match(all, /netExpectedValue/);
  assert.match(all, /unknown subcommand/);
});
