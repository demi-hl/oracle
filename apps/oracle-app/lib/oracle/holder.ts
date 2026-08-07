/**
 * Holder status for the desktop app.
 *
 * Transfer model: Oracle checks the ONE wallet it is configured with (the agent
 * wallet from `oracle init`, or an imported one) and asks whether a Locals Only
 * NFT sits in it. The NFT must actually be held by that address, so unlocking
 * means transferring it there.
 *
 * This mirrors the CLI chokepoint in packages/oracle/src/cli/holder-access.mjs
 * so both surfaces answer the same question the same way. Worth stating plainly:
 * this runs on the user's machine and is a licence check, not a wall. It gates
 * FEATURES, never installation — the install itself must never be locked.
 *
 * Failure to reach the RPC is reported as unverifiable, not as a denial. Losing
 * HyperEVM for a minute should not lock a holder out of software they own.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const LOCALS_ONLY_CONTRACT = "0x62FCFAf7573AD8B41a0FBF347AfEb85e06599A75";
export const LOCALS_ONLY_CHAIN_ID = 999;
export const LOCALS_ONLY_RPC = "https://rpc.hyperliquid.xyz/evm";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export type HolderStatus = {
  configured: boolean;
  address: string | null;
  holder: boolean;
  balance: string;
  verified: boolean;
  reason: "no-wallet" | "holder" | "denied" | "unverifiable" | "bypass" | "operator";
  contract: string;
  chainId: number;
};

export function isAddress(value: unknown): boolean {
  return ADDRESS_RE.test(String(value ?? ""));
}

/**
 * Is the unpublished operator (admin) package present?
 *
 * Operator is never published to npm, so its presence is itself the privilege
 * signal: it is the component that holds keys and signs. Requiring the admin to
 * also hold a Locals Only NFT would gate the operator of the system behind a
 * token meant for its users.
 */
export function hasOperator(binDir = process.env.ORACLE_OPERATOR_BIN_DIR): boolean {
  const candidates = [
    binDir,
    path.join(homedir(), ".local", "share", "oracle-operator", "node_modules", "@oracle-agent", "operator"),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    try {
      if (existsSync(path.join(dir, "package.json")) || existsSync(dir)) return true;
    } catch {
      // Unreadable candidate is not a denial; try the next one.
    }
  }
  return false;
}

function execEnvPath(): string {
  const override = process.env.ORACLE_CONFIG_DIR?.trim();
  const dir = override || path.join(homedir(), ".config", "oracle");
  return path.join(dir, "exec.env");
}

/**
 * The single address Oracle checks. Same file and key the CLI reads, so the app
 * and CLI can never disagree about which wallet is being gated.
 */
export function configuredAddress(envPath: string = execEnvPath()): string | null {
  if (!existsSync(envPath)) return null;
  try {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
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

/**
 * Live ERC-721 balanceOf via raw JSON-RPC.
 *
 * Hand-encoded rather than pulling ethers into the app bundle: one function,
 * one static selector, no ABI machinery needed.
 */
export async function holderBalance(
  address: string,
  { rpc = LOCALS_ONLY_RPC, contract = LOCALS_ONLY_CONTRACT, timeoutMs = 8000 } = {},
): Promise<bigint> {
  const selector = "0x70a08231"; // balanceOf(address)
  const data = selector + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: contract, data }, "latest"],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`rpc ${response.status}`);
    const body = (await response.json()) as { result?: string; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message || "rpc error");
    if (!body.result || body.result === "0x") return 0n;
    return BigInt(body.result);
  } finally {
    clearTimeout(timer);
  }
}

export async function getHolderStatus({
  address = configuredAddress(),
  balanceOf = holderBalance,
  env = process.env,
  operator = hasOperator,
}: {
  address?: string | null;
  balanceOf?: (a: string) => Promise<bigint>;
  env?: NodeJS.ProcessEnv;
  operator?: () => boolean;
} = {}): Promise<HolderStatus> {
  const base = {
    contract: LOCALS_ONLY_CONTRACT,
    chainId: LOCALS_ONLY_CHAIN_ID,
  };

  // Same operator escape hatch the CLI honours, so CI and our own smokes can
  // exercise gated surfaces without holding an NFT.
  if (env.ORACLE_GATE_BYPASS === "1") {
    return { ...base, configured: true, address, holder: true, balance: "0", verified: false, reason: "bypass" };
  }

  // Admin component present means privileged access already. See hasOperator().
  if (operator()) {
    return { ...base, configured: true, address, holder: true, balance: "0", verified: false, reason: "operator" };
  }

  if (!address) {
    return { ...base, configured: false, address: null, holder: false, balance: "0", verified: false, reason: "no-wallet" };
  }

  try {
    const balance = await balanceOf(address);
    const holder = balance > 0n;
    return {
      ...base,
      configured: true,
      address,
      holder,
      balance: String(balance),
      verified: true,
      reason: holder ? "holder" : "denied",
    };
  } catch {
    // Cannot check is not the same as no.
    return { ...base, configured: true, address, holder: false, balance: "0", verified: false, reason: "unverifiable" };
  }
}
