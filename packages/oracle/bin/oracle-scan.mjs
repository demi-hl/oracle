#!/usr/bin/env node
// oracle-scan -- exercise the chain-scanner framework from the shell.
//
// Useful for two things: checking a chain is actually reachable with your RPC
// config, and researching a token without wiring up an agent first.
//
// Usage:
//   oracle-scan chains                      coverage matrix for every chain
//   oracle-scan head <chain>                current block
//   oracle-scan token <chain> <address>     on-chain ERC-20 identity
//   oracle-scan pools <chain> <address>     tradeable pools by liquidity
//   oracle-scan risk  <chain> <address>     structural risk checks
//
// <chain> is a chain id (8453) or key (base).

import { registerBuiltinScanners } from "../src/scanner/chains.config.mjs";
import { getScanner, listScanners, scannerCoverage } from "../src/scanner/contract.mjs";

registerBuiltinScanners();

const [cmd, ...rest] = process.argv.slice(2);
const JSON_OUT = rest.includes("--json");
const args = rest.filter((a) => a !== "--json");

function resolve(ref) {
  if (!ref) die("missing <chain>");
  const byId = getScanner(Number(ref));
  if (byId) return byId;
  const byKey = listScanners().find((s) => s.key === String(ref).toLowerCase());
  if (byKey) return byKey;
  die(
    `unknown chain "${ref}". Known: ${listScanners().map((s) => `${s.key}(${s.chainId})`).join(", ")}`,
  );
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

// A missing RPC is the most common reason a scan fails. Say so precisely instead of
// surfacing a generic fetch error.
function rpcHint(scanner, err) {
  const msg = String(err?.message || err);
  if (/rpc|fetch|ECONN|timeout|provider/i.test(msg)) {
    return (
      `${msg}\n\nThis chain reads its RPC from: ${scanner.rpcEnv.join(" or ")}\n` +
      `Set one, e.g.:  export ${scanner.rpcEnv[0]}=https://...`
    );
  }
  return msg;
}

try {
  switch (cmd) {
    case "chains": {
      const cov = scannerCoverage();
      if (JSON_OUT) {
        out(cov);
        break;
      }
      console.log(`${cov.chainCount} chains registered\n`);
      const rows = Object.entries(cov.chains).map(([id, c]) => ({
        chain: `${c.key} (${id})`,
        caps: c.supported.length,
        routing: c.failClosed ? "fail-closed (no verified venue)" : `${c.venueCount} venue(s)`,
      }));
      const w = Math.max(...rows.map((r) => r.chain.length));
      for (const r of rows) {
        console.log(`  ${r.chain.padEnd(w)}  ${String(r.caps).padStart(2)} caps   ${r.routing}`);
      }
      console.log(
        "\nEvery chain is read/research capable. Routing value requires a verified\n" +
          "venue -- see CONTRIBUTING.md for the verification rule.",
      );
      break;
    }

    case "head": {
      const s = resolve(args[0]);
      out(await s.blockNumber());
      break;
    }

    case "token": {
      const s = resolve(args[0]);
      if (!args[1]) die("usage: oracle-scan token <chain> <address>");
      out(await s.resolveToken(args[1]));
      break;
    }

    case "pools": {
      const s = resolve(args[0]);
      if (!args[1]) die("usage: oracle-scan pools <chain> <address>");
      const r = await s.resolvePools(args[1]);
      if (JSON_OUT) {
        out(r);
        break;
      }
      console.log(`evidence: ${r.evidence}`);
      if (r.reason) console.log(`reason:   ${r.reason}`);
      for (const p of r.pools.slice(0, 10)) {
        const liq = p.liquidityUsd == null ? "?" : `$${Math.round(p.liquidityUsd).toLocaleString()}`;
        console.log(`  ${p.dex.padEnd(12)} ${liq.padStart(14)}  ${p.pair}`);
      }
      if (!r.pools.length) console.log("  (no pools with liquidity found)");
      break;
    }

    case "risk": {
      const s = resolve(args[0]);
      if (!args[1]) die("usage: oracle-scan risk <chain> <address>");
      const r = await s.scoreRisk(args[1]);
      if (JSON_OUT) {
        out(r);
        break;
      }
      console.log(`verdict: ${r.verdict}\n`);
      for (const c of r.checks) {
        console.log(`  ${c.result.padEnd(8)} ${c.check.padEnd(16)} ${c.detail ?? ""}`);
      }
      console.log(`\n${r.note}`);
      break;
    }

    case "quote": {
      const s = resolve(args[0]);
      if (!args[1] || !args[2]) die("usage: oracle-scan quote <chain> <tokenIn> <tokenOut> [amountIn]");
      if (!s.supports("quote")) {
        die(
          `${s.key} has no verified router, so quoting stays fail-closed.\n` +
            "Add a venue with recorded provenance -- see docs/adding-a-chain.md.",
        );
      }
      const amountIn = args[3] || (10n ** 18n).toString();
      out(await s.quote({ tokenIn: args[1], tokenOut: args[2], amountIn }));
      break;
    }

    case "sell": {
      // The single most valuable check on a low-cap venue: can you get OUT?
      const s = resolve(args[0]);
      if (!args[1]) die("usage: oracle-scan sell <chain> <token> [amountIn]");
      if (!s.supports("sellSimulation")) {
        die(
          `${s.key} has no verified router, so sell simulation is unavailable.\n` +
            "Without it, treat every token on this chain as unproven for exit.",
        );
      }
      const amountIn = args[2] || (10n ** 16n).toString();
      const r = await s.sellSimulation({ token: args[1], amountIn });
      if (JSON_OUT) {
        out(r);
        break;
      }
      console.log(`verdict:   ${r.verdict}`);
      console.log(`reason:    ${r.reason ?? ""}`);
      if (r.retentionBps != null) {
        console.log(`retention: ${(r.retentionBps / 100).toFixed(2)}%`);
      }
      if (r.leg) console.log(`failed at: ${r.leg} leg`);
      if (r.note) console.log(`\n${r.note}`);
      break;
    }

    default:
      console.log(
        [
          "oracle-scan -- chain scanner CLI",
          "",
          "  oracle-scan chains                              coverage matrix",
          "  oracle-scan head  <chain>                       current block",
          "  oracle-scan token <chain> <address>             ERC-20 identity",
          "  oracle-scan pools <chain> <address>             pools by liquidity",
          "  oracle-scan risk  <chain> <address>             structural risk checks",
          "  oracle-scan quote <chain> <tIn> <tOut> [amt]    live exact-input quote",
          "  oracle-scan sell  <chain> <token> [amt]         round-trip: can you exit?",
          "",
          "  <chain> is an id (8453) or key (base).  --json for machine output.",
          "  quote/sell need a chain with a verified router (see: oracle-scan chains).",
        ].join("\n"),
      );
      process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  const s = args[0] ? (getScanner(Number(args[0])) || listScanners().find((x) => x.key === args[0])) : null;
  die(s ? rpcHint(s, err) : String(err?.message || err));
}
