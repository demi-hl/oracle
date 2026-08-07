import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isAddress } from "ethers";
import { assertAutoSlippageGuard } from "./auto-slippage.mjs";
import { resolveAttestationSecret } from "./attestation-secret.mjs";
import { assertFreshWindow } from "./fresh-window.mjs";

const DEFAULT_ROUTE_ATTESTATION_TTL_MS = 20_000;

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

function normalData(value) {
  const data = String(value || "0x").toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})*$/.test(data)) throw new Error("route attestation calldata must be hex bytes");
  return data;
}

function hashText(value) {
  return `0x${createHash("sha256").update(String(value)).digest("hex")}`;
}

function hmac(secret, payload) {
  return `0x${createHmac("sha256", String(secret)).update(payload).digest("hex")}`;
}

function sameSignature(a, b) {
  const left = Buffer.from(String(a || "").replace(/^0x/, ""), "hex");
  const right = Buffer.from(String(b || "").replace(/^0x/, ""), "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function routeSecret(secret) {
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

export function routeCalldataHash(data) {
  return hashText(normalData(data));
}

export function routeSlippageHash(slippageGuard) {
  if (!slippageGuard) throw new Error("route attestation requires slippage guard");
  return hashText(canonicalJson(slippageGuard));
}

export function createRouteAttestation({
  provider,
  chainId,
  sender,
  to,
  destination,
  data,
  value = "0",
  slippageGuard,
  nowMs = Date.now(),
  ttlMs = DEFAULT_ROUTE_ATTESTATION_TTL_MS,
  secret,
} = {}) {
  const target = normalAddress(destination || to, "route destination");
  const attestation = {
    mode: "route-attestation",
    version: 1,
    provider: String(provider || "").trim(),
    chainId: Number(chainId),
    sender: sender ? normalAddress(sender, "route sender") : null,
    destination: target,
    calldataHash: routeCalldataHash(data),
    value: String(value ?? "0"),
    slippageHash: routeSlippageHash(slippageGuard),
    issuedAtMs: Number(nowMs),
    expiresAtMs: Number(nowMs) + Number(ttlMs),
  };
  if (!attestation.provider) throw new Error("route attestation provider required");
  if (!Number.isFinite(attestation.chainId)) throw new Error("route attestation chainId required");
  const payload = canonicalJson(attestation);
  return { ...attestation, signature: hmac(routeSecret(secret), payload) };
}

export function assertRouteAttestation(attestation, tx = {}, { chainId, nowMs = Date.now(), secret } = {}) {
  // Time is a security parameter: an unusable clock must fail CLOSED,
  // otherwise NaN/null/-Infinity silently makes this attestation eternal.
  assertFreshWindow(attestation || {}, nowMs, "route attestation");
  if (!attestation || attestation.mode !== "route-attestation") throw new Error("route attestation required");
  if (Number(attestation.expiresAtMs) <= Number(nowMs)) throw new Error("route attestation expired");
  if (Number(attestation.chainId) !== Number(chainId ?? tx.chainId)) throw new Error("route attestation chain mismatch");
  const to = normalAddress(tx.to, "route tx.to");
  if (normalAddress(attestation.destination, "route destination") !== to) throw new Error("route attestation destination mismatch");
  if (tx.from && attestation.sender && normalAddress(attestation.sender, "route sender") !== normalAddress(tx.from, "route tx.from")) {
    throw new Error("route attestation sender mismatch");
  }
  if (String(attestation.value) !== String(tx.value ?? "0")) throw new Error("route attestation value mismatch");
  if (attestation.calldataHash !== routeCalldataHash(tx.data || "0x")) throw new Error("route attestation calldata mismatch");
  if (attestation.slippageHash !== routeSlippageHash(tx.slippageGuard ?? tx.madSlippage)) {
    throw new Error("route attestation slippage mismatch");
  }
  const expected = hmac(routeSecret(secret), canonicalJson(unsigned(attestation)));
  if (!sameSignature(attestation.signature, expected)) throw new Error("route attestation signature mismatch");
  // Third call site. exec-policy and protocol-execution both demand an
  // authenticated, calldata-bound guard; this path asked for neither, so a
  // dynamic route destination got a weaker slippage check than a static one.
  // The attestation's own calldataHash/slippageHash made it non-exploitable,
  // but a guard boundary that differs by which door you came through is the
  // shape every one of these findings has had. Same bar on all three.
  assertAutoSlippageGuard(tx.slippageGuard ?? tx.madSlippage, {
    chainId: Number(chainId ?? tx.chainId),
    venue: to,
    nowMs,
    secret,
    tx: { ...tx, chainId: Number(chainId ?? tx.chainId), to, data: tx.data },
    requireSigned: true,
  });
  return true;
}
