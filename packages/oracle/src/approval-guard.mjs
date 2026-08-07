import { Interface, MaxUint256, isAddress, keccak256, toUtf8Bytes } from "ethers";
import { venuesFor } from "./venues.mjs";
import { assertVaultApprovalAttestation } from "./vault-attestation.mjs";
import { assertGmxApprovalAttestation } from "./gmx-attestation.mjs";
import { exactBigInt } from "./exact-integer.mjs";
import { assertFreshWindow } from "./fresh-window.mjs";

const DEFAULT_APPROVAL_TTL_MS = 20_000;

const ERC20 = new Interface(["function approve(address spender,uint256 amount) returns (bool)"]);

function normalAddress(value, label) {
  const text = String(value || "").trim();
  if (!isAddress(text)) throw new Error(`${label} must be an address`);
  return text.toLowerCase();
}

function amountString(value, label = "approval amount", { allowZero = false } = {}) {
  // Unsafe JS numbers round UP above 2^53, which would widen the allowance past
  // what the caller wrote. Same class already fixed for ERC-20 transfers.
  const amount = exactBigInt(value, label);
  if (allowZero ? amount < 0n : amount <= 0n) throw new Error(`${label} must be positive`);
  if (amount >= MaxUint256) throw new Error("unlimited approvals are refused; use an exact bounded amount");
  return amount.toString();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Selectors that grant or increase an allowance.
 *
 * Gating only on `approve()` meant every other allowance-granting entrypoint
 * skipped the guard entirely: `increaseAllowance` raises the same allowance,
 * SafeERC20's `forceApprove`/`safeApprove` set one on the caller's behalf,
 * Permit2's `approve`/`permit` grant spend rights, and DAI-style `permit` sets
 * an allowance from a signature. A guard that covers one selector is a guard
 * an attacker routes around.
 *
 * Every value here was computed from its signature with keccak256, not copied
 * from memory — an incorrect selector in this list is a silent hole.
 */
const ALLOWANCE_SELECTORS = new Set([
  "0x095ea7b3", // approve(address,uint256)
  "0x39509351", // increaseAllowance(address,uint256)
  "0x61f49ed6", // forceApprove(address,address,uint256)          [SafeERC20]
  "0xeb5625d9", // safeApprove(address,address,uint256)           [SafeERC20]
  "0xf9255c1f", // safeIncreaseAllowance(address,address,uint256) [SafeERC20]
  "0x87517c45", // approve(address,address,uint160,uint48)        [Permit2]
  "0xd505accf", // permit(address,address,uint256,uint256,uint8,bytes32,bytes32)      [EIP-2612]
  "0x8fcbaf0c", // permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32) [DAI]
  "0x2b67b570", // permit(address,PermitSingle,bytes)             [Permit2]
  "0x2a2d80d1", // permitBatch                                    [Permit2]
]);

export function isApprovalCall(data) {
  const hex = String(data || "").toLowerCase();
  if (hex.length < 10) return false;
  return ALLOWANCE_SELECTORS.has(hex.slice(0, 10));
}

export { ALLOWANCE_SELECTORS };

export function decodeApproveCalldata(data) {
  if (!isApprovalCall(data)) throw new Error("approval calldata required");
  const hex = String(data || "").toLowerCase();
  const selector = hex.slice(0, 10);
  const words = hex.slice(10).match(/.{1,64}/g) || [];
  const wordAddr = (i) => (words[i] ? "0x" + words[i].slice(24) : null);
  const wordBig = (i) => (words[i] ? BigInt("0x" + words[i]) : null);

  // Each allowance-granting shape puts (spender, amount) in different slots.
  // Detecting a selector without being able to decode it made every non-approve
  // allowance call unsignable — the guard recognised the tx, demanded a bound
  // guard, then threw "invalid approve calldata" because it only knew how to
  // read approve(). Recognition and decoding must cover the same set.
  let spenderRaw = null;
  let amountRaw = null;

  switch (selector) {
    // approve(address spender, uint256 value)
    // increaseAllowance(address spender, uint256 addedValue)
    case "0x095ea7b3":
    case "0x39509351":
      spenderRaw = wordAddr(0);
      amountRaw = wordBig(1);
      break;
    // SafeERC20 helpers: (IERC20 token, address spender, uint256 value)
    case "0x61f49ed6": // forceApprove
    case "0xeb5625d9": // safeApprove
    case "0xf9255c1f": // safeIncreaseAllowance
      spenderRaw = wordAddr(1);
      amountRaw = wordBig(2);
      break;
    // EIP-2612 permit(owner, spender, value, deadline, v, r, s)
    case "0xd505accf":
      spenderRaw = wordAddr(1);
      amountRaw = wordBig(2);
      break;
    // DAI permit(holder, spender, nonce, expiry, allowed, v, r, s) — `allowed`
    // is a boolean, so an unlimited allowance is expressed as true.
    case "0x8fcbaf0c": {
      spenderRaw = wordAddr(1);
      const allowed = wordBig(4);
      amountRaw = allowed === 0n ? 0n : (1n << 256n) - 1n;
      break;
    }
    // Permit2 approve(token, spender, uint160 amount, uint48 expiration)
    case "0x87517c45":
      spenderRaw = wordAddr(1);
      amountRaw = wordBig(2);
      break;
    default:
      // A selector we recognise but cannot decode must FAIL, not silently pass:
      // an undecodable allowance cannot be bounded.
      throw new Error(`approval selector ${selector} is recognised but not decodable; refusing to bound it`);
  }

  if (spenderRaw == null || amountRaw == null) throw new Error("invalid approve calldata");
  return {
    spender: normalAddress(spenderRaw, "approval spender"),
    amount: amountString(amountRaw, "approval amount", { allowZero: true }),
    selector,
  };
}

export function normalizeApprovalRequests(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .filter(Boolean)
    .map((approval) => ({
      token: normalAddress(approval.token, "approval token"),
      spender: normalAddress(approval.spender, "approval spender"),
      amount: amountString(approval.amount, "approval amount"),
    }));
}

export function createApprovalGuard({
  chainId,
  token,
  spender,
  amount,
  provider,
  routeVenue,
  routeGuard,
  purpose,
  nowMs = Date.now(),
  ttlMs = DEFAULT_APPROVAL_TTL_MS,
} = {}) {
  const approvalPurpose = String(purpose || "").trim();
  const guard = {
    mode: "approval",
    chainId: Number(chainId),
    token: normalAddress(token, "approval token"),
    spender: normalAddress(spender, "approval spender"),
    amount: amountString(amount, "approval amount", { allowZero: approvalPurpose === "revoke" }),
    provider: String(provider || "").trim() || "unknown",
    routeVenue: routeVenue ? normalAddress(routeVenue, "approval route venue") : normalAddress(spender, "approval route venue"),
    issuedAtMs: Number(nowMs),
    expiresAtMs: Number(nowMs) + Number(ttlMs || DEFAULT_APPROVAL_TTL_MS),
  };
  if (approvalPurpose) guard.purpose = approvalPurpose;
  if (!Number.isFinite(guard.chainId)) throw new Error("approval chainId required");
  if (!Number.isFinite(guard.issuedAtMs) || !Number.isFinite(guard.expiresAtMs) || guard.expiresAtMs <= guard.issuedAtMs) {
    throw new Error("approval guard expiry invalid");
  }
  if (routeGuard) {
    guard.routeGuardHash = keccak256(toUtf8Bytes(canonicalJson(routeGuard)));
  }
  return guard;
}

export function buildApprovalTransaction(approval, {
  chainId,
  provider,
  routeTransaction,
  routeGuard,
  nowMs = Date.now(),
  ttlMs = DEFAULT_APPROVAL_TTL_MS,
} = {}) {
  const [req] = normalizeApprovalRequests(approval);
  if (!req) throw new Error("approval request required");
  const madApproval = createApprovalGuard({
    chainId,
    token: req.token,
    spender: req.spender,
    amount: req.amount,
    provider,
    routeVenue: routeTransaction?.to || req.spender,
    routeGuard,
    nowMs,
    ttlMs,
  });
  return {
    chainId: Number(chainId),
    to: req.token,
    data: ERC20.encodeFunctionData("approve", [req.spender, req.amount]),
    value: "0x0",
    madApproval,
  };
}

export function buildApprovalRevokeTransaction(approval, {
  chainId,
  provider,
  nowMs = Date.now(),
  ttlMs = DEFAULT_APPROVAL_TTL_MS,
} = {}) {
  const token = normalAddress(approval?.token, "approval token");
  const spender = normalAddress(approval?.spender, "approval spender");
  const madApproval = createApprovalGuard({
    chainId,
    token,
    spender,
    amount: "0",
    provider,
    routeVenue: spender,
    purpose: "revoke",
    nowMs,
    ttlMs,
  });
  return {
    chainId: Number(chainId),
    to: token,
    data: ERC20.encodeFunctionData("approve", [spender, "0"]),
    value: "0x0",
    madApproval,
  };
}

export function assertApprovalGuard(guard, tx = {}, { chainId, nowMs = Date.now() } = {}) {
  if (!guard || guard.mode !== "approval") throw new Error("approval guard required");
  const txChainId = Number(tx.chainId ?? chainId);
  if (Number(guard.chainId) !== txChainId) throw new Error(`approval chain mismatch: expected ${txChainId}, got ${guard.chainId}`);
  const token = normalAddress(tx.to, "approval token");
  if (normalAddress(guard.token, "approval token") !== token) throw new Error("approval token mismatch");
  const decoded = decodeApproveCalldata(tx.data);
  if (normalAddress(guard.spender, "approval spender") !== decoded.spender) throw new Error("approval spender mismatch");
  const isRevoke = String(guard.purpose || "") === "revoke";
  if (decoded.amount === "0" && !isRevoke) throw new Error("zero approval amount requires revoke purpose");
  if (amountString(guard.amount, "approval amount", { allowZero: isRevoke }) !== decoded.amount) throw new Error("approval amount mismatch");
  const value = tx.value == null ? 0n : BigInt(String(tx.value).startsWith("0x") ? String(tx.value) : String(tx.value));
  if (value !== 0n) throw new Error("approval tx value must be zero");
  // Same clock fail-closed as every other guard. A missing expiresAtMs used to
  // make Number(undefined) <= now evaluate false, turning a captured approval
  // into a permanent re-grant. NaN/null/"later" clocks had the same effect.
  const { now } = assertFreshWindow(guard, nowMs, "approval guard");
  if (Number(guard.issuedAtMs) > now + 5_000) throw new Error("approval guard issued in the future");
  const allowedSpenders = venuesFor(txChainId);
  if (!allowedSpenders.has(decoded.spender)) {
    if (String(guard.provider || "") === "morpho") {
      assertVaultApprovalAttestation(tx.madVault || tx.vaultGuard, tx, guard, { chainId: txChainId, nowMs });
      return {
        chainId: txChainId,
        token,
        spender: decoded.spender,
        amount: decoded.amount,
        provider: guard.provider || null,
      };
    }
    throw new Error(`approval spender ${decoded.spender} not allowlisted for chain ${txChainId}`);
  }
  if (String(guard.provider || "") === "gmx") {
    assertGmxApprovalAttestation(tx.madGmx || tx.gmxGuard, tx, guard, { chainId: txChainId, nowMs });
  }
  if (guard.routeVenue && !allowedSpenders.has(normalAddress(guard.routeVenue, "approval route venue"))) {
    throw new Error(`approval route venue ${guard.routeVenue} not allowlisted for chain ${txChainId}`);
  }
  return {
    chainId: txChainId,
    token,
    spender: decoded.spender,
    amount: decoded.amount,
    provider: guard.provider || null,
  };
}
