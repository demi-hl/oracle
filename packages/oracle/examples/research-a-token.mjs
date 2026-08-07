// Example: research a token end to end, honestly.
//
// Run:  node examples/research-a-token.mjs
//       node examples/research-a-token.mjs base 0x<address>
//
// Demonstrates the discipline the desk is built around: read the identity off the
// chain, find pools with real liquidity, and report UNKNOWN where a check could not
// run rather than letting silence read as approval.

import { registerBuiltinScanners } from "../src/scanner/chains.config.mjs";
import { getScanner, listScanners, EVIDENCE, RISK } from "../src/scanner/contract.mjs";

registerBuiltinScanners();

const chainRef = process.argv[2] || "base";
// Base USDC by default -- a token whose answers are easy to sanity-check.
const token = process.argv[3] || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const scanner =
  listScanners().find((s) => s.key === chainRef) || getScanner(Number(chainRef));
if (!scanner) {
  console.error(`unknown chain "${chainRef}"`);
  process.exit(1);
}

console.log(`chain: ${scanner.name} (${scanner.chainId})`);
console.log(`token: ${token}\n`);

// 1. Identity from the CONTRACT, not a token list. A list can be stale or omit a
//    two-hour-old launch, and the on-chain answer is what governs a transfer.
const meta = await scanner.resolveToken(token);
if (meta.evidence !== EVIDENCE.LIVE) {
  console.log(`identity: ${meta.evidence} -- ${meta.warning ?? meta.error}`);
  console.log("stopping: without ERC-20 metadata there is nothing to price.");
  process.exit(0);
}
console.log(`identity: ${meta.symbol} (${meta.name}), ${meta.decimals} decimals`);

// 2. Pools, ranked by liquidity. Depth is what determines your fill; the headline
//    price is a fiction for anything but the smallest clip.
const pools = await scanner.resolvePools(token);
console.log(`\npools: ${pools.evidence}`);
if (pools.reason) console.log(`  ${pools.reason}`);
for (const p of pools.pools.slice(0, 5)) {
  const liq = p.liquidityUsd == null ? "unknown" : `$${Math.round(p.liquidityUsd).toLocaleString()}`;
  console.log(`  ${p.dex.padEnd(14)} ${liq.padStart(14)}  ${p.pair}`);
}

// 3. Structural risk. Read the verdict AND the individual checks -- an overall
//    UNKNOWN often hides several passes plus one unprovable item, and which item is
//    unprovable is the decision-relevant part.
const risk = await scanner.scoreRisk(token);
console.log(`\nrisk verdict: ${risk.verdict}`);
for (const c of risk.checks) {
  console.log(`  ${c.result.padEnd(8)} ${c.check.padEnd(16)} ${c.detail ?? ""}`);
}

// 4. The honest close. UNKNOWN is not PASS, and a buy path is not an exit path.
console.log("");
if (risk.verdict === RISK.FAIL) {
  console.log("FAIL: disqualifying finding above. Do not trade.");
} else if (risk.verdict === RISK.UNKNOWN) {
  console.log(
    "UNKNOWN is not PASS. Structural checks looked fine, but sellability is\n" +
      "unproven without a verified router on this chain. Until a round-trip sell\n" +
      "simulation succeeds, treat this token as not exitable.",
  );
} else {
  console.log(`${risk.verdict}: structural checks only -- still not a recommendation.`);
}
