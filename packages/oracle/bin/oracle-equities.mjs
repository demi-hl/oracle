#!/usr/bin/env node
// Crossbook product bin — separate Oracle product for on-chain equities best-ex.
// HIP-3 / Arcus / RH / Solana / TON. Offline fixtures by default. Never signs.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  bestEquityRoute,
  equityVenues,
  prepareEquityRoute,
  toJsonSafe,
} from '../src/equities/index.mjs';
import { toString } from '../src/equities/num.mjs';

function usage() {
  return `oracle equities <command>

Commands:
  venues                         inventory + tiers + liveness snapshot
  quote <TICKER> [options]       rank venues for a ticker (HIP-3, Arcus, RH, Solana, TON)
  prepare <TICKER> --recipient 0x...   prepare unsigned RH Uniswap artifact

Options:
  --size <usd>         notional size for impact model
  --horizon <hours>    enable funding-adjusted heterogeneous ranking
  --json               machine readable output
  --fixtures           offline mode (default in v1)
`;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--fixtures') args.fixtures = true;
    else if (a === '--size') args.size = argv[++i];
    else if (a === '--horizon') args.horizon = argv[++i];
    else if (a === '--recipient') args.recipient = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else args._.push(a);
  }
  return args;
}

function printHumanRank(result) {
  const lines = [];
  lines.push(`oracle equities quote ${result.ticker}`);
  if (result.darkWindow) {
    lines.push(`WARNING: ${result.darkWindow.warning} (session=${result.darkWindow.session})`);
  }
  lines.push(`rankedOn=${result.rankedOn} mix=${result.instrumentMix}`);
  lines.push(
    `sources answered/tried=${result.sourcesAnswered}/${result.sourcesTried} excluded=${result.excluded?.length ?? 0} failed=${result.failed?.length ?? 0}`,
  );
  if (result.winner) {
    lines.push(
      `WINNER  ${result.winner.venue} ${result.winner.instrument} tier=${result.winner.tier} net=${toString(result.winner.net)} costAccounted=${result.winner.costAccounted}`,
    );
  } else {
    lines.push('WINNER  (none)');
  }
  for (const r of (result.runnersUp || []).slice(0, 5)) {
    lines.push(
      `  runner ${r.venue} ${r.instrument} tier=${r.tier} net=${toString(r.net)} costAccounted=${r.costAccounted}`,
    );
  }
  if (result.improvementBps !== null && result.improvementBps !== undefined) {
    lines.push(`improvementBps=${result.improvementBps}`);
  } else {
    lines.push('improvementBps=null (no honest same-class costed comparison)');
  }
  if (result.bestPreparable) {
    lines.push(
      `bestPreparable ${result.bestPreparable.venue} net=${toString(result.bestPreparable.net)}`,
    );
  } else {
    lines.push('bestPreparable (none)');
  }
  if (result.excluded?.length) {
    const byReason = {};
    for (const e of result.excluded) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
    lines.push(`excluded: ${JSON.stringify(byReason)}`);
  }
  return lines.join('\n');
}

function cmdVenues(args) {
  const payload = equityVenues();
  if (args.json) return JSON.stringify(payload, null, 2);
  return [
    'oracle equities venues',
    ...payload.inventory.map(
      (v) => `  ${v.venue.padEnd(22)} tier=${v.tier.padEnd(11)} chain=${String(v.chain).padEnd(16)} n=${v.n}`,
    ),
    `liveness survivors=${payload.liveness.survivors} excluded=${payload.liveness.excluded} ${JSON.stringify(payload.liveness.byReason)}`,
  ].join('\n');
}

function cmdQuote(args) {
  const ticker = args._[1];
  if (!ticker) throw new Error('usage: quote <TICKER>');
  const result = bestEquityRoute({
    ticker,
    sizeUsd: args.size,
    horizonHours: args.horizon,
  });
  if (args.json) return JSON.stringify(toJsonSafe(result), null, 2);
  return printHumanRank(result);
}

function cmdPrepare(args) {
  const ticker = args._[1];
  if (!ticker) throw new Error('usage: prepare <TICKER> --recipient 0x...');
  if (!args.recipient) throw new Error('--recipient is required');
  const out = prepareEquityRoute({
    ticker,
    sizeUsd: args.size,
    recipient: args.recipient,
  });
  if (args.json) return JSON.stringify(toJsonSafe(out), null, 2);
  if (!out.ok) {
    return `prepare ${ticker.toUpperCase()} FAILED (${out.failureKind}): ${out.error || out.note}`;
  }
  const art = out.artifact;
  return [
    `prepare ${ticker.toUpperCase()}`,
    `  chainId=${art.chainId} to=${art.to}`,
    `  requiresWalletSignature=${art.requiresWalletSignature} backendSigner=${art.backendSigner}`,
    `  approval spender=${art.requiresApproval?.spender} token=${art.requiresApproval?.token}`,
    `  quoteAgeMs=${art.quoteAgeMs}`,
    ...(art.notes || []).map((n) => `  note: ${n}`),
  ].join('\n');
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(usage());
    return 0;
  }
  const args = parseArgs(argv);
  const cmd = args._[0];
  let out;
  if (cmd === 'venues') out = cmdVenues(args);
  else if (cmd === 'quote') out = cmdQuote(args);
  else if (cmd === 'prepare') out = cmdPrepare(args);
  else throw new Error(`unknown command ${cmd}\n${usage()}`);
  process.stdout.write(out + '\n');
  return 0;
}

function runningAsMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (runningAsMain()) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(String(error.message || error) + '\n');
    process.exit(1);
  }
}
