// Transaction policy layer — enforced INSIDE the exec-server before any sign or
// broadcast, so token possession alone (stolen from /proc, a peer agent process,
// an injected subagent, or a tailnet peer) cannot produce an arbitrary drain.
// This is the belt that bounds the blast radius of every gate/token bypass.
//
// All limits are config via exec.env (loaded into the exec-server env):
//   MAD_ALLOWED_CHAINS      csv chainIds (default: the registered set)
//   MAD_MAX_TX_VALUE_WEI    max native value per tx (default: 0.05 ETH-scale)
//   MAD_MAX_DAILY_VALUE_WEI max native value per rolling 24h (default: 0.15)
//   MAD_MAX_GAS_LIMIT       max gasLimit per signed/broadcast tx (default: 5m)
//   MAD_MAX_TX_FEE_WEI      max gasLimit*feePerGas when fee fields are present
//   MAD_DEST_ALLOWLIST      csv lowercased addresses; empty = any dest allowed
//   MAD_POLICY_STATE        path to the daily-spend ledger (default alongside env)
//
// Native-value caps bound native drains. The destination allowlist (when set)
// is the strong control for arbitrary-contract/ERC20 drains — enable it with the
// venues you actually trade through for a hard bound.

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { isSwapVenue, venuesFor } from "./venues.mjs";
import { csvEnv, env, configPath } from "./oracle-env.mjs";
import { assertAutoSlippageGuard } from "./auto-slippage.mjs";
import { assertApprovalGuard, isApprovalCall } from "./approval-guard.mjs";
import { assertTokenTransferGuard, isTokenTransferCall } from "./token-transfer-guard.mjs";
import { assertRouteAttestation } from "./route-attestation.mjs";
import { assertVaultAttestation } from "./vault-attestation.mjs";
import { assertGmxOrderAttestation, isGmxExchangeRouter } from "./gmx-attestation.mjs";

const DEFAULT_CHAINS = [1, 8453, 42161, 137, 10, 56, 43114, 999, 4663, 2741, 988];

function csvSet(primary, legacy) {
  return new Set(
    csvEnv(primary, legacy)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function allowedChains() {
  const raw = String(env("ORACLE_ALLOWED_CHAINS", "MAD_ALLOWED_CHAINS", "")).trim();
  if (!raw) return new Set(DEFAULT_CHAINS.map(Number));
  return new Set(raw.split(",").map((s) => Number(s.trim())).filter(Number.isFinite));
}

function bigEnv(primary, legacy, fallback) {
  const v = String(env(primary, legacy, "")).trim();
  try {
    return v ? BigInt(v) : BigInt(fallback);
  } catch {
    return BigInt(fallback);
  }
}

// 0.05 / 0.15 in 1e18 units — generous but bounds a catastrophic drain. Tune in exec.env.
function maxTxValue() {
  return bigEnv("ORACLE_MAX_TX_VALUE_WEI", "MAD_MAX_TX_VALUE_WEI", "50000000000000000");
}
function maxDailyValue() {
  return bigEnv("ORACLE_MAX_DAILY_VALUE_WEI", "MAD_MAX_DAILY_VALUE_WEI", "150000000000000000");
}
function maxGasLimit() {
  return bigEnv("ORACLE_MAX_GAS_LIMIT", "MAD_MAX_GAS_LIMIT", "5000000");
}
function maxTxFeeWei() {
  return bigEnv("ORACLE_MAX_TX_FEE_WEI", "MAD_MAX_TX_FEE_WEI", "5000000000000000");
}

function statePath() {
  return configPath("policy-daily.json", "ORACLE_POLICY_STATE", "MAD_POLICY_STATE");
}

function toWei(v) {
  if (v == null) return 0n;
  // A value this function cannot parse must NOT be treated as zero. Returning
  // 0n on failure made every native-value cap fail OPEN: a tx carrying
  // "999999999999999999999999.5" was scored as value=0 and sailed past the
  // per-tx and daily ceilings. An unparseable amount is a policy error.
  if (typeof v === "number") {
    if (!Number.isInteger(v) || !Number.isSafeInteger(v)) {
      throw new Error(
        `exec-policy: value ${v} is not an exact integer — pass wei as a decimal string or BigInt`
      );
    }
  }
  try {
    if (typeof v === "string" && v.startsWith("0x")) return BigInt(v);
    return BigInt(v);
  } catch {
    throw new Error(`exec-policy: cannot interpret ${JSON.stringify(String(v))} as an integer wei amount`);
  }
}

function optionalBig(value, label) {
  if (value == null || value === "") return null;
  try {
    const n = typeof value === "string" && value.startsWith("0x") ? BigInt(value) : BigInt(value);
    if (n < 0n) throw new Error("negative");
    return n;
  } catch {
    throw new Error(`policy: ${label} must be a non-negative integer`);
  }
}

function enforceGasPolicy(tx = {}) {
  const gasLimit = optionalBig(tx.gasLimit ?? tx.gas, "gasLimit");
  if (gasLimit != null) {
    const cap = maxGasLimit();
    if (gasLimit > cap) {
      throw new Error(`policy: gasLimit ${gasLimit} exceeds cap ${cap} (ORACLE_MAX_GAS_LIMIT)`);
    }
  }

  const feePerGas = optionalBig(tx.maxFeePerGas ?? tx.gasPrice, "maxFeePerGas/gasPrice");
  if (gasLimit != null && feePerGas != null) {
    const maxFee = gasLimit * feePerGas;
    const cap = maxTxFeeWei();
    if (maxFee > cap) {
      throw new Error(`policy: gas fee ceiling ${maxFee} exceeds max tx fee ${cap} (ORACLE_MAX_TX_FEE_WEI)`);
    }
  }
}

let ledgerDegraded = false;

function readDaily() {
  const fresh = () => ({ windowStart: Date.now(), spentWei: "0" });
  let onDisk;
  try {
    onDisk = JSON.parse(readFileSync(statePath(), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fresh();
    ledgerDegraded = true;
    throw new Error(`policy: daily spend ledger cannot be read or is corrupt: ${error?.message || error}`);
  }
  const windowStart = Number(onDisk?.windowStart);
  let spentWei;
  try {
    spentWei = BigInt(onDisk?.spentWei);
  } catch {
    ledgerDegraded = true;
    throw new Error("policy: daily spend ledger is corrupt: invalid spentWei");
  }
  if (!Number.isFinite(windowStart) || windowStart <= 0 || spentWei < 0n) {
    ledgerDegraded = true;
    throw new Error("policy: daily spend ledger is corrupt: invalid window");
  }
  if (Date.now() - windowStart > 24 * 60 * 60 * 1000) return fresh();
  ledgerDegraded = false;
  return { windowStart, spentWei: spentWei.toString() };
}

function writeDaily(d) {
  const target = statePath();
  const temp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(temp, JSON.stringify(d), { mode: 0o600 });
    renameSync(temp, target);
    ledgerDegraded = false;
  } catch (err) {
    ledgerDegraded = true;
    try { unlinkSync(temp); } catch {}
    throw new Error(`policy: daily spend ledger cannot be written or persisted: ${err?.message || err}`);
  }
}

function withDailyLedgerLock(fn) {
  const target = statePath();
  const lock = `${target}.lock`;
  const ownerPath = join(lock, "owner.json");

  function writeOwner() {
    writeFileSync(
      ownerPath,
      JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }),
      { mode: 0o600 },
    );
  }


  function removeLockTree() {
    rmSync(lock, { recursive: true, force: true });
  }

  function tryAcquire() {
    mkdirSync(dirname(target), { recursive: true });
    mkdirSync(lock, { mode: 0o700 });
    try {
      writeOwner();
    } catch (error) {
      try {
        removeLockTree();
      } catch (cleanupError) {
        throw new Error(
          `owner metadata write failed (${error?.message || error}); ` +
          `new lock cleanup also failed (${cleanupError?.message || cleanupError})`
        );
      }
      throw error;
    }
  }

  try {
    tryAcquire();
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw new Error(`policy: daily spend ledger lock cannot be acquired: ${error?.message || error}`);
    }
    // Never auto-reclaim an apparently stale lock. A check-then-delete flow has
    // an ABA race: another process can acquire a fresh lock after our stale
    // observation and have that new lock deleted underneath it. Funds safety
    // wins over liveness; an operator must verify no holder is active and remove
    // the stale directory out of band.
    throw new Error(
      `policy: daily spend ledger lock is busy or stale at ${lock}; manual operator recovery required`
    );
  }

  try {
    return fn();
  } finally {
    try {
      removeLockTree();
    } catch (error) {
      ledgerDegraded = true;
      throw new Error(`policy: daily spend ledger lock cannot be released: ${error?.message || error}`);
    }
  }
}

/** True when the on-disk ledger could not be persisted this run. */
export function dailyLedgerDegraded() {
  return ledgerDegraded;
}

/**
 * When the durable ledger cannot be committed, the daily cap survives only as
 * long as this process. A restart silently resets it to a fresh zero-spend
 * window — so "degraded" is a cap that an attacker (or a crash loop) can clear
 * on demand. Default to REFUSING to sign in that state; an operator who
 * genuinely wants memory-only accounting must say so explicitly.
 */
function assertLedgerDurable(phase) {
  if (!ledgerDegraded) return;
  if (String(process.env.ORACLE_ALLOW_EPHEMERAL_CAPS || "") === "1") return;
  throw new Error(
    `policy: refusing to ${phase} — the daily spend ledger at ${statePath()} is not writable, ` +
      `so the daily cap would reset on restart. Fix the path, or set ` +
      `ORACLE_ALLOW_EPHEMERAL_CAPS=1 to accept memory-only caps.`
  );
}

/**
 * Enforce policy on a would-be sign/broadcast. Throws on violation.
 * @param {object} tx  { chainId, to, value, data }
 * @param {"sign"|"broadcast"} phase
 */
export function enforceTxPolicy(tx = {}, phase = "broadcast") {
  const normalizedPhase = String(phase ?? "").trim().toLowerCase();
  if (normalizedPhase !== "sign" && normalizedPhase !== "broadcast") {
    throw new Error(`policy: unknown phase ${JSON.stringify(phase)}, expected "sign" or "broadcast"`);
  }
  phase = normalizedPhase;
  assertLedgerDurable(phase);
  const chainId = Number(tx.chainId);
  if (!allowedChains().has(chainId)) {
    throw new Error(`policy: chainId ${chainId} not in ORACLE_ALLOWED_CHAINS`);
  }

  // Effective destination allowlist = env global allowlist UNION this chain's
  // vetted venues (venues.mjs). Venues come from a curated, code-reviewed map,
  // never from the tx itself -- so a new chain gains destinations only when its
  // venues are explicitly added. If BOTH sources are empty, every destination
  // is refused unless a valid route/vault attestation supplies the bound path.
  const to = String(tx.to || "").toLowerCase();
  const data = String(tx.data || "0x").toLowerCase();
  const approvalLike = data !== "0x" && isApprovalCall(data);

  // Native tx.value caps are not enough: a malicious signed transaction can try
  // to drain through oversized gasLimit / fee fields even with value=0.
  enforceGasPolicy(tx);

  // ERC-20 approvals are value=0 calls to the token contract, not the swap
  // router. They cannot be authorized by the token destination alone. Require a
  // bounded approval guard that binds exact token/spender/amount/chain/expiry,
  // and require the spender/route venue to be in the reviewed venue registry.
  if (approvalLike) {
    assertApprovalGuard(tx.madApproval || tx.approvalGuard, { ...tx, chainId, to, data }, { chainId });
  }

  // ERC-20 transfers are the other value=0 drain path. Native caps never see
  // them, and a token address in the venue registry is not consent to send its
  // balance anywhere. Bind the exact recipient + amount at the final policy gate.
  if (!approvalLike && data !== "0x" && isTokenTransferCall(data)) {
    assertTokenTransferGuard(tx.madTokenTransfer || tx.tokenTransferGuard, { ...tx, chainId, to, data }, { chainId });
  }

  // GMX v2 ExchangeRouter orders are asynchronous, keeper-executed intents. The
  // ExchangeRouter is a vetted destination, but raw multicall calldata there can
  // create/cancel/update orders with account risk. Require a signer-bound order
  // attestation that binds the exact multicall hash, account, collateral,
  // acceptable price, size, execution fee, and chain before signing.
  if (!approvalLike && to && isGmxExchangeRouter(chainId, to)) {
    assertGmxOrderAttestation(tx.madGmx || tx.gmxGuard, { ...tx, chainId, to, data }, { chainId });
  }

  const destAllow = csvSet("ORACLE_DEST_ALLOWLIST", "MAD_DEST_ALLOWLIST");
  for (const v of venuesFor(chainId)) destAllow.add(v);

  // Contract CREATION (no `to`) has no destination to check, so it fell through
  // the allowlist entirely — the one shape that skips the strongest control we
  // have. A deploy can carry native value and, once mined, the resulting
  // contract is an arbitrary destination that was never reviewed. /exec/prepare
  // rejects a missing `to`, but /exec/sign and /exec/broadcast accept a raw tx
  // object, so prepare's check is not a real boundary.
  //
  // Deploys are therefore opt-in: ORACLE_ALLOW_CREATE=1 (or MAD_ALLOW_CREATE=1),
  // and even when allowed they may not carry native value.
  const isCreate = !tx.to || String(tx.to).trim() === "";
  if (isCreate) {
    const createAllowed =
      String(env("ORACLE_ALLOW_CREATE", "MAD_ALLOW_CREATE", "0")).trim() === "1";
    if (!createAllowed) {
      throw new Error(
        "policy: contract creation (tx without `to`) is disabled — set ORACLE_ALLOW_CREATE=1 to permit deploys"
      );
    }
    if (toWei(tx.value) > 0n) {
      throw new Error("policy: contract creation may not carry native value");
    }
  }

  // Fail CLOSED. README and SECURITY both state that an empty allowlist refuses
  // everything; the previous "no dest restriction applies" branch made an
  // unconfigured deployment maximally permissive at exactly the moment the
  // operator had configured the least. A destination must be positively
  // allowlisted, or carry a route/vault attestation.
  //
  // Approvals used to skip this check (`!approvalLike`). That meant any
  // unreviewed contract whose calldata started with an allowance selector
  // bypassed the strongest control in the file — assertApprovalGuard binds the
  // spender, not the `to` address. The token being approved is a destination
  // like any other: it must be allowlisted or carry a route/vault attestation.
  if (to && !destAllow.has(to)) {
    const madRoute = tx.madRoute || tx.routeAttestation;
    const madVault = tx.madVault || tx.vaultGuard;
    if (!madRoute && !madVault) {
      if (destAllow.size === 0) {
        throw new Error(
          `policy: no destination allowlist configured for chain ${chainId} — set ORACLE_DEST_ALLOWLIST or add the chain's venues before sending`
        );
      }
      throw new Error(`policy: destination ${to} not allowlisted for chain ${chainId} (env ORACLE_DEST_ALLOWLIST or venues.mjs)`);
    }
    if (madRoute) assertRouteAttestation(madRoute, { ...tx, chainId, to, data }, { chainId });
    else assertVaultAttestation(madVault, { ...tx, chainId, to, data }, { chainId });
  }

  // Every market-sensitive contract call must prove that its output floor came
  // from a fresh automatic quote and is bounded to <= 100 bps. This check runs
  // at both sign and broadcast, so raw prepared calldata cannot bypass it.
  if (to && data !== "0x" && isSwapVenue(chainId, to)) {
    try {
      // Bind the guard to THIS calldata, not just to the venue. Without the tx
      // the guard only proved internal consistency, so one correctly signed
      // guard from a trivial quote authorized a swap of any size with zero
      // output protection at the same venue.
      assertAutoSlippageGuard(tx.slippageGuard ?? tx.madSlippage, {
        chainId,
        venue: to,
        tx: { ...tx, chainId, to, data },
        requireSigned: true,
      });
    } catch (error) {
      const message = String(error?.message || error);
      if (/required/.test(message)) throw error;
      throw new Error(`policy: ${message}`);
    }
  }

  // Spending caps toggle. Set MAD_VALUE_CAPS_ENABLED=0 in exec.env to lift the
  // per-tx + daily native caps (chain/dest allowlists still enforced). Flip back
  // to 1 to re-arm the cap wall. Default = ON when unset.
  //
  // Deliberately strict: ONLY the literal "0" lifts the caps. This is the
  // opposite polarity from a kill switch. Disabling a kill switch makes a
  // deployment safer, so it accepts 0/false/off/no. Disabling THIS makes a
  // deployment riskier, so a stray "false" must keep the cap wall standing
  // rather than silently removing it. Do not route this through envEnabled.
  const capsOn = String(env("ORACLE_VALUE_CAPS_ENABLED", "MAD_VALUE_CAPS_ENABLED", "1")).trim() !== "0";
  if (!capsOn) return true;

  const value = toWei(tx.value);
  const perTx = maxTxValue();
  if (value > perTx) {
    throw new Error(
      `policy: tx value ${value} exceeds per-tx cap ${perTx} (ORACLE_MAX_TX_VALUE_WEI)`
    );
  }

  // Daily aggregate only meaningfully applies to actual broadcast.
  if (phase === "broadcast" && value > 0n) {
    withDailyLedgerLock(() => {
      const daily = readDaily();
      const spent = toWei(daily.spentWei);
      const cap = maxDailyValue();
      if (spent + value > cap) {
        throw new Error(
          `policy: daily native spend ${spent + value} would exceed cap ${cap} (ORACLE_MAX_DAILY_VALUE_WEI)`
        );
      }
      writeDaily({ windowStart: daily.windowStart, spentWei: (spent + value).toString() });
    });
  }

  return true;
}
