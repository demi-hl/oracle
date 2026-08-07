/**
 * CLI holder enforcement.
 *
 * Oracle is gated to Locals Only holders. This module is the single chokepoint
 * the kernel consults before running any gated command.
 *
 * Honest statement of what this is worth, because overselling it would be worse
 * than not shipping it: this runs on the user's machine, so a determined user
 * can patch it out. It is a licence check, not a cryptographic wall. What it
 * DOES do is make holding the NFT the real, enforced path for every ordinary
 * user, and it costs an attacker more than it costs an honest holder. The
 * strong enforcement lives at distribution (bin/oracle-gate-server.mjs), which
 * runs on a server the operator controls and demands a signature.
 *
 * Design rules that keep this from being hostile:
 *   - Commands needed to REACH holder status are never gated. A user who cannot
 *     run `oracle init` can never configure the wallet the gate checks.
 *   - An RPC failure is not a denial. Being unable to check is reported as
 *     such, and the user is let through with a warning rather than locked out
 *     of software they paid for because HyperEVM had a bad minute.
 *   - The result is cached briefly so a chatty session does not hammer the RPC.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import {
  holderBalance,
  isAddress,
  LOCALS_ONLY_CONTRACT,
} from "../gate/holder-gate.mjs";
import { resolveOperator } from "./operator-dispatch.mjs";
import { oracleConfigDir, oracleExecEnvPath } from "./paths.mjs";

/**
 * Commands that must work for a non-holder.
 *
 * Everything here either helps a user become verifiable (init, gate) or is pure
 * metadata (help, version). Gating `init` would be a deadlock: the gate reads
 * the agent wallet that `init` creates.
 */
export const UNGATED_COMMANDS = Object.freeze(new Set([
  "help",
  "version",
  "gate",
  "init",
  "doctor",
  "bootstrap",
  "upgrade",
  // Credentials are a prerequisite for the product working at all, and a user
  // configuring auth has not necessarily configured a wallet yet. Gating this
  // strands people at a step that cannot help them reach holder status.
  "auth",
  "model",
]));

const CACHE_TTL_MS = 10 * 60 * 1000;

function cachePath() {
  return path.join(oracleConfigDir(), "gate-cache.json");
}

export function readCache(now = Date.now(), file = cachePath()) {
  try {
    if (!existsSync(file)) return null;
    const cached = JSON.parse(readFileSync(file, "utf8"));
    if (!cached || typeof cached !== "object") return null;
    if (!Number.isFinite(cached.checkedAt) || now - cached.checkedAt > CACHE_TTL_MS) return null;
    if (!isAddress(cached.address)) return null;
    return cached;
  } catch {
    return null;
  }
}

export function writeCache(entry, file = cachePath()) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(entry), { mode: 0o600 });
  } catch {
    // A cache that cannot be written is not an error worth failing a command on.
  }
}

/** Read the wallet Oracle checks: the agent wallet, or an imported one. */
export function configuredAddress(envPath = oracleExecEnvPath()) {
  if (!existsSync(envPath)) return null;
  try {
    const body = readFileSync(envPath, "utf8");
    for (const line of body.split("\n")) {
      const match = line.match(/^\s*(?:export\s+)?ORACLE_EVM_ADDRESS\s*=\s*(.+?)\s*$/);
      if (!match) continue;
      const value = match[1].trim().replace(/^["']|["']$/g, "");
      if (isAddress(value)) return value;
    }
  } catch {
    return null;
  }
  return null;
}

export const DENIED_MESSAGE = `oracle: this build is for Locals Only holders.

  Oracle checks the agent wallet it created for you, or a wallet you imported.
  Hold a Locals Only NFT in that wallet to use this build.

    contract  ${LOCALS_ONLY_CONTRACT}
    chain     HyperEVM (999)

  Check status:   oracle gate status
  Check a wallet: oracle gate check <address>
`;

export const NO_WALLET_MESSAGE = `oracle: no wallet configured yet.

  Run 'oracle init' to create an agent wallet or import your own, then Oracle
  can verify your Locals Only holding.
`;

/**
 * Decide whether a command may run.
 *
 * Returns { allow, reason, message }. The kernel prints `message` and exits
 * non-zero when `allow` is false.
 */
export async function checkAccess(noun, {
  now = Date.now(),
  address = configuredAddress(),
  balanceOf = holderBalance,
  cache = readCache(now),
  persist = writeCache,
  env = process.env,
  operator = resolveOperator,
} = {}) {
  if (UNGATED_COMMANDS.has(noun)) return { allow: true, reason: "ungated" };

  // Escape hatch for CI and for our own test suites. Deliberately not
  // documented in --help: it is an operator tool, not a user-facing bypass.
  if (env.ORACLE_GATE_BYPASS === "1") return { allow: true, reason: "bypass" };

  // The operator package is the admin component. It is never published, so
  // having it installed already means privileged access — it is the thing that
  // holds keys and signs. Demanding the admin also hold a Locals Only NFT
  // inverts the trust model: it would gate the operator of the system behind a
  // token gate meant for its users, and would lock the owner out of their own
  // executor wallet the moment that NFT moved.
  try {
    if (operator().ok) return { allow: true, reason: "operator" };
  } catch {
    // A resolver failure must not deny access; fall through to the holder path.
  }

  if (!address) {
    return { allow: false, reason: "no-wallet", message: NO_WALLET_MESSAGE };
  }

  if (cache && cache.address.toLowerCase() === address.toLowerCase()) {
    return cache.holder
      ? { allow: true, reason: "cached-holder" }
      : { allow: false, reason: "cached-denied", message: DENIED_MESSAGE };
  }

  let balance;
  try {
    balance = await balanceOf(address);
  } catch (error) {
    // Cannot check is not the same as no. Fail open, loudly.
    return {
      allow: true,
      reason: "unverifiable",
      warning: `oracle: could not verify Locals Only holding (${error.message}); continuing.\n`,
    };
  }

  const holder = BigInt(balance) > 0n;
  persist({ address: address.toLowerCase(), holder, balance: String(balance), checkedAt: now });

  return holder
    ? { allow: true, reason: "holder" }
    : { allow: false, reason: "denied", message: DENIED_MESSAGE };
}
