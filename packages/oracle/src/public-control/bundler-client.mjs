// Oracle Control — ERC-4337 bundler/paymaster runtime submit path (Slice H).
//
// Takes a USER-SIGNED UserOperation (produced off this infrastructure — the
// user's own wallet signs it, never Oracle) and submits it to an ERC-4337
// bundler via an INJECTED client. This module never talks to a real network
// itself: every RPC call goes through a caller-supplied `bundlerClient` /
// `paymasterClient`, duck-typed to the viem/permissionless BundlerClient
// action shape ({ sendUserOperation, waitForUserOperationReceipt,
// estimateUserOperationGas }) or a thin equivalent. Tests inject a fully
// offline mock; production code injects a real viem/permissionless client.
//
// Hard boundaries (same posture as aa-adapter.mjs / connect-agent.mjs):
//   - This module holds no keys and requests no signature. It only forwards
//     an ALREADY-SIGNED userOp (or, for estimateAndFill/applyPaymaster, an
//     unsigned userOp being prepared BEFORE the user signs it) to an
//     injected client's methods.
//   - submitUserOperation refuses an unsigned userOp outright — a missing or
//     placeholder ("0x") signature must never reach a bundler.
//   - submitUserOperation/estimateAndFill/applyPaymaster all refuse an
//     entryPoint that does not match ENTRYPOINT_V07 (imported from
//     aa-adapter.mjs, the single source of truth for the deployed EntryPoint
//     address this codebase targets) unless the caller explicitly overrides
//     it, and even then the value must still be a valid checksummed address
//     — this stops an accidental/mismatched EntryPoint submit.
//   - Before any payload is handed to an injected client, it is rebuilt from
//     an explicit field allowlist (canonicalizeUserOpForSubmit) and then
//     recursively scanned by assertNoSecretPayload() for anything shaped
//     like a private key, mnemonic, bearer token, keystore path, or signer
//     URL. Fail closed: throws before the call is ever made.
//   - Imports ONLY from ./aa-adapter.mjs (ENTRYPOINT_V07, buildUserOperation)
//     and viem/node builtins. NEVER from the private executor stack
//     (get-signer.mjs, keystore.mjs, exec-policy.mjs, local-signer/*,
//     adapters/*, mint-capability.mjs) — this module must never be wired to
//     private operator wallet, and never makes a live network call of its own.

import { isAddress, isHex, getAddress } from "viem";

import { ENTRYPOINT_V07, buildUserOperation } from "./aa-adapter.mjs";

// Re-exported for convenience so callers of this module don't need a second
// import from aa-adapter just to read the default EntryPoint constant.
export { ENTRYPOINT_V07 };

function fail(message) {
  throw new Error(`bundler-client: ${message}`);
}

// ---------------------------------------------------------------------------
// No-secret invariant (fail closed) — scoped to what a bundler/paymaster
// payload could plausibly carry. Mirrors the posture of
// public-api/connect-agent.mjs's assertNoSecretMaterial without importing
// across slices.
// ---------------------------------------------------------------------------

export class SecretLeakError extends Error {
  constructor(path, rule) {
    super(`secret material must never appear in a bundler/paymaster payload (at ${path}, rule: ${rule})`);
    this.name = "SecretLeakError";
    this.path = path;
    this.rule = rule;
  }
}

const FORBIDDEN_KEY_RE =
  /(private[_-]?key|secret|bearer|keystore|mnemonic|seed[_-]?phrase|passphrase|password|api[_-]?key|access[_-]?token|auth[_-]?token|session[_-]?token|signer[_-]?url)/i;

const FORBIDDEN_VALUE_RULES = Object.freeze([
  // 32-byte hex — the shape of a raw EVM private key / session secret.
  { rule: "raw-32-byte-hex-key", re: /^0x[0-9a-fA-F]{64}$/ },
  { rule: "bearer-token", re: /bearer\s+[A-Za-z0-9._~+/=-]+/i },
  { rule: "pem-private-key", re: /-----BEGIN[A-Z ]*PRIVATE KEY-----/ },
  { rule: "keystore-path", re: /keystore/i },
  { rule: "signer-url", re: /https?:\/\/\S*sign/i },
  { rule: "authorization-header", re: /authorization\s*:/i },
]);

/**
 * Recursively scan a value for anything shaped like secret material. Throws
 * SecretLeakError on the first hit — fail closed. Note: this intentionally
 * does NOT flag `signature` as a forbidden key (unlike connect-agent's
 * variant) — a signed userOp's `signature` field is a public, submittable
 * ECDSA/contract signature, not a secret, and this module's whole job is to
 * submit it.
 */
export function assertNoSecretPayload(value, path = "$", seen = new Set()) {
  if (value == null) return value;
  if (typeof value === "string") {
    for (const { rule, re } of FORBIDDEN_VALUE_RULES) {
      if (re.test(value)) throw new SecretLeakError(path, rule);
    }
    return value;
  }
  if (typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecretPayload(v, `${path}[${i}]`, seen));
    return value;
  }
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_KEY_RE.test(k)) {
      throw new SecretLeakError(`${path}.${k}`, "forbidden-key-name");
    }
    assertNoSecretPayload(v, `${path}.${k}`, seen);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Explicit field allowlist for an ERC-4337 v0.7 UserOperation, matching the
 *  exact shape aa-adapter.buildUserOperation() returns. Rebuilding from this
 *  allowlist (rather than spreading the caller's object) means any stray
 *  extra property on a hand-built/tampered userOp — however it got there —
 *  is dropped before it can ever reach an injected client. */
const USEROP_FIELDS = [
  "sender",
  "nonce",
  "factory",
  "factoryData",
  "callData",
  "callGasLimit",
  "verificationGasLimit",
  "preVerificationGas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "paymaster",
  "paymasterVerificationGasLimit",
  "paymasterPostOpGasLimit",
  "paymasterData",
  "signature",
];

function canonicalizeUserOpForSubmit(userOp) {
  if (!userOp || typeof userOp !== "object") {
    fail("userOp must be an object (typically the output of aa-adapter.buildUserOperation)");
  }
  const out = {};
  for (const field of USEROP_FIELDS) out[field] = userOp[field] ?? null;
  if (typeof out.sender !== "string" || !isAddress(out.sender)) {
    fail("userOp.sender must be a valid 0x address");
  }
  if (typeof out.callData !== "string" || !isHex(out.callData)) {
    fail("userOp.callData must be 0x-prefixed hex");
  }
  return Object.freeze(out);
}

function requireSignedUserOp(userOp) {
  const sig = userOp && userOp.signature;
  if (sig == null || sig === "" || sig === "0x") {
    fail("refusing to submit a userOp with a missing/placeholder signature — sign it in the user's own wallet first");
  }
  if (typeof sig !== "string" || !isHex(sig)) {
    fail("userOp.signature must be 0x-prefixed hex when present");
  }
}

function resolveEntryPoint(entryPoint) {
  const value = entryPoint ?? ENTRYPOINT_V07;
  if (typeof value !== "string" || !isAddress(value)) {
    fail("entryPoint must be a valid 0x address");
  }
  const normalized = getAddress(value);
  if (normalized !== getAddress(ENTRYPOINT_V07)) {
    fail(
      `entryPoint ${normalized} does not match the expected EntryPoint ${getAddress(ENTRYPOINT_V07)} ` +
        "(ENTRYPOINT_V07 from aa-adapter.mjs) — refusing to submit to an unexpected EntryPoint"
    );
  }
  return normalized;
}

function requireClientMethod(client, methodName, clientLabel) {
  if (!client || typeof client[methodName] !== "function") {
    fail(
      `${clientLabel} must expose an async ${methodName}(...) method (viem/permissionless BundlerClient shape, ` +
        "or a thin { sendUserOperation, waitForUserOperationReceipt, estimateUserOperationGas } interface) — " +
        "this module never makes a network call of its own"
    );
  }
}

function toHexIfBigIntLike(value) {
  if (value == null) return value;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return `0x${value.toString(16)}`;
  if (typeof value === "number" && Number.isSafeInteger(value)) return `0x${BigInt(value).toString(16)}`;
  fail("gas/fee field returned by client must be a 0x-hex string, bigint, or safe integer");
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * Submit an already user-signed UserOperation to an ERC-4337 bundler via an
 * injected client. This is the only function in this module that is allowed
 * to move a userOp onto a bundler's mempool, and it refuses to do so unless
 * the userOp actually carries a real signature.
 *
 * @param {object} params
 * @param {object} params.userOp  a signed UserOperation (signature != "0x")
 * @param {object} params.bundlerClient  injected client exposing async
 *   sendUserOperation({ userOperation, entryPoint }) -> userOpHash
 * @param {string} [params.entryPoint]  defaults to ENTRYPOINT_V07; refused
 *   if it does not resolve to ENTRYPOINT_V07
 * @returns {Promise<string>} userOpHash returned by the bundler client
 */
export async function submitUserOperation(_params = {}) {
  throw new Error("bundler-client.submitUserOperation refused: @oracle-agent/oracle is prepare-only. Submit UserOps from the user wallet or local operator.");
}


/**
 * Fill gas fields on an UNSIGNED (pre-signature) UserOperation via an
 * injected bundler client's estimateUserOperationGas. Never submits
 * anything and never requires a signature — this runs BEFORE the user
 * signs, so it can supply real gas numbers to sign over. Returns a new
 * frozen userOp; the input is never mutated.
 *
 * @param {object} params
 * @param {object} params.userOp  unsigned or placeholder-gas UserOperation
 *   (typically straight out of aa-adapter.buildUserOperation)
 * @param {object} params.bundlerClient  injected client exposing async
 *   estimateUserOperationGas({ userOperation, entryPoint }) -> gas fields
 * @param {string} [params.entryPoint]  defaults to ENTRYPOINT_V07
 * @returns {Promise<object>} frozen userOp with gas fields filled from the
 *   client's estimate (falls back to the input's own values for any field
 *   the client did not return)
 */
export async function estimateAndFill(params = {}) {
  const { userOp, bundlerClient, entryPoint } = params;
  const payload = canonicalizeUserOpForSubmit(userOp);
  const resolvedEntryPoint = resolveEntryPoint(entryPoint);
  requireClientMethod(bundlerClient, "estimateUserOperationGas", "bundlerClient");

  assertNoSecretPayload(payload);
  const estimate = await bundlerClient.estimateUserOperationGas({
    userOperation: payload,
    entryPoint: resolvedEntryPoint,
  });
  if (!estimate || typeof estimate !== "object") {
    fail("bundlerClient.estimateUserOperationGas must resolve to a gas-fields object");
  }

  const filled = {
    ...payload,
    callGasLimit: toHexIfBigIntLike(estimate.callGasLimit ?? payload.callGasLimit),
    verificationGasLimit: toHexIfBigIntLike(estimate.verificationGasLimit ?? payload.verificationGasLimit),
    preVerificationGas: toHexIfBigIntLike(estimate.preVerificationGas ?? payload.preVerificationGas),
  };
  if (payload.paymaster != null) {
    if (estimate.paymasterVerificationGasLimit != null) {
      filled.paymasterVerificationGasLimit = toHexIfBigIntLike(estimate.paymasterVerificationGasLimit);
    }
    if (estimate.paymasterPostOpGasLimit != null) {
      filled.paymasterPostOpGasLimit = toHexIfBigIntLike(estimate.paymasterPostOpGasLimit);
    }
  }

  return Object.freeze(assertNoSecretPayload(filled));
}

/**
 * Attach (or explicitly omit) paymaster sponsorship on an UNSIGNED
 * UserOperation via an injected paymasterClient. If `paymasterClient` is
 * absent/null, this is a no-op that returns the self-funded path — the
 * userOp is returned with its paymaster fields explicitly nulled out, never
 * left ambiguous. This module never holds paymaster credentials; whatever
 * auth the paymaster needs lives inside the injected client, off this file.
 *
 * @param {object} params
 * @param {object} params.userOp  unsigned UserOperation
 * @param {object} [params.paymasterClient]  injected client exposing async
 *   getPaymasterData({ userOperation, entryPoint }) -> paymaster fields.
 *   Omit for the self-funded path (no paymaster).
 * @param {string} [params.entryPoint]  defaults to ENTRYPOINT_V07
 * @returns {Promise<object>} frozen userOp with paymaster fields set
 */
export async function applyPaymaster(params = {}) {
  const { userOp, paymasterClient, entryPoint } = params;
  const payload = canonicalizeUserOpForSubmit(userOp);
  const resolvedEntryPoint = resolveEntryPoint(entryPoint);

  if (paymasterClient == null) {
    // Self-funded path: no paymaster involved, fields explicitly nulled.
    return Object.freeze({
      ...payload,
      paymaster: null,
      paymasterData: null,
      paymasterVerificationGasLimit: null,
      paymasterPostOpGasLimit: null,
    });
  }

  requireClientMethod(paymasterClient, "getPaymasterData", "paymasterClient");
  assertNoSecretPayload(payload);
  const sponsorship = await paymasterClient.getPaymasterData({
    userOperation: payload,
    entryPoint: resolvedEntryPoint,
  });
  if (!sponsorship || typeof sponsorship.paymaster !== "string" || !isAddress(sponsorship.paymaster)) {
    fail("paymasterClient.getPaymasterData must resolve to an object with a valid paymaster address");
  }

  const filled = {
    ...payload,
    paymaster: getAddress(sponsorship.paymaster),
    paymasterData: sponsorship.paymasterData ?? "0x",
    paymasterVerificationGasLimit: toHexIfBigIntLike(sponsorship.paymasterVerificationGasLimit ?? 0n),
    paymasterPostOpGasLimit: toHexIfBigIntLike(sponsorship.paymasterPostOpGasLimit ?? 0n),
  };

  return Object.freeze(assertNoSecretPayload(filled));
}

/**
 * Passthrough to an injected bundler client's receipt-polling method. This
 * module adds no retry/timeout logic of its own — that belongs to the
 * injected client (viem/permissionless already implement polling with
 * backoff); this is a thin, testable seam.
 *
 * @param {object} params
 * @param {string} params.hash  userOpHash returned by submitUserOperation
 * @param {object} params.bundlerClient  injected client exposing async
 *   waitForUserOperationReceipt({ hash, ...rest }) -> receipt
 * @param {object} [params.opts]  extra options forwarded verbatim (e.g.
 *   pollingInterval, timeout) — passed through untouched, never inspected
 *   for secrets since this module trusts caller-supplied polling knobs are
 *   not where key material would ever live
 * @returns {Promise<object>} whatever the injected client resolves to
 */
export async function waitForReceipt(params = {}) {
  const { hash, bundlerClient, opts = {} } = params;
  if (typeof hash !== "string" || !isHex(hash)) {
    fail("hash is required and must be 0x-prefixed hex (the userOpHash from submitUserOperation)");
  }
  requireClientMethod(bundlerClient, "waitForUserOperationReceipt", "bundlerClient");
  return bundlerClient.waitForUserOperationReceipt({ hash, ...opts });
}

export const _internal = {
  canonicalizeUserOpForSubmit,
  requireSignedUserOp,
  resolveEntryPoint,
  requireClientMethod,
  toHexIfBigIntLike,
};

// Re-exported so callers building a fresh userOp before submit don't need a
// second import from aa-adapter for the common "build then submit" flow.
export { buildUserOperation };
