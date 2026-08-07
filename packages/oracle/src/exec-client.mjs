/**
 * Exec client — resolves the operator wallet and delegates sign/send/simulate/verify.
 * The operator wallet is local to the user's machine (keyfile or private key).
 * This is the one place that touches private keys — everything else is unsigned.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync, spawnSync } from "node:child_process";

function keyPath(file, env) {
  if (env && existsSync(env)) return env;
  const dir = process.env.ORACLE_CONFIG_DIR || join(homedir(), ".config", "oracle");
  return join(dir, "keys", file);
}

export function resolveExecClient(operator) {
  const evmKey = operator.evmKeyPath || keyPath("evm.json", process.env.ORACLE_EVM_KEY_FILE);
  const solKey = operator.solanaKeyPath || keyPath("solana.json", process.env.ORACLE_SOLANA_KEY_FILE);
  const btcWif = operator.btcWifPath || keyPath("btc.wif", process.env.ORACLE_BTC_WIF_FILE);

  const armed = !!process.env.ORACLE_EXEC_ENABLED || operator.armed === true;
  const chains = operator.chains || [];
  const maxSpendUsd = operator.maxSpendUsd ?? 1000;

  // Use the operator's CLI for signing — never inline key material
  async function sign(chainId, tx) {
    if (!armed) throw new Error("exec plane is not armed — set ORACLE_EXEC_ENABLED=1 in exec.env");
    const r = spawnSync(process.execPath, [
      join(homedir(), ".local", "share", "oracle-stable", "node_modules", "@oracle-agent/oracle", "bin", "oracle.mjs"),
      "sign", "evm",
      "--chain-id", String(chainId),
      "--tx", typeof tx === "string" ? tx : JSON.stringify(tx),
      "--key", process.env.ORACLE_EVM_KEY_FILE || evmKey,
    ], { encoding: "utf8", timeout: 15000 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`sign failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  async function send(chainId, signedTx) {
    if (!armed) throw new Error("exec plane is not armed");
    const r = spawnSync(process.execPath, [
      join(homedir(), ".local", "share", "oracle-stable", "node_modules", "@oracle-agent/oracle", "bin", "oracle.mjs"),
      "send", "evm",
      "--chain-id", String(chainId),
      "--signed-tx", signedTx,
    ], { encoding: "utf8", timeout: 30000 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`send failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  async function simulate(chainId, tx) {
    const r = spawnSync(process.execPath, [
      join(homedir(), ".local", "share", "oracle-stable", "node_modules", "@oracle-agent/oracle", "bin", "oracle.mjs"),
      "simulate", "evm",
      "--chain-id", String(chainId),
      "--tx", typeof tx === "string" ? tx : JSON.stringify(tx),
    ], { encoding: "utf8", timeout: 10000 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`simulate failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  async function verify(chainId, hash) {
    const r = spawnSync(process.execPath, [
      join(homedir(), ".local", "share", "oracle-stable", "node_modules", "@oracle-agent/oracle", "bin", "oracle.mjs"),
      "verify", "evm",
      "--chain-id", String(chainId),
      "--hash", hash,
    ], { encoding: "utf8", timeout: 10000 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`verify failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  return Object.freeze({ sign, send, simulate, verify, armed, chains, maxSpendUsd });
}