// Oracle Control — end-to-end session orchestrator (Slice J).
//
// Pure GLUE. This module composes the already-tested public lanes into one
// plan -> activate -> revoke -> describe lifecycle and adds NO new custody,
// NO new crypto, NO new policy. Every capability below is an import:
//
//   plan      — policy-schema.validateGrant + connect-agent.assembleUnsignedGrant
//   activate  — session-key-model.createSessionGrant + aa-adapter
//               (encodeSessionKeyInstall / buildUserOperation)
//   revoke    — aa-adapter.revokeSessionKey + session-key-model's
//               createRevocationRegistry entry shape
//   describe  — grant-indexer.reconstructGrantIndex
//
// Hard boundaries (same posture as every other public-control module):
//   - NEVER signs. There is no signer here. activateSession() verifies the
//     owner's grant signature before assembly but never stores or returns it.
//     Every userOp leaving this module has signature: "0x".
//   - NEVER imports the private executor stack (get-signer.mjs, keystore.mjs,
//     exec-policy.mjs, local-signer/*, adapters/*, mint-capability.mjs).
//   - Fail-closed no-secret invariant: every object returned from this module
//     is scanned with connect-agent's assertNoSecretMaterial (see
//     scanPublicReturn below for the two documented, narrow redactions).
//
// CRITICAL UNIT RULE (control lane vs AA lane):
//   - policy-schema / grant-indexer / connect-agent speak UNIX SECONDS
//     (`expiresAt`, `now`).
//   - session-key-model / aa-adapter speak MILLISECONDS (`expiresAtMs`,
//     `issuedAtMs`, `nowMs`).
//   Every crossing in this file converts EXPLICITLY:
//     seconds -> ms:  seconds * 1000
//     ms -> seconds:  Math.floor(ms / 1000)
//   and is marked with a "UNIT BOUNDARY" comment.

import {
  assembleUnsignedGrant,
  assertNoSecretMaterial,
  SIGNING_SCHEME,
} from "../public-api/connect-agent.mjs";
import { validateGrant, grantId as computeControlGrantId, GrantValidationError } from "./policy-schema.mjs";
import { reconstructGrantIndex } from "./grant-indexer.mjs";
import {
  createSessionGrant,
  createRevocationRegistry,
  PROVIDERS,
} from "./session-key-model.mjs";
import {
  encodeSessionKeyInstall,
  revokeSessionKey,
  buildUserOperation,
} from "./aa-adapter.mjs";
import { getBytes, verifyMessage } from "ethers";

export const ORCHESTRATOR_KINDS = Object.freeze({
  PLAN: "oracle-session-plan",
  ACTIVATION: "oracle-session-activation",
  REVOCATION: "oracle-session-revocation",
  DESCRIPTION: "oracle-session-description",
});

export { SIGNING_SCHEME };

function fail(message) {
  throw new Error(`session-orchestrator: ${message}`);
}

// ---------------------------------------------------------------------------
// No-secret scan for orchestrator returns
// ---------------------------------------------------------------------------
//
// connect-agent's assertNoSecretMaterial is intentionally stricter than this
// lane's data: it forbids ANY `signature` key and ANY 0x+64-hex string value
// (the shape of a raw EVM private key). Two values in the AA lane are public
// by design yet share those shapes:
//
//   1. userOp.signature — ALWAYS the empty placeholder "0x" here (unsigned).
//      We PROVE it is exactly "0x" and then strip the key from the scan
//      clone. A signature key holding anything else fails closed.
//   2. session ids — sha256-derived 0x+64-hex PUBLIC identifiers produced by
//      session-key-model.computeSessionId. They are redacted in the scan
//      clone ONLY when sitting at the known id keys below. A 0x+64-hex
//      value at ANY other key (i.e. anything that could be a smuggled raw
//      private key) still fails closed.
//
// The ORIGINAL object is returned untouched; only the scan clone is redacted.

const SESSION_ID_KEYS = Object.freeze(["id", "sessionId"]);
const SESSION_ID_RE = /^0x[0-9a-fA-F]{64}$/;

function redactForScan(value, keyName) {
  if (value == null || typeof value !== "object") {
    if (
      typeof value === "string" &&
      SESSION_ID_KEYS.includes(keyName) &&
      SESSION_ID_RE.test(value)
    ) {
      // Public sha256 session id (see header note 2): scan the bare hex so
      // the raw-32-byte-hex-key value rule doesn't misfire, while keeping
      // the content itself scannable.
      return `session-id:${value.slice(2)}`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redactForScan(v, null));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "signature") {
      // See header note 1: unsigned invariant is PROVEN, then the key is
      // dropped from the scan clone only.
      if (v !== "0x") {
        fail(
          `refusing to return a userOp whose signature is not the empty "0x" placeholder (this module never signs)`
        );
      }
      continue;
    }
    out[k] = redactForScan(v, k);
  }
  return out;
}

/** Fail-closed scan of an orchestrator return value. Throws SecretLeakError /
 *  Error on anything secret-shaped; returns the ORIGINAL value unchanged. */
export function scanPublicReturn(value) {
  assertNoSecretMaterial(redactForScan(value, null));
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 1. planConnection
// ---------------------------------------------------------------------------

/**
 * Validate a raw control-lane grant and assemble the UNSIGNED payload the
 * owner reviews and signs in their own wallet.
 *
 * Out-of-policy input is refused HERE, before anything downstream sees it:
 * validateGrant() fails closed (unknown fields, wildcard actions, empty
 * targets for state-changing scopes, expired grants when opts.now is given)
 * and this function throws its GrantValidationError verbatim.
 *
 * @param {object} input   raw grant fields (policy-schema REQUIRED_FIELDS;
 *                         `expiresAt` is UNIX SECONDS)
 * @param {object} opts
 * @param {number} opts.now  required unix SECONDS reference time for liveness and TTL checks
 * @returns frozen { kind, grantId, grant, unsignedGrant, signingBytes, render }
 */
export function planConnection(input, opts = {}) {
  // Control lane: validateGrant speaks UNIX SECONDS (expiresAt, opts.now).
  const verdict = validateGrant(input, { now: opts.now });
  if (!verdict.ok) {
    // Refused at the door — out-of-policy grants never reach assembly.
    throw new GrantValidationError(verdict.errors);
  }

  const unsignedGrant = assembleUnsignedGrant(verdict.grant, { now: opts.now });

  const result = deepFreeze({
    kind: ORCHESTRATOR_KINDS.PLAN,
    unsigned: true,
    grantId: unsignedGrant.payload.grantId,
    grant: verdict.grant,
    unsignedGrant,
    signingBytes: unsignedGrant.signing,
    render: unsignedGrant.render,
  });
  return scanPublicReturn(result);
}

// ---------------------------------------------------------------------------
// 2. activateSession
// ---------------------------------------------------------------------------

function normalizeOwnerSignature(ownerSignature) {
  if (typeof ownerSignature !== "string" || ownerSignature.trim() === "") {
    fail("ownerSignature is required (the owner must have signed the grant in their own wallet)");
  }
  const sig = ownerSignature.trim();
  if (!/^0x[0-9a-fA-F]+$/.test(sig) || sig === "0x") {
    fail("ownerSignature must be non-empty 0x-prefixed hex");
  }
  return sig;
}

async function verifyOwnerApproval({ grant, ownerSignature, verifyOwnerSignature, nowSeconds }) {
  const signature = normalizeOwnerSignature(ownerSignature);
  const unsignedGrant = assembleUnsignedGrant(grant, { now: nowSeconds });
  if (typeof verifyOwnerSignature === "function") {
    const approved = await verifyOwnerSignature({
      grant,
      ownerSignature: signature,
      signingBytes: unsignedGrant.signing,
    });
    if (approved !== true) fail("ownerSignature verification failed");
    return;
  }
  try {
    const recovered = verifyMessage(getBytes(unsignedGrant.signing.bytesHex), signature);
    if (recovered.toLowerCase() !== grant.accountAddress.toLowerCase()) {
      fail("ownerSignature signer does not match grant accountAddress");
    }
  } catch (error) {
    if (String(error?.message || "").startsWith("session-orchestrator:")) throw error;
    fail("ownerSignature could not be verified; smart accounts must provide verifyOwnerSignature");
  }
}

/**
 * Bridge an owner-approved control-lane grant (UNIX SECONDS) into the AA
 * lane (MILLISECONDS): create the session-key-model grant, encode install
 * calldata, and assemble the UNSIGNED ERC-4337 userOp that carries it.
 *
 * NEVER signs. The returned userOp always has signature "0x", and the
 * ownerSignature the caller proved possession of is not part of the return.
 *
 * @param {object} params
 * @param {object} params.grant  control-lane grant (policy-schema shape,
 *                               `expiresAt` in UNIX SECONDS). Re-validated.
 * @param {string} params.ownerSignature  owner's grant signature, verified
 *                               against accountAddress for EOAs.
 * @param {object} params.sessionKeyModel AA-lane parameters:
 *   provider       one of session-key-model PROVIDERS (default permissionless-viem)
 *   moduleAddress  REQUIRED deployed session-key module address
 *   issuedAtMs     REQUIRED epoch MILLISECONDS issuance instant (explicit for
 *                  determinism; also used as the active-check nowMs)
 *   abi            optional module ABI override
 *   userOp         REQUIRED buildUserOperation params minus sender/callData:
 *                  { nonce | client, callGasLimit, verificationGasLimit,
 *                    preVerificationGas, maxFeePerGas, maxPriorityFeePerGas, ... }
 * @returns frozen { kind, unsigned, grantId, sessionId, sessionGrant,
 *                   install, userOp, units }
 */
async function activateSessionWithVerifier(
  { grant, ownerSignature, sessionKeyModel } = {},
  verifyOwnerSignature,
) {
  if (sessionKeyModel == null || typeof sessionKeyModel !== "object") {
    fail("sessionKeyModel is required ({ provider?, moduleAddress, issuedAtMs, userOp })");
  }
  const {
    provider = PROVIDERS.PERMISSIONLESS_VIEM,
    moduleAddress,
    issuedAtMs,
    abi,
    userOp: userOpParams,
  } = sessionKeyModel;

  if (!Number.isFinite(Number(issuedAtMs))) {
    fail("sessionKeyModel.issuedAtMs (epoch MILLISECONDS) is required for a deterministic session grant");
  }
  if (userOpParams == null || typeof userOpParams !== "object") {
    fail("sessionKeyModel.userOp (gas/fee/nonce params for buildUserOperation) is required");
  }

  // Control lane: re-validate the grant (expiresAt in UNIX SECONDS).
  // UNIT BOUNDARY (SECONDS -> for the liveness check we pass the AA-lane
  // instant down-converted): now = Math.floor(issuedAtMs / 1000).
  const nowSeconds = Math.floor(Number(issuedAtMs) / 1000);
  const verdict = validateGrant(grant, { now: nowSeconds });
  if (!verdict.ok) throw new GrantValidationError(verdict.errors);
  const controlGrant = verdict.grant;
  await verifyOwnerApproval({
    grant: controlGrant,
    ownerSignature,
    verifyOwnerSignature,
    nowSeconds,
  });

  // UNIT BOUNDARY (SECONDS -> MILLISECONDS): the control lane's expiresAt is
  // UNIX SECONDS; session-key-model requires expiresAtMs in MILLISECONDS.
  const expiresAtMs = controlGrant.expiresAt * 1000;

  const sessionGrant = createSessionGrant({
    provider,
    owner: controlGrant.accountAddress, // owner smart account
    agent: controlGrant.agentAddress, // session key address
    chainId: controlGrant.chainId,
    actions: controlGrant.actions,
    targets: controlGrant.targets,
    maxValueWei: controlGrant.maxValueWei,
    maxGasWei: controlGrant.maxGasWei,
    expiresAtMs, // MILLISECONDS (converted above)
    nonce: controlGrant.nonce,
    issuedAtMs: Number(issuedAtMs), // MILLISECONDS
  });

  // AA lane: encodeSessionKeyInstall / sessionStatus speak MILLISECONDS.
  const install = encodeSessionKeyInstall(sessionGrant, {
    moduleAddress,
    abi,
    nowMs: Number(issuedAtMs),
  });

  // UNSIGNED ERC-4337 envelope. buildUserOperation always emits
  // signature: "0x" — scanPublicReturn additionally proves it below.
  const userOp = await buildUserOperation({
    ...userOpParams,
    sender: controlGrant.accountAddress,
    callData: install.data,
  });

  const result = deepFreeze({
    kind: ORCHESTRATOR_KINDS.ACTIVATION,
    unsigned: true,
    grantId: computeControlGrantId(controlGrant), // control-lane public id (bare sha256 hex)
    sessionId: sessionGrant.id,
    sessionGrant,
    install,
    userOp,
    units: {
      // Both representations surfaced so callers/tests can audit the
      // SECONDS<->MILLISECONDS conversion explicitly.
      expiresAtSeconds: controlGrant.expiresAt,
      expiresAtMs: sessionGrant.expiresAtMs,
    },
  });
  return scanPublicReturn(result);
}

export async function activateSession(params = {}) {
  return activateSessionWithVerifier(params, undefined);
}

export function createSessionOrchestrator({ verifyOwnerSignature } = {}) {
  if (typeof verifyOwnerSignature !== "function") {
    fail("createSessionOrchestrator requires a trusted verifyOwnerSignature function");
  }
  const trustedVerifier = verifyOwnerSignature;
  return Object.freeze({
    activateSession(params = {}) {
      return activateSessionWithVerifier(params, trustedVerifier);
    },
  });
}

// ---------------------------------------------------------------------------
// 3. revokeSession
// ---------------------------------------------------------------------------

/**
 * Revoke a session: deterministic revoke calldata for the on-chain module
 * plus the off-chain revocation-registry entry Oracle Control's policy
 * checks consume.
 *
 * @param {object|string} grantOrSessionId  session-key-model grant or raw id
 * @param {object} opts
 * @param {string} opts.moduleAddress  REQUIRED session-key module address
 * @param {object} [opts.registry]     createRevocationRegistry() instance to
 *                                     record into (a fresh one is created —
 *                                     and returned — when omitted)
 * @param {number} [opts.nowMs]        epoch MILLISECONDS revocation instant
 * @param {string} [opts.reason]
 * @returns frozen { kind, sessionId, revoke, revocation:{revokedAtMs,reason}, registry }
 */
export function revokeSession(grantOrSessionId, opts = {}) {
  const revoke = revokeSessionKey(grantOrSessionId, {
    moduleAddress: opts.moduleAddress,
    abi: opts.abi,
  });

  const sessionId =
    typeof grantOrSessionId === "string" ? grantOrSessionId : grantOrSessionId.id;

  // AA lane registry speaks MILLISECONDS (revokedAtMs).
  const registry = opts.registry ?? createRevocationRegistry();
  const entry = registry.revoke(sessionId, {
    nowMs: opts.nowMs ?? Date.now(), // MILLISECONDS
    reason: opts.reason ?? null,
  });

  const result = {
    kind: ORCHESTRATOR_KINDS.REVOCATION,
    sessionId,
    revoke,
    revocation: Object.freeze({ revokedAtMs: entry.revokedAtMs, reason: entry.reason }),
    // The live registry is handed back for the caller's subsequent
    // sessionStatus / checkSessionAuthorized calls; not frozen on purpose.
    registry,
  };
  Object.freeze(result);
  deepFreeze(result.revoke);
  return scanPublicReturn(result);
}

// ---------------------------------------------------------------------------
// 4. describeActive
// ---------------------------------------------------------------------------

/**
 * Reconstruct the control-lane grant index from an event log and return the
 * currently-active grants.
 *
 * @param {object[]} events  grant-indexer event log
 * @param {number} now       UNIX SECONDS reference instant (control lane)
 * @returns frozen { kind, now, active, count, index }
 */
export function describeActive(events, now) {
  // Control lane: reconstructGrantIndex speaks UNIX SECONDS (`now`,
  // record.expiresAt). No conversion happens here — callers holding a
  // MILLISECONDS clock must pass Math.floor(ms / 1000) themselves.
  const index = reconstructGrantIndex(events, { now });

  const result = deepFreeze({
    kind: ORCHESTRATOR_KINDS.DESCRIPTION,
    now,
    active: index.active,
    count: index.active.length,
    index,
  });
  return scanPublicReturn(result);
}
