/**
 * oracle gate — Locals Only holder check.
 *
 * Checks whether a wallet holds a Locals Only NFT on HyperEVM. Two modes:
 *
 *   oracle gate status              check the configured agent wallet
 *   oracle gate check <address>     check any address
 *
 * Honesty note, stated plainly because it decides how much this command is
 * worth: this is a LOCAL check on the user's own machine. It reads a public
 * `balanceOf` and reports the answer. It is not, and cannot be, enforcement —
 * anyone running the CLI can edit it. Real enforcement lives in the
 * distribution gate (bin/oracle-gate-server.mjs), which runs on a server the
 * operator controls and requires a signature proving wallet control before it
 * hands out an install.
 *
 * What this command IS good for: telling an honest user, before they get
 * confused, whether the wallet they configured actually holds the token.
 */

import { readFileSync, existsSync } from "node:fs";
import {
  holderBalance,
  isAddress,
  LOCALS_ONLY_CONTRACT,
  LOCALS_ONLY_CHAIN_ID,
} from "../../gate/holder-gate.mjs";
import { oracleExecEnvPath } from "../paths.mjs";

const HELP = `oracle gate — Locals Only holder check

  oracle gate status            check the configured agent wallet
  oracle gate check <address>   check any address
  oracle gate info              show the gate contract

Access to Oracle is granted by holding a Locals Only NFT. This command reads a
public balanceOf on HyperEVM; it does not sign, and it never sees a key.

This is a local convenience check. Enforcement happens at distribution, where a
signature proves you control the wallet before an install is issued.`;

/** Read the agent wallet address from the local exec env, if configured. */
export function agentAddress(envPath = oracleExecEnvPath()) {
  if (!existsSync(envPath)) return null;
  try {
    const body = readFileSync(envPath, "utf8");
    for (const line of body.split("\n")) {
      const match = line.match(/^\s*(?:export\s+)?ORACLE_EVM_ADDRESS\s*=\s*(.+)\s*$/);
      if (!match) continue;
      const value = match[1].trim().replace(/^["']|["']$/g, "");
      if (isAddress(value)) return value;
    }
  } catch {
    return null;
  }
  return null;
}

function line(out, text) {
  out.write(text + "\n");
}

export async function run(argv = [], io = {}) {
  const out = io.out ?? process.stdout;
  const err = io.err ?? process.stderr;
  const balanceOf = io.balanceOf ?? holderBalance;
  const sub = argv[0];

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    line(out, HELP);
    return 0;
  }

  if (sub === "info") {
    line(out, `contract: ${LOCALS_ONLY_CONTRACT}`);
    line(out, `chain:    HyperEVM (${LOCALS_ONLY_CHAIN_ID})`);
    line(out, `token:    Locals Only (LOCALS)`);
    return 0;
  }

  let address;
  if (sub === "status") {
    address = io.agentAddress ? io.agentAddress() : agentAddress();
    if (!address) {
      line(err, "no agent wallet configured (ORACLE_EVM_ADDRESS not set)");
      line(err, "run: oracle init");
      return 1;
    }
  } else if (sub === "check") {
    address = argv[1];
    if (!isAddress(address)) {
      line(err, "usage: oracle gate check <0x address>");
      return 2;
    }
  } else {
    line(err, `oracle gate: unknown subcommand '${sub}'`);
    return 2;
  }

  let balance;
  try {
    balance = await balanceOf(address);
  } catch (error) {
    // A gate that reports "no" when it actually means "could not check" would
    // tell a real holder they are locked out. Say which one it is.
    line(err, `could not reach HyperEVM to check the gate: ${error.message}`);
    return 3;
  }

  if (BigInt(balance) > 0n) {
    line(out, `holder: yes (${balance})`);
    line(out, `wallet: ${address}`);
    return 0;
  }

  line(out, "holder: no");
  line(out, `wallet: ${address}`);
  line(out, "");
  line(out, `Oracle access requires a Locals Only NFT on HyperEVM.`);
  line(out, `contract: ${LOCALS_ONLY_CONTRACT}`);
  return 4;
}

export const help = "check Locals Only holder access for a wallet";

export default {
  name: "gate",
  summary: "check Locals Only holder access for a wallet",
  group: "read",
  usage: HELP,
  async run(ctx) {
    return run(ctx.argv ?? []);
  },
};
