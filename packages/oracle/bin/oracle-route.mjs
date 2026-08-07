#!/usr/bin/env node
// oracle-route -- compare swap and bridge routes across every available source.
//
// Usage:
//   oracle-route swap   <chain> <tokenIn> <tokenOut> [amountIn]
//   oracle-route bridge <fromChain> <toChain> <token> [amountIn]
//
// <chain> is an id (8453) or key (base). --json for machine output.

import { bestSwapRoute, bestBridgeRoute } from "../src/router/index.mjs";
import { prepareBestRoute } from "../src/router/prepare-route.mjs";
import { prepareBestBridgeRoute } from "../src/router/prepare-bridge.mjs";
import { registerBuiltinScanners } from "../src/scanner/chains.config.mjs";
import { getScanner, listScanners } from "../src/scanner/contract.mjs";

registerBuiltinScanners();

const [cmd, ...rest] = process.argv.slice(2);
const JSON_OUT = rest.includes("--json");
const args = rest.filter((a) => a !== "--json");
const NATIVE = "0x0000000000000000000000000000000000000000";

function chainId(ref) {
  if (!ref) die("missing <chain>");
  const n = Number(ref);
  if (getScanner(n)) return n;
  const s = listScanners().find((x) => x.key === String(ref).toLowerCase());
  if (s) return s.chainId;
  die(`unknown chain "${ref}". Known: ${listScanners().map((x) => x.key).join(", ")}`);
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function fmt(raw, decimals) {
  const n = Number(raw) / 10 ** decimals;
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function render(r, decimals) {
  console.log(`sources: ${r.sourcesAnswered}/${r.sourcesTried} answered`);
  console.log(`ranked on: ${r.rankedOn}\n`);

  if (!r.routes.length) {
    console.log("no source returned a usable route.");
    for (const f of r.failed) console.log(`  ${f.source}: ${f.error}`);
    return;
  }

  const w = Math.max(...r.routes.map((x) => x.source.length), 6);
  console.log(`  ${"source".padEnd(w)}  ${"net out".padStart(14)}  ${"gross".padStart(14)}  cost`);
  for (const [i, x] of r.routes.entries()) {
    const mark = i === 0 ? "*" : " ";
    const cost =
      x.gasUsd == null
        ? "gas unknown"
        : x.gasUsd === 0
          ? "gasless (solver)"
          : `$${Number(x.gasUsd + (x.feeUsd ?? 0)).toFixed(2)}`;
    const dur = x.meta?.durationSeconds != null ? `  ~${x.meta.durationSeconds}s` : "";
    console.log(
      `${mark} ${x.source.padEnd(w)}  ${fmt(x.netOut, decimals).padStart(14)}  ` +
        `${fmt(x.grossOut, decimals).padStart(14)}  ${cost}${dur}`,
    );
  }

  for (const f of r.failed) console.log(`  ${f.source.padEnd(w)}  FAILED: ${String(f.error).slice(0, 60)}`);

  console.log(`\n${r.note}`);
  for (const wn of r.warnings) console.log(`\nWARNING: ${wn}`);
}

try {
  switch (cmd) {
    case "swap": {
      const cid = chainId(args[0]);
      if (!args[1] || !args[2]) die("usage: oracle-route swap <chain> <tokenIn> <tokenOut> [amountIn]");
      const amountIn = args[3] || (10n ** 18n).toString();
      const scanner = getScanner(cid);

      // Decimals matter twice: ParaSwap needs them to quote at all, and the ranker
      // needs the destination's to convert gas into output units.
      const [dIn, dOut] = await Promise.all([
        scanner.resolveToken(args[1]).then((t) => t.decimals).catch(() => null),
        scanner.resolveToken(args[2]).then((t) => t.decimals).catch(() => null),
      ]);

      const r = await bestSwapRoute({
        chainId: cid,
        tokenIn: args[1],
        tokenOut: args[2],
        amountIn,
        taker: args[4] || "0x000000000000000000000000000000000000dEaD",
        decimalsIn: dIn,
        decimalsOut: dOut,
      });
      if (JSON_OUT) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      else render(r, dOut ?? 18);
      break;
    }

    case "bridge": {
      const from = chainId(args[0]);
      const to = chainId(args[1]);
      const token = args[2] || NATIVE;
      const amountIn = args[3] || (10n ** 18n).toString();

      const r = await bestBridgeRoute({
        fromChainId: from,
        toChainId: to,
        tokenIn: token,
        tokenOut: token,
        amountIn,
        taker: args[4] || "0x000000000000000000000000000000000000dEaD",
        decimalsOut: 18,
      });
      if (JSON_OUT) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      else render(r, 18);
      break;
    }

    case "prepare": {
      const cid = chainId(args[0]);
      if (!args[1] || !args[2] || !args[3]) {
        die("usage: oracle-route prepare <chain> <tokenIn> <tokenOut> <taker> [amountIn] [--source=X]");
      }
      // Argument order puts taker BEFORE amount deliberately: preparing without a
      // real taker is the one mistake that cannot be recovered from downstream.
      const taker = args[3];
      const amountIn = args[4] || (10n ** 18n).toString();
      const srcArg = rest.find((a) => a.startsWith("--source="));
      const scanner = getScanner(cid);

      const [dIn, dOut] = await Promise.all([
        scanner.resolveToken(args[1]).then((t) => t.decimals).catch(() => null),
        scanner.resolveToken(args[2]).then((t) => t.decimals).catch(() => null),
      ]);

      const r = await prepareBestRoute({
        chainId: cid,
        tokenIn: args[1],
        tokenOut: args[2],
        amountIn,
        taker,
        decimalsIn: dIn,
        decimalsOut: dOut,
        source: srcArg ? srcArg.split("=")[1] : undefined,
      });

      if (JSON_OUT) {
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        break;
      }

      if (!r.ok) {
        console.log(`could not prepare: ${r.reason}`);
        if (r.failureKind) console.log(`kind: ${r.failureKind}`);
        if (r.alternative) console.log(`try: --source=${r.alternative}`);
        process.exit(1);
      }

      console.log(`source:      ${r.chosen.source}${r.chosen.wasWinner ? " (winner)" : " (override -- NOT the winner)"}`);
      console.log(`artifact:    ${r.artifactKind}`);
      console.log(`destination: ${r.destination}`);
      if (r.minOut) console.log(`minOut:      ${r.minOut}`);
      if (r.driftBps != null) console.log(`drift:       ${(r.driftBps / 100).toFixed(3)}% vs comparison`);
      if (r.requiresApproval) {
        console.log(`\napproval required first:`);
        console.log(`  token   ${r.requiresApproval.token}`);
        console.log(`  spender ${r.requiresApproval.spender}`);
        if (r.requiresApproval.note) console.log(`  note    ${r.requiresApproval.note}`);
      }
      if (r.runnersUp?.length) {
        console.log(`\nrunners-up: ${r.runnersUp.map((x) => x.source).join(", ")}`);
      }
      for (const w of r.warnings) console.log(`\nWARNING: ${w}`);
      console.log(`\n${r.note}`);
      break;
    }

    case "prepare-bridge": {
      const from = chainId(args[0]);
      const to = chainId(args[1]);
      if (!args[2]) die("usage: oracle-route prepare-bridge <fromChain> <toChain> <taker> [token] [amountIn] [--source=X]");
      const taker = args[2];
      const token = args[3] || NATIVE;
      const amountIn = args[4] || (10n ** 17n).toString();
      const srcArg = rest.find((a) => a.startsWith("--source="));

      const r = await prepareBestBridgeRoute({
        fromChainId: from,
        toChainId: to,
        tokenIn: token,
        tokenOut: token,
        amountIn,
        taker,
        decimalsOut: 18,
        source: srcArg ? srcArg.split("=")[1] : undefined,
      });

      if (JSON_OUT) {
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        break;
      }
      if (!r.ok) {
        console.log(`could not prepare: ${r.reason}`);
        if (r.failureKind) console.log(`kind: ${r.failureKind}`);
        if (r.alternative) console.log(`try: --source=${r.alternative}`);
        process.exit(1);
      }

      console.log(`source:      ${r.chosen.source}${r.chosen.wasWinner ? " (winner)" : " (override -- NOT the winner)"}`);
      console.log(`artifact:    ${r.artifactKind}`);
      console.log(`route:       chain ${r.fromChainId} -> chain ${r.toChainId}`);
      console.log(`signs:       ${r.transactionCount} transaction(s) on chain ${r.fromChainId}`);
      console.log(`destination: ${r.destination}`);
      if (r.minOut) console.log(`minOut:      ${r.minOut}`);
      if (r.durationSeconds != null) console.log(`eta:         ~${r.durationSeconds}s to credit`);
      if (r.driftBps != null) console.log(`drift:       ${(r.driftBps / 100).toFixed(3)}% vs comparison`);
      if (r.requiresApproval) {
        console.log(`\napproval required first:`);
        console.log(`  token   ${r.requiresApproval.token}`);
        console.log(`  spender ${r.requiresApproval.spender}`);
      }
      r.transactions.forEach((t, i) => {
        console.log(`\ntx ${i + 1}/${r.transactionCount}: chain ${t.chainId} -> ${t.to}`);
      });
      if (r.runnersUp?.length) console.log(`\nrunners-up: ${r.runnersUp.map((x) => x.source).join(", ")}`);
      for (const w of r.warnings) console.log(`\nWARNING: ${w}`);
      console.log(`\n${r.note}`);
      break;
    }

    default:
      console.log(
        [
          "oracle-route -- best-execution routing",
          "",
          "  oracle-route swap   <chain> <tokenIn> <tokenOut> [amountIn] [taker]",
          "  oracle-route bridge <fromChain> <toChain> [token] [amountIn] [taker]",
          "  oracle-route prepare <chain> <tokenIn> <tokenOut> <taker> [amountIn] [--source=X]",
          "  oracle-route prepare-bridge <fromChain> <toChain> <taker> [token] [amt] [--source=X]",
          "",
          "  Ranks by NET output (gross minus gas and fees), not headline quote.",
          "  A route quoting more but costing more gas can lose. --json for detail.",
        ].join("\n"),
      );
      process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  die(String(err?.message || err));
}
