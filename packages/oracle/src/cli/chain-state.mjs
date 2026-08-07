import fs from "node:fs";
import path from "node:path";
import { findWorkingChain } from "./chain-catalog.mjs";
import { homeDir, ensureDir, oracleConfigDir } from "./paths.mjs";

export function activeChainPath() {
  return path.join(oracleConfigDir(), "active-chain.json");
}

export function readActiveChain() {
  const p = activeChainPath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!raw || typeof raw !== "object" || !raw.key) return null;
    const chain = findWorkingChain(raw.key);
    if (!chain) return null;
    return {
      key: chain.key,
      chainId: chain.chainId,
      name: chain.name,
      agent: chain.agent,
      selectedAt: raw.selectedAt || null,
    };
  } catch {
    return null;
  }
}

export function writeActiveChain(query) {
  const chain = findWorkingChain(query);
  if (!chain) {
    const err = new Error(`unknown chain '${query}'`);
    err.code = "UNKNOWN_CHAIN";
    throw err;
  }
  ensureDir(oracleConfigDir());
  const payload = {
    key: chain.key,
    chainId: chain.chainId,
    name: chain.name,
    agent: chain.agent,
    selectedAt: new Date().toISOString(),
  };
  fs.writeFileSync(activeChainPath(), JSON.stringify(payload, null, 2) + "\n", {
    mode: 0o600,
  });
  return payload;
}

export function clearActiveChain() {
  const p = activeChainPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return true;
}

export function activeChainEnv(extra = {}) {
  const active = readActiveChain();
  const env = { ...process.env, ...extra };
  if (!active) return env;
  env.ORACLE_ACTIVE_CHAIN = active.key;
  env.ORACLE_ACTIVE_CHAIN_ID = String(active.chainId);
  env.ORACLE_ACTIVE_AGENT = active.agent || "oracle";
  return env;
}

export default {
  activeChainPath,
  readActiveChain,
  writeActiveChain,
  clearActiveChain,
  activeChainEnv,
  homeDir,
};
