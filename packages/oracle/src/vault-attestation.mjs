import { createHmac, timingSafeEqual } from "node:crypto";
import { Interface, isAddress } from "ethers";
import { routeCalldataHash } from "./route-attestation.mjs";
import { resolveAttestationSecret } from "./attestation-secret.mjs";
import { assertFreshWindow } from "./fresh-window.mjs";

const DEFAULT_VAULT_ATTESTATION_TTL_MS = 20_000;
const ERC20 = new Interface(["function approve(address spender,uint256 amount) returns (bool)"]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalAddress(value, label) {
  const text = String(value || "").trim();
  if (!isAddress(text)) throw new Error(`${label} must be an address`);
  return text.toLowerCase();
}

function amountString(value, label = "vault amount") {
  try {
    const n = BigInt(String(value));
    if (n <= 0n) throw new Error("nonpositive");
    return n.toString();
  } catch {
    throw new Error(`${label} must be a positive integer string`);
  }
}

function decodeApproveCalldata(data) {
  const hex = String(data || "").toLowerCase();
  if (!hex.startsWith("0x095ea7b3")) throw new Error("approval calldata required");
  const [spender, amount] = ERC20.decodeFunctionData("approve", hex);
  return { spender: normalAddress(spender, "approval spender"), amount: amountString(amount, "approval amount") };
}

function hmac(secret, payload) {
  return `0x${createHmac("sha256", String(secret)).update(payload).digest("hex")}`;
}

function sameSignature(a, b) {
  const left = Buffer.from(String(a || "").replace(/^0x/, ""), "hex");
  const right = Buffer.from(String(b || "").replace(/^0x/, ""), "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function attestationSecret(secret) {
  return resolveAttestationSecret(
    secret,
    "ORACLE_ROUTE_ATTESTATION_SECRET",
    "MAD_ROUTE_ATTESTATION_SECRET",
  );
}

function unsigned(attestation) {
  const { signature: _signature, ...payload } = attestation;
  return payload;
}

export function createVaultAttestation({
  provider = "morpho",
  chainId,
  action,
  vault,
  asset,
  owner,
  receiver,
  amount,
  data,
  calldataHash,
  minSharesOut,
  maxSharesIn,
  totalAssetsUsd,
  nowMs = Date.now(),
  ttlMs = DEFAULT_VAULT_ATTESTATION_TTL_MS,
  secret,
} = {}) {
  const normalizedAction = String(action || "").trim().toLowerCase();
  if (!["deposit", "withdraw"].includes(normalizedAction)) throw new Error("vault attestation action must be deposit or withdraw");
  const attestation = {
    mode: "vault-attestation",
    version: 1,
    provider: String(provider || "").trim() || "morpho",
    chainId: Number(chainId),
    action: normalizedAction,
    vault: normalAddress(vault, "vault"),
    asset: normalAddress(asset, "vault asset"),
    owner: normalAddress(owner, "vault owner"),
    receiver: normalAddress(receiver || owner, "vault receiver"),
    amount: amountString(amount),
    calldataHash: data ? routeCalldataHash(data) : calldataHash,
    value: "0",
    issuedAtMs: Number(nowMs),
    expiresAtMs: Number(nowMs) + Number(ttlMs),
  };
  if (!Number.isFinite(attestation.chainId)) throw new Error("vault attestation chainId required");
  if (minSharesOut != null) attestation.minSharesOut = amountString(minSharesOut, "minSharesOut");
  if (maxSharesIn != null) attestation.maxSharesIn = amountString(maxSharesIn, "maxSharesIn");
  if (totalAssetsUsd != null) attestation.totalAssetsUsd = Number(totalAssetsUsd);
  const payload = canonicalJson(attestation);
  return { ...attestation, signature: hmac(attestationSecret(secret), payload) };
}

export function assertVaultAttestation(attestation, tx = {}, { chainId, nowMs = Date.now(), secret } = {}) {
  // Time is a security parameter: an unusable clock must fail CLOSED,
  // otherwise NaN/null/-Infinity silently makes this attestation eternal.
  assertFreshWindow(attestation || {}, nowMs, "vault attestation");
  if (!attestation || attestation.mode !== "vault-attestation") throw new Error("vault attestation required");
  if (Number(attestation.expiresAtMs) <= Number(nowMs)) throw new Error("vault attestation expired");
  const txChainId = Number(chainId ?? tx.chainId);
  if (Number(attestation.chainId) !== txChainId) throw new Error("vault attestation chain mismatch");
  const to = normalAddress(tx.to, "vault tx.to");
  if (normalAddress(attestation.vault, "vault") !== to) throw new Error("vault attestation destination mismatch");
  if (tx.from && normalAddress(attestation.owner, "vault owner") !== normalAddress(tx.from, "vault tx.from")) {
    throw new Error("vault attestation owner mismatch");
  }
  const value = tx.value == null ? "0" : String(BigInt(String(tx.value).startsWith("0x") ? String(tx.value) : String(tx.value)));
  if (value !== "0") throw new Error("vault attestation value mismatch");
  if (attestation.calldataHash !== routeCalldataHash(tx.data || "0x")) throw new Error("vault attestation calldata mismatch");
  const expected = hmac(attestationSecret(secret), canonicalJson(unsigned(attestation)));
  if (!sameSignature(attestation.signature, expected)) throw new Error("vault attestation signature mismatch");
  return true;
}

export function assertVaultApprovalAttestation(attestation, tx = {}, guard = {}, { chainId, nowMs = Date.now(), secret } = {}) {
  if (!attestation || attestation.mode !== "vault-attestation") throw new Error("vault attestation required");
  if (String(attestation.action) !== "deposit") throw new Error("vault approval requires deposit attestation");
  assertFreshWindow(attestation, nowMs, "vault approval attestation");
  if (Number(attestation.expiresAtMs) <= Number(nowMs)) throw new Error("vault attestation expired");
  const expected = hmac(attestationSecret(secret), canonicalJson(unsigned(attestation)));
  if (!sameSignature(attestation.signature, expected)) throw new Error("vault attestation signature mismatch");
  const txChainId = Number(tx.chainId ?? chainId);
  if (Number(attestation.chainId) !== txChainId) throw new Error("vault attestation chain mismatch");
  const decoded = decodeApproveCalldata(tx.data);
  if (normalAddress(attestation.asset, "vault asset") !== normalAddress(tx.to, "approval token")) throw new Error("vault attestation asset mismatch");
  if (normalAddress(attestation.vault, "vault") !== decoded.spender) throw new Error("vault attestation spender mismatch");
  if (String(attestation.amount) !== decoded.amount || String(guard.amount) !== decoded.amount) {
    throw new Error("vault attestation amount mismatch");
  }
  if (guard.provider && String(guard.provider) !== String(attestation.provider)) throw new Error("vault attestation provider mismatch");
  return true;
}
