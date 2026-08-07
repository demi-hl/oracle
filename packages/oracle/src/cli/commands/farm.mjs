import { FARMING_METHODS, discoverFarms, airdropEV } from "../../data/providers/farming.mjs";

const USAGE = `oracle farm <methods|discover|airdrop> [options]

  oracle farm methods                       list the delta-aware farming playbooks
  oracle farm methods --id stable-loop      full setup/exposure/hedge/monitor/exit for one method
  oracle farm discover [--chain base]       rank live pools by net APR after costs and risk haircut
                       [--limit 12] [--min-tvl 2000000] [--json]
  oracle farm airdrop  [--wallets 5] [--tasks-weekly 6] [--hours-weekly 4]
                       [--hourly-cost 25] [--gas-per-task 0.4] [--bridge-monthly 12]
                       [--expected-reward 900] [--probability 22]
                       [--sybil-haircut 25] [--lockup-months 6] [--json]

Read-only. Ranks opportunities and designs prepare plans; never signs or broadcasts.`;

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") { out.json = true; continue; }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { out[key] = true; continue; }
      out[key] = next;
      i += 1;
      continue;
    }
    out._.push(arg);
  }
  return out;
}

const usd = (n) => `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
const pct = (n) => `${(Number(n) || 0).toFixed(1)}%`;

function printMethods(flags) {
  const id = typeof flags.id === "string" ? flags.id : null;
  if (id) {
    const method = FARMING_METHODS.find((m) => m.id === id);
    if (!method) {
      process.stderr.write(`oracle farm: unknown method '${id}'. Known: ${FARMING_METHODS.map((m) => m.id).join(", ")}\n`);
      return 1;
    }
    if (flags.json) { process.stdout.write(JSON.stringify(method, null, 2) + "\n"); return 0; }
    process.stdout.write(`\n  ${method.label}  [${method.risk}]  target delta ${method.targetDelta}\n\n`);
    for (const [label, key] of [["setup", "setup"], ["exposure", "exposure"], ["hedge", "hedge"], ["monitor", "monitor"], ["exit", "exit"]]) {
      process.stdout.write(`  ${label.padEnd(9)} ${method[key]}\n`);
    }
    process.stdout.write("\n");
    return 0;
  }
  if (flags.json) { process.stdout.write(JSON.stringify(FARMING_METHODS, null, 2) + "\n"); return 0; }
  process.stdout.write("\n  farming methods\n\n");
  for (const m of FARMING_METHODS) {
    process.stdout.write(`  ${m.id.padEnd(18)} ${m.label.padEnd(30)} ${m.risk}\n`);
  }
  process.stdout.write("\n  oracle farm methods --id <id> for setup, exposure, hedge, monitor, and exit rules.\n\n");
  return 0;
}

async function printDiscover(flags) {
  const result = await discoverFarms({
    chain: typeof flags.chain === "string" ? flags.chain : null,
    limit: flags.limit,
    minTvl: flags["min-tvl"],
  });
  if (flags.json) { process.stdout.write(JSON.stringify(result, null, 2) + "\n"); return 0; }
  if (!result.live) {
    process.stderr.write(`oracle farm: discovery unavailable — ${result.error}\n`);
    return 1;
  }
  process.stdout.write(`\n  live farm discovery — ${result.source}, ${result.considered.toLocaleString("en-US")} pools considered (${result.consideredNote}), chain=${result.chain}\n\n`);
  process.stdout.write(`  ${"verdict".padEnd(10)}${"net apr".padStart(9)}  ${"tvl".padStart(12)}  ${"chain".padEnd(12)}${"recipe".padEnd(18)}pool\n`);
  for (const c of result.candidates) {
    process.stdout.write(
      `  ${c.verdict.padEnd(10)}${pct(c.netApr).padStart(9)}  ${usd(c.tvlUsd).padStart(12)}  ${c.chain.slice(0, 11).padEnd(12)}${c.recipe.padEnd(18)}${c.label}\n`,
    );
  }
  process.stdout.write(`\n  net apr = apy − borrow − funding − gas − risk haircut.\n  ${result.posture}.\n\n`);
  return 0;
}

function printAirdrop(flags) {
  const ev = airdropEV({
    wallets: flags.wallets,
    tasksWeekly: flags["tasks-weekly"],
    hoursWeekly: flags["hours-weekly"],
    hourlyCost: flags["hourly-cost"],
    gasPerTask: flags["gas-per-task"],
    bridgeMonthly: flags["bridge-monthly"],
    expectedReward: flags["expected-reward"],
    probability: flags.probability,
    sybilHaircut: flags["sybil-haircut"],
    lockupMonths: flags["lockup-months"],
  });
  if (flags.json) { process.stdout.write(JSON.stringify(ev, null, 2) + "\n"); return 0; }
  const i = ev.inputs;
  process.stdout.write(`\n  airdrop expected value\n\n`);
  process.stdout.write(`  ${i.wallets} wallets · ${i.tasksWeekly} tasks/wk · ${i.hoursWeekly} hrs/wk @ ${usd(i.hourlyCost)}/hr\n`);
  process.stdout.write(`  ${pct(i.probabilityPct)} eligibility · ${pct(i.sybilHaircutPct)} sybil haircut · ${i.lockupMonths}mo lockup\n\n`);
  process.stdout.write(`  monthly cost      ${usd(ev.monthlyCost).padStart(12)}   (gas ${usd(ev.monthlyGas)} + labor ${usd(ev.laborMonthly)} + bridges ${usd(i.bridgeMonthly)})\n`);
  process.stdout.write(`  gross EV          ${usd(ev.grossExpectedValue).padStart(12)}\n`);
  process.stdout.write(`  after haircuts    ${usd(ev.adjustedExpectedValue).padStart(12)}   (lockup discount ${(ev.lockupDiscount * 100).toFixed(0)}%)\n`);
  process.stdout.write(`  net EV            ${usd(ev.netExpectedValue).padStart(12)}   ${ev.verdict}\n`);
  if (ev.roiPct != null) process.stdout.write(`  ROI               ${pct(ev.roiPct).padStart(12)}\n`);
  if (ev.breakevenProbabilityPct != null) {
    process.stdout.write(`  breakeven odds    ${pct(ev.breakevenProbabilityPct).padStart(12)}   campaign must clear this to profit\n`);
  }
  process.stdout.write(`\n  ${ev.posture}.\n\n`);
  return 0;
}

export default {
  name: "farm",
  summary: "farming methods, live farm discovery, airdrop EV",
  group: "read",
  usage: USAGE,
  async run(ctx) {
    const flags = parseFlags(ctx.argv);
    const sub = flags._[0];
    if (!sub || sub === "help") { process.stdout.write(USAGE + "\n"); return 0; }
    if (sub === "methods") return printMethods(flags);
    if (sub === "discover") return printDiscover(flags);
    if (sub === "airdrop") return printAirdrop(flags);
    process.stderr.write(`oracle farm: unknown subcommand '${sub}'\n\n${USAGE}\n`);
    return 1;
  },
};
