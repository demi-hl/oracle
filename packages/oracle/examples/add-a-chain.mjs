// Example: register a chain Oracle has never seen, then use it.
//
// Run:  node examples/add-a-chain.mjs
//
// The point of this example is that there is no adapter to write. A chain is a
// config object; the generic EVM scanner supplies the capabilities.

import { registerCustomChain } from "../src/scanner/chains.config.mjs";
import { scannerCoverage } from "../src/scanner/contract.mjs";

// 1. Describe the chain. Note rpcEnv holds VARIABLE NAMES, not URLs -- endpoints
//    stay in the environment so nothing sensitive lands in source control.
const scanner = registerCustomChain({
  key: "examplechain",
  chainId: 424242,
  name: "Example Chain",
  rpcEnv: ["EXAMPLECHAIN_RPC_URL"],
  nativeCurrency: { symbol: "EXC", decimals: 18 },
  explorer: "https://explorer.example",

  // Omitted deliberately: dexscreenerSlug. Without it, pool discovery reports
  // UNAVAILABLE rather than guessing -- a wrong slug would return another chain's
  // pools, which is worse than no answer.

  // Omitted deliberately: venues. With none, the chain is read/research capable and
  // fail-closed for routing value. Adding one requires recorded provenance; see
  // docs/adding-a-chain.md.
});

console.log(`registered: ${scanner.name} (chain ${scanner.chainId})`);

// 2. Ask what it can actually do. The answer is honest -- unimplemented
//    capabilities are listed as unsupported, not silently absent.
const caps = scanner.capabilities();
console.log(`\nsupported   (${caps.supported.length}): ${caps.supported.join(", ")}`);
console.log(`unsupported (${caps.unsupported.length}): ${caps.unsupported.join(", ")}`);

// 3. An unimplemented capability throws with an actionable message. It never
//    returns undefined, which a caller could mistake for "no result".
try {
  await scanner.quote({ from: "0x", to: "0x", amount: "1" });
} catch (err) {
  console.log(`\nquote() correctly refused:\n  ${err.message.split("\n")[0]}`);
}

// 4. Pool discovery is UNAVAILABLE, and says why.
const pools = await scanner.resolvePools("0x1111111111111111111111111111111111111111");
console.log(`\nresolvePools evidence: ${pools.evidence}`);
console.log(`  reason: ${pools.reason}`);

// 5. Live reads need an RPC. Show the exact variable to set rather than failing
//    with a generic network error.
console.log(`\nto make live reads, set one of: ${scanner.rpcEnv.join(", ")}`);
try {
  const head = await scanner.blockNumber();
  console.log(`  head: ${head.blockNumber} (${head.evidence})`);
} catch {
  console.log("  (no RPC configured -- expected for this example chain)");
}

// 6. The coverage matrix now includes it alongside the built-ins.
const cov = scannerCoverage();
console.log(`\ncoverage: ${cov.chainCount} chain(s) registered`);
const mine = cov.chains[424242];
console.log(`  examplechain failClosed for routing: ${mine.failClosed}`);
