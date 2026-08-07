import { spawnSync } from "node:child_process";

/**
 * Crossbook product surface.
 *
 * Separate protocol product (tokenized / on-chain equities best execution across
 * HIP-3, Arcus, RH Uniswap, Solana xStocks, TON), shipped inside the Oracle CLI
 * so one install reaches it. Prepare-only; never signs.
 */
export default {
  name: "equities",
  summary: "Crossbook — HIP-3 / Arcus / RH / Solana / TON best execution",
  group: "read",
  usage: "oracle equities <venues|quote|prepare> [ticker] [flags]",
  async run(ctx) {
    if (ctx.argv.includes("-h") || ctx.argv.includes("--help") || ctx.argv.length === 0) {
      process.stdout.write(`Crossbook — separate Oracle product for on-chain equities best execution

Venues: HIP-3 builder DEXes · Arcus spot/perp · RH Uniswap (4663) · Solana xStocks · TON ston.fi
Custody: prepare-only. Quote-only winners are never sold as signable here.
Only rh_uniswap can emit an unsigned tx (your wallet signs).

Usage:
  oracle equities venues
  oracle equities quote NVDA --size 1000
  oracle equities quote SPY --size 500 --json
  oracle equities prepare NVDA --recipient 0xYourWallet --size 1000

Alias bin: oracle-equities
`);
      return 0;
    }
    const bin = ctx.bin("oracle-equities.mjs");
    const r = spawnSync(process.execPath, [bin, ...ctx.argv], { stdio: "inherit" });
    if (r.error) {
      process.stderr.write(`oracle: failed to spawn oracle-equities: ${r.error.message}\n`);
      return 1;
    }
    return typeof r.status === "number" ? r.status : 1;
  },
};
