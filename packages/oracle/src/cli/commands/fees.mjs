import { readFileSync, existsSync } from "node:fs";
import {
  holderBalance,
  isAddress,
  LOCALS_ONLY_CONTRACT,
  LOCALS_ONLY_CHAIN_ID,
} from "../../licensing/locals-only.mjs";
import { oracleExecEnvPath } from "../paths.mjs";

const HELP = `oracle fees — Oracle fee-waiver status

  oracle fees status            check the configured agent wallet
  oracle fees check <address>   check any address
  oracle fees info              show the Locals Only collection

Oracle is public to everyone. A Locals Only NFT only waives Oracle's integrator
fee. This command reads balanceOf on HyperEVM; it does not sign or request keys.`;

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
    line(out, "benefit:  0% Oracle integrator fee");
    line(out, "access:   public to everyone");
    return 0;
  }

  let address;
  if (sub === "status") {
    address = io.agentAddress ? io.agentAddress() : agentAddress();
    if (!address) {
      line(out, "wallet: not configured");
      line(out, "Locals Only fee-waiver status: unavailable");
      line(out, "standard Oracle fee applies when configured");
      line(out, "Oracle access remains public to everyone.");
      return 0;
    }
  } else if (sub === "check") {
    address = argv[1];
    if (!isAddress(address)) {
      line(err, "usage: oracle fees check <0x address>");
      return 2;
    }
  } else {
    line(err, `oracle fees: unknown subcommand '${sub}'`);
    return 2;
  }

  try {
    const balance = await balanceOf(address);
    line(out, `wallet: ${address}`);
    if (BigInt(balance) > 0n) {
      line(out, `Locals Only balance: ${balance}`);
      line(out, "Oracle integrator fee: 0%");
    } else {
      line(out, "Locals Only balance: 0");
      line(out, "standard Oracle fee applies when configured");
    }
    line(out, "Oracle access remains public to everyone.");
    return 0;
  } catch {
    line(out, "Locals Only fee-waiver status: unavailable");
    line(out, "standard Oracle fee applies when configured");
    line(out, "Oracle access remains public to everyone.");
    return 0;
  }
}

export const help = "check Locals Only zero-fee eligibility";

export default {
  name: "fees",
  summary: "check Locals Only zero-fee eligibility",
  group: "read",
  usage: HELP,
  async run(ctx) {
    return run(ctx.argv ?? []);
  },
};
