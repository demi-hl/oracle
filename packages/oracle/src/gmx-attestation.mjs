import { createHmac, timingSafeEqual } from "node:crypto";
import { Interface, isAddress } from "ethers";
import { routeCalldataHash } from "./route-attestation.mjs";
import { resolveAttestationSecret } from "./attestation-secret.mjs";
import { assertFreshWindow } from "./fresh-window.mjs";

const DEFAULT_GMX_ATTESTATION_TTL_MS = 20_000;
const ERC20 = new Interface(["function approve(address spender,uint256 amount) returns (bool)"]);

export const GMX_EXCHANGE_ROUTERS = Object.freeze({
  42161: "0x1c3fa76e6e1088bce750f23a5bfcffa1efef6a41",
  43114: "0x8f550e53dfe96c055d5bdb267c21f268fcaf63b2",
});

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

function amountString(value, label = "gmx amount") {
  try {
    const n = BigInt(String(value));
    if (n <= 0n) throw new Error("nonpositive");
    return n.toString();
  } catch {
    throw new Error(`${label} must be a positive integer string`);
  }
}

function boolValue(value) {
  return Boolean(value);
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

function decodeApproveCalldata(data) {
  const hex = String(data || "").toLowerCase();
  if (!hex.startsWith("0x095ea7b3")) throw new Error("approval calldata required");
  const [spender, amount] = ERC20.decodeFunctionData("approve", hex);
  return { spender: normalAddress(spender, "approval spender"), amount: amountString(amount, "approval amount") };
}

export function isGmxExchangeRouter(chainId, address) {
  const router = GMX_EXCHANGE_ROUTERS[Number(chainId)];
  return !!router && normalAddress(address, "gmx exchange router") === router;
}

export function createGmxOrderAttestation({
  provider = "gmx",
  chainId,
  account,
  receiver,
  exchangeRouter,
  router,
  orderVault,
  orderType,
  market,
  initialCollateralToken,
  initialCollateralDeltaAmount,
  sizeDeltaUsd,
  executionFee,
  acceptablePrice,
  isLong,
  data,
  calldataHash,
  value,
  maxSlippageBps,
  nowMs = Date.now(),
  ttlMs = DEFAULT_GMX_ATTESTATION_TTL_MS,
  secret,
} = {}) {
  const attestation = {
    mode: "gmx-order-attestation",
    version: 1,
    provider: String(provider || "").trim() || "gmx",
    chainId: Number(chainId),
    account: normalAddress(account, "gmx account"),
    receiver: normalAddress(receiver || account, "gmx receiver"),
    exchangeRouter: normalAddress(exchangeRouter, "gmx exchangeRouter"),
    router: normalAddress(router, "gmx router"),
    orderVault: normalAddress(orderVault, "gmx orderVault"),
    orderType: String(orderType || "").trim(),
    market: normalAddress(market, "gmx market"),
    initialCollateralToken: normalAddress(initialCollateralToken, "gmx initialCollateralToken"),
    initialCollateralDeltaAmount: amountString(initialCollateralDeltaAmount, "gmx initialCollateralDeltaAmount"),
    sizeDeltaUsd: amountString(sizeDeltaUsd, "gmx sizeDeltaUsd"),
    executionFee: amountString(executionFee, "gmx executionFee"),
    acceptablePrice: amountString(acceptablePrice, "gmx acceptablePrice"),
    isLong: boolValue(isLong),
    calldataHash: data ? routeCalldataHash(data) : calldataHash,
    value: value == null ? amountString(executionFee, "gmx value") : amountString(value, "gmx value"),
    issuedAtMs: Number(nowMs),
    expiresAtMs: Number(nowMs) + Number(ttlMs),
  };
  if (!Number.isFinite(attestation.chainId)) throw new Error("gmx attestation chainId required");
  if (!attestation.orderType) throw new Error("gmx orderType required");
  if (!isGmxExchangeRouter(attestation.chainId, attestation.exchangeRouter)) throw new Error("gmx exchangeRouter mismatch for chain");
  if (maxSlippageBps != null) attestation.maxSlippageBps = Number(maxSlippageBps);
  const payload = canonicalJson(attestation);
  return { ...attestation, signature: hmac(attestationSecret(secret), payload) };
}

function assertSignature(attestation, secret) {
  const expected = hmac(attestationSecret(secret), canonicalJson(unsigned(attestation)));
  if (!sameSignature(attestation.signature, expected)) throw new Error("gmx attestation signature mismatch");
}

export function assertGmxOrderAttestation(attestation, tx = {}, { chainId, nowMs = Date.now(), secret } = {}) {
  if (!attestation || attestation.mode !== "gmx-order-attestation") throw new Error("gmx order attestation required");
  if (Number(attestation.expiresAtMs) <= Number(nowMs)) throw new Error("gmx attestation expired");
  assertSignature(attestation, secret);
  const txChainId = Number(chainId ?? tx.chainId);
  if (Number(attestation.chainId) !== txChainId) throw new Error("gmx attestation chain mismatch");
  const to = normalAddress(tx.to, "gmx tx.to");
  if (normalAddress(attestation.exchangeRouter, "gmx exchangeRouter") !== to) throw new Error("gmx attestation destination mismatch");
  if (!isGmxExchangeRouter(txChainId, to)) throw new Error("gmx exchangeRouter mismatch for chain");
  if (tx.from && normalAddress(attestation.account, "gmx account") !== normalAddress(tx.from, "gmx tx.from")) {
    throw new Error("gmx attestation account mismatch");
  }
  // Time is a security parameter: an unusable clock must fail CLOSED,
  // otherwise NaN/null/-Infinity silently makes this attestation eternal.
  assertFreshWindow(attestation || {}, nowMs, "gmx order attestation");
  const value = tx.value == null ? "0" : String(BigInt(String(tx.value).startsWith("0x") ? String(tx.value) : String(tx.value)));
  if (String(attestation.value) !== value || String(attestation.executionFee) !== value) throw new Error("gmx attestation value mismatch");
  if (attestation.calldataHash !== routeCalldataHash(tx.data || "0x")) throw new Error("gmx attestation calldata mismatch");
  return true;
}

export function assertGmxApprovalAttestation(attestation, tx = {}, guard = {}, { chainId, nowMs = Date.now(), secret } = {}) {
  if (!attestation || attestation.mode !== "gmx-order-attestation") throw new Error("gmx order attestation required");
  assertFreshWindow(attestation, nowMs, "gmx approval attestation");
  if (Number(attestation.expiresAtMs) <= Number(nowMs)) throw new Error("gmx attestation expired");
  assertSignature(attestation, secret);
  const txChainId = Number(tx.chainId ?? chainId);
  if (Number(attestation.chainId) !== txChainId) throw new Error("gmx attestation chain mismatch");
  const decoded = decodeApproveCalldata(tx.data);
  if (normalAddress(attestation.initialCollateralToken, "gmx collateral") !== normalAddress(tx.to, "approval token")) {
    throw new Error("gmx attestation collateral mismatch");
  }
  if (normalAddress(attestation.router, "gmx router") !== decoded.spender) throw new Error("gmx attestation spender mismatch");
  if (String(attestation.initialCollateralDeltaAmount) !== decoded.amount || String(guard.amount) !== decoded.amount) {
    throw new Error("gmx attestation amount mismatch");
  }
  if (guard.provider && String(guard.provider) !== String(attestation.provider)) throw new Error("gmx attestation provider mismatch");
  return true;
}
