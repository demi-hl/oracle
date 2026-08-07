import { data as desk } from "../src/data/desk-data.mjs";
import {
  hlPrepareStakeDeposit,
  hlPrepareStakeWithdraw,
  hlPrepareDelegate,
  hypeToWei,
  weiToHype,
} from "../src/data/providers/hl-staking.mjs";

const USER = process.env.ORACLE_E2E_EVM_ADDRESS || "0x0000000000000000000000000000000000000001";
const results = [];
function log(lane, status, detail) {
  results.push({ lane, status });
  console.log(`${status === "ok" ? "OK  " : "FAIL"} ${lane} :: ${detail}`);
}
async function run(lane, fn) {
  try {
    log(lane, "ok", await fn());
  } catch (e) {
    log(lane, "fail", String(e?.message || e).slice(0, 150));
  }
}

console.log("== HYPERCORE STAKING ==");

let validator = null;
await run("hl.staking.validators", async () => {
  const v = await desk.hl.staking.validators();
  const active = v.validators.filter((x) => x.isActive && !x.isJailed);
  validator = active[0]?.validator || v.validators[0]?.validator;
  return `validators=${v.count} activeUnjailed=${active.length} first=${(validator || "").slice(0, 10)}..`;
});

await run("hl.staking.health", async () => {
  const h = await desk.hl.staking.health();
  if (!h.ok) throw new Error("staking lane unhealthy");
  return `ok validators=${h.validators} chain=${h.chain}`;
});

await run("hl.staking.delegatorSummary", async () => {
  const s = await desk.hl.staking.summary(USER);
  return `delegated=${s.delegatedWei} undelegated=${s.undelegatedWei} pendingWithdrawals=${s.nPendingWithdrawals}`;
});

await run("hl.staking.delegations", async () => {
  const d = await desk.hl.staking.delegations(USER);
  return `count=${d.count}`;
});

await run("hl.staking.rewards", async () => {
  const r = await desk.hl.staking.rewards(USER);
  return `rewards=${r.rewards.length}`;
});

await run("hl.staking.preflight", async () => {
  const p = await desk.hl.staking.preflight(USER);
  return `undelegated=${p.stakingBalanceUndelegated} queueDays=${p.unstakingQueueDays} lockupDays=${p.validatorLockupDays}`;
});

await run("hl.staking.units", async () => {
  const w = hypeToWei("1.5");
  if (w !== "150000000") throw new Error(`1.5 HYPE -> ${w}, expected 150000000`);
  if (weiToHype("150000000") !== "1.5") throw new Error("roundtrip failed");
  return `1.5 HYPE = ${w} wei roundtrip ok`;
});

await run("hl.staking.prepareStake", async () => {
  const p = hlPrepareStakeDeposit({ amountHype: "2.5", maxHype: "10" });
  if (p.action.type !== "cDeposit") throw new Error("wrong action type");
  if (p.broadcastReady !== false || p.signingReady !== false) throw new Error("leaked readiness");
  if (!p.requiresUserSignature) throw new Error("must require user signature");
  return `cDeposit wei=${p.action.wei} primaryType=${p.typedData.primaryType} broadcastReady=false`;
});

await run("hl.staking.prepareStake.capBreach", async () => {
  try {
    hlPrepareStakeDeposit({ amountHype: "50", maxHype: "10" });
  } catch (e) {
    return `rejected over-cap: ${String(e.message).slice(0, 70)}`;
  }
  throw new Error("cap was NOT enforced");
});

await run("hl.staking.prepareDelegate", async () => {
  if (!validator) throw new Error("no validator resolved");
  const p = hlPrepareDelegate({ validator, amountHype: "2.5", isUndelegate: false, maxHype: "10" });
  if (p.action.type !== "tokenDelegate" || p.action.isUndelegate !== false) throw new Error("wrong action");
  return `tokenDelegate validator=${p.action.validator.slice(0, 10)}.. wei=${p.action.wei} isUndelegate=false`;
});

await run("hl.staking.prepareUndelegate", async () => {
  const p = hlPrepareDelegate({ validator, amountHype: "2.5", isUndelegate: true });
  if (p.action.isUndelegate !== true) throw new Error("undelegate flag lost");
  return `tokenDelegate isUndelegate=true kind=${p.kind}`;
});

await run("hl.staking.prepareUnstake", async () => {
  const p = hlPrepareStakeWithdraw({ amountHype: "2.5" });
  if (p.action.type !== "cWithdraw") throw new Error("wrong action type");
  if (!p.notes.join(" ").includes("7 day")) throw new Error("missing unstaking queue warning");
  return `cWithdraw wei=${p.action.wei} queue warning present`;
});

await run("hl.staking.badAmount", async () => {
  try {
    hlPrepareStakeDeposit({ amountHype: "0" });
  } catch (e) {
    return `rejected zero amount`;
  }
  throw new Error("zero amount accepted");
});

await run("hl.staking.badValidator", async () => {
  try {
    hlPrepareDelegate({ validator: "not-an-address", amountHype: "1" });
  } catch (e) {
    return `rejected bad validator`;
  }
  throw new Error("bad validator accepted");
});

const failed = results.filter((r) => r.status === "fail");
console.log(`\nlanes=${results.length} ok=${results.length - failed.length} failed=${failed.length}`);
if (failed.length) {
  console.log(`FAILED: ${failed.map((f) => f.lane).join(", ")}`);
  process.exit(1);
}
console.log("HYPERCORE STAKING OK: reads live, stake/unstake/delegate prepare-only, caps enforced.");
