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
  reason: "no-wallet" | "holder" | "standard-fee" | "unverifiable";
  oracleIntegratorFeeBps: 0 | null;
  contract: string;
  chainId: number;
};

export function isAddress(value: unknown): boolean {
  return ADDRESS_RE.test(String(value ?? ""));
}

function execEnvPath(): string {
  const override = process.env.ORACLE_CONFIG_DIR?.trim();
  const dir = override || path.join(homedir(), ".config", "oracle");
  return path.join(dir, "exec.env");
}

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

export async function holderBalance(
  address: string,
  { rpc = LOCALS_ONLY_RPC, contract = LOCALS_ONLY_CONTRACT, timeoutMs = 8000 } = {},
): Promise<bigint> {
  const selector = "0x70a08231";
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
}: {
  address?: string | null;
  balanceOf?: (a: string) => Promise<bigint>;
} = {}): Promise<HolderStatus> {
  const base = {
    contract: LOCALS_ONLY_CONTRACT,
    chainId: LOCALS_ONLY_CHAIN_ID,
  };

  if (!address) {
    return {
      ...base,
      configured: false,
      address: null,
      holder: false,
      balance: "0",
      verified: false,
      reason: "no-wallet",
      oracleIntegratorFeeBps: null,
    };
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
      reason: holder ? "holder" : "standard-fee",
      oracleIntegratorFeeBps: holder ? 0 : null,
    };
  } catch {
    return {
      ...base,
      configured: true,
      address,
      holder: false,
      balance: "0",
      verified: false,
      reason: "unverifiable",
      oracleIntegratorFeeBps: null,
    };
  }
}
