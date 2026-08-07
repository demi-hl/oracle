// Oracle Control — ERC-4337 session-key on-chain adapter (Slice E).
//
// Wires the provider-neutral session grant produced by session-key-model.mjs
// to a real account-abstraction encoding stack (viem) so a grant can be
// turned into:
//   1. install calldata  — enable a scoped session key on the owner's smart
//      account (encodeSessionKeyInstall)
//   2. an unsigned ERC-4337 UserOperation envelope that carries that calldata
//      (buildUserOperation)
//   3. revoke calldata   — disable a session key on the smart account
//      (revokeSessionKey)
//
// Hard boundaries (same posture as session-key-model.mjs / policy-schema.mjs):
//   - No wallet/AA SDK holds or requests the owner's main key here. This
//     module only ASSEMBLES UNSIGNED data. Signing is the user's wallet,
//     off-infrastructure — never this adapter, never a server, never a log.
//   - No live RPC/bundler calls. Any chain read this adapter needs (the
//     account's current ERC-4337 nonce) goes through a caller-injected
//     `client` object (duck-typed to viem's PublicClient.readContract shape)
//     so tests can supply a fully offline mock and production code can pass
//     a real viem PublicClient without this file changing.
//   - Import ONLY from ./session-key-model.mjs (grant shape/lifecycle) and
//     ./policy-schema.mjs (not currently needed here, left available) plus
//     viem and node builtins. NEVER from the private executor stack
//     (get-signer.mjs, keystore.mjs, exec-policy.mjs, local-signer/*,
//     adapters/*, mint-capability.mjs) — this module must never be wired to
//     private operator wallet.
//   - Fail-closed: a grant that is not ACTIVE (per session-key-model's own
//     sessionStatus — expired, revoked, or malformed) is refused BEFORE any
//     calldata is computed. A tampered "grant-shaped" object whose id does
//     not match its own fields is refused for the same reason.
//
// Session-key module ABI note: real deployed session-key modules differ
// per AA stack (Safe allowance/session module, Kernel/ZeroDev session
// validator, Biconomy Nexus session module, a bespoke
// permissionless/viem session account). This adapter defines the ERC-4337
// envelope and a documented, generic "install/revoke a scoped session key"
// function interface (DEFAULT_SESSION_MODULE_ABI) that mirrors the common
// shape those modules expose. Wiring to one specific deployed module is a
// matter of passing that module's real `abi`/`moduleAddress` via opts — the
// grant validation, determinism, and unsigned-userOp assembly below do not
// change. This file never invents a contract address: `moduleAddress` is a
// required caller-supplied parameter, not a hardcoded guess.

import {
  encodeFunctionData,
  keccak256,
  stringToHex,
  numberToHex,
  isAddress,
  isHex,
  getAddress,
} from "viem";

import {
  canonicalJson,
  computeSessionId,
  sessionStatus,
  SESSION_STATUS,
} from "./session-key-model.mjs";

/** Canonical ERC-4337 EntryPoint v0.7 address (public, chain-agnostic
 *  constant — not private infrastructure). Callers may override
 *  via opts.entryPoint for a different EntryPoint version/deployment. */
export const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

/** Minimal EntryPoint ABI slice this adapter needs (nonce read only — this
 *  adapter never calls the EntryPoint's mutating methods). */
export const ENTRYPOINT_ABI = [
  {
    type: "function",
    name: "getNonce",
    stateMutability: "view",
    inputs: [
      { name: "sender", type: "address" },
      { name: "key", type: "uint192" },
    ],
    outputs: [{ name: "nonce", type: "uint256" }],
  },
];

/**
 * Generic "session-key module" interface most ERC-4337 session-key
 * validators expose in one shape or another. This is the DEFAULT abi used
 * when the caller does not supply a provider-specific one via opts.abi — see
 * the module-level doc comment above for why the exact selector is left
 * swappable rather than hardcoded per provider.
 */
export const DEFAULT_SESSION_MODULE_ABI = [
  {
    type: "function",
    name: "installSessionKey",
    stateMutability: "nonpayable",
    inputs: [
      { name: "sessionId", type: "bytes32" },
      { name: "agent", type: "address" },
      { name: "validAfter", type: "uint48" },
      { name: "validUntil", type: "uint48" },
      { name: "actionsHash", type: "bytes32" },
      { name: "targets", type: "address[]" },
      { name: "maxValueWei", type: "uint256" },
      { name: "maxGasWei", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeSessionKey",
    stateMutability: "nonpayable",
    inputs: [{ name: "sessionId", type: "bytes32" }],
    outputs: [],
  },
];

function fail(message) {
  throw new Error(`aa-adapter: ${message}`);
}

function requireModuleAddress(moduleAddress) {
  if (typeof moduleAddress !== "string" || !isAddress(moduleAddress)) {
    fail(
      "opts.moduleAddress is required and must be a valid 0x address of the " +
        "deployed session-key module on the owner's smart account (this " +
        "adapter never guesses/hardcodes a contract address)"
    );
  }
  return getAddress(moduleAddress);
}

/** Re-derive a grant's identity fields (everything except `id`) and confirm
 *  they hash to the grant's own `id`, defending against a hand-crafted
 *  "grant-shaped" object that never went through createSessionGrant(). */
function assertGrantIntegrity(grant) {
  if (!grant || grant.mode !== "oracle-session-grant") {
    fail("input is not a valid session-key-model grant (missing/wrong mode)");
  }
  const { id, ...identity } = grant;
  const recomputed = computeSessionId(identity);
  if (recomputed !== id) {
    fail("grant integrity check failed: id does not match grant fields (tampered or hand-built object)");
  }
}

/** Refuse to touch out-of-policy grants (expired/revoked/invalid) before any
 *  calldata is computed. `opts` is forwarded to session-key-model's
 *  sessionStatus() (nowMs, revocation registry/Set/array). */
function assertGrantEncodable(grant, opts = {}) {
  assertGrantIntegrity(grant);
  const status = sessionStatus(grant, opts);
  if (status !== SESSION_STATUS.ACTIVE) {
    fail(`refusing to encode calldata for a ${status} session (${grant.id})`);
  }
}

function msToSecondsUint48(ms, label) {
  const seconds = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 0xffffffffffff) {
    fail(`${label} does not fit a uint48 seconds timestamp`);
  }
  return BigInt(seconds);
}

/**
 * Deterministic install calldata for enabling a session-key-model grant as a
 * scoped session key on the owner's ERC-4337 smart account.
 *
 * Refuses (throws, no calldata returned) when the grant is not ACTIVE —
 * expired, revoked, or fails its own integrity check — per assertGrantEncodable.
 *
 * @param {object} grant  output of session-key-model.createSessionGrant()
 * @param {object} opts
 * @param {string} opts.moduleAddress  REQUIRED — deployed session-key module address
 * @param {Array}  [opts.abi]          override for DEFAULT_SESSION_MODULE_ABI
 * @param {number} [opts.nowMs]        forwarded to sessionStatus() for the active check
 * @param {object|Set|string[]} [opts.revocation]  forwarded to sessionStatus()
 * @returns {{ to: string, data: `0x${string}`, value: string }}
 */
export function encodeSessionKeyInstall(grant, opts = {}) {
  assertGrantEncodable(grant, opts);
  const moduleAddress = requireModuleAddress(opts.moduleAddress);
  const abi = opts.abi ?? DEFAULT_SESSION_MODULE_ABI;

  const agent = getAddress(grant.agent);
  const targets = grant.targets.map((t) => getAddress(t));
  const validAfter = msToSecondsUint48(grant.issuedAtMs, "issuedAtMs");
  const validUntil = msToSecondsUint48(grant.expiresAtMs, "expiresAtMs");
  // actionsHash: keccak256 over the canonical (already-sorted, deduped) JSON
  // of the granted action ids — same convention session-key-model.mjs uses
  // for computeSessionId, so it hashes identically everywhere.
  const actionsHash = keccak256(stringToHex(canonicalJson(grant.actions)));
  const maxValueWei = BigInt(grant.maxValueWei);
  // grant.maxGasWei may be null (no independent gas cap set at the
  // session-key-model layer); encoded as 0. The deployed module's own
  // convention decides how 0 is interpreted (commonly "not independently
  // capped here" — see docs/public-self-custody-aa-adapter.md).
  const maxGasWei = grant.maxGasWei == null ? 0n : BigInt(grant.maxGasWei);

  const data = encodeFunctionData({
    abi,
    functionName: "installSessionKey",
    args: [grant.id, agent, validAfter, validUntil, actionsHash, targets, maxValueWei, maxGasWei],
  });

  return { to: moduleAddress, data, value: "0x0" };
}

/**
 * Deterministic revoke calldata for disabling a session key on the owner's
 * smart account. Accepts either a full grant object (its `.id` is used) or
 * a raw session id string. Unlike install, revoke is allowed even for a
 * grant that is already expired/revoked (revocation is idempotent per
 * session-key-model's own createRevocationRegistry) — the only hard refusal
 * here is a malformed session id.
 *
 * @param {object|string} grantOrSessionId
 * @param {object} opts
 * @param {string} opts.moduleAddress  REQUIRED — deployed session-key module address
 * @param {Array}  [opts.abi]          override for DEFAULT_SESSION_MODULE_ABI
 * @returns {{ to: string, data: `0x${string}`, value: string }}
 */
export function revokeSessionKey(grantOrSessionId, opts = {}) {
  let sessionId;
  if (typeof grantOrSessionId === "string") {
    sessionId = grantOrSessionId;
  } else if (grantOrSessionId && grantOrSessionId.mode === "oracle-session-grant") {
    assertGrantIntegrity(grantOrSessionId);
    sessionId = grantOrSessionId.id;
  } else {
    fail("revokeSessionKey requires a session-key-model grant object or a raw session id string");
  }
  if (!isHex(sessionId) || sessionId.length !== 66) {
    fail("session id must be a 0x-prefixed 32-byte hash (as produced by computeSessionId)");
  }

  const moduleAddress = requireModuleAddress(opts.moduleAddress);
  const abi = opts.abi ?? DEFAULT_SESSION_MODULE_ABI;

  const data = encodeFunctionData({
    abi,
    functionName: "revokeSessionKey",
    args: [sessionId],
  });

  return { to: moduleAddress, data, value: "0x0" };
}

const REQUIRED_GAS_FIELDS = [
  "callGasLimit",
  "verificationGasLimit",
  "preVerificationGas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
];

function toBigIntField(value, label) {
  if (value == null) fail(`${label} is required`);
  let n;
  try {
    n = typeof value === "bigint" ? value : BigInt(value);
  } catch {
    fail(`${label} must be an integer, bigint, or 0x-hex string`);
  }
  if (n < 0n) fail(`${label} must not be negative`);
  return n;
}

/**
 * Assemble an UNSIGNED ERC-4337 v0.7 UserOperation envelope carrying the
 * given callData (typically the output of encodeSessionKeyInstall /
 * revokeSessionKey, but this function accepts any calldata — it does not
 * re-check grant policy itself).
 *
 * This function never estimates gas and never fabricates fee data: every
 * gas/fee field is a required, explicit caller input. The only chain read it
 * performs is the ERC-4337 account nonce, and ONLY when `nonce` is not
 * supplied directly — in that case it calls `client.readContract(...)`,
 * duck-typed to viem's PublicClient shape, so:
 *   - production code passes a real viem PublicClient and gets a real nonce
 *   - tests pass a plain object with an async readContract() mock and NO
 *     network call ever happens
 *
 * The returned object always has signature: "0x" (empty) and carries no key
 * material of any kind — signing happens in the user's own wallet, off this
 * adapter.
 *
 * @param {object} params
 * @param {object} [params.client]  duck-typed viem PublicClient (readContract) — only used if nonce is omitted
 * @param {string} [params.entryPoint]  defaults to ENTRYPOINT_V07
 * @param {string} params.sender  smart account address
 * @param {string} params.callData  0x-prefixed calldata to execute
 * @param {string|number|bigint} [params.nonce]  explicit nonce override (skips client read)
 * @param {string|number|bigint} [params.nonceKey]  EntryPoint nonce key (default 0)
 * @param {string} [params.factory]  smart-account factory address (counterfactual deploy)
 * @param {string} [params.factoryData]  factory calldata (required if factory is set)
 * @param {string|number|bigint} params.callGasLimit
 * @param {string|number|bigint} params.verificationGasLimit
 * @param {string|number|bigint} params.preVerificationGas
 * @param {string|number|bigint} params.maxFeePerGas
 * @param {string|number|bigint} params.maxPriorityFeePerGas
 * @param {string} [params.paymaster]
 * @param {string|number|bigint} [params.paymasterVerificationGasLimit]  required if paymaster is set
 * @param {string|number|bigint} [params.paymasterPostOpGasLimit]  required if paymaster is set
 * @param {string} [params.paymasterData]  defaults to "0x"
 */
export async function buildUserOperation(params = {}) {
  const {
    client,
    entryPoint = ENTRYPOINT_V07,
    sender,
    callData,
    nonce,
    nonceKey = 0n,
    factory,
    factoryData,
    paymaster,
    paymasterVerificationGasLimit,
    paymasterPostOpGasLimit,
    paymasterData = "0x",
  } = params;

  if (typeof sender !== "string" || !isAddress(sender)) fail("params.sender must be a valid 0x address");
  if (typeof callData !== "string" || !isHex(callData)) fail("params.callData must be 0x-prefixed hex");
  if (typeof entryPoint !== "string" || !isAddress(entryPoint)) fail("params.entryPoint must be a valid 0x address");

  const normalizedSender = getAddress(sender);
  const normalizedEntryPoint = getAddress(entryPoint);

  for (const field of REQUIRED_GAS_FIELDS) {
    if (params[field] == null) fail(`params.${field} is required (this adapter does not estimate gas)`);
  }
  const callGasLimit = toBigIntField(params.callGasLimit, "callGasLimit");
  const verificationGasLimit = toBigIntField(params.verificationGasLimit, "verificationGasLimit");
  const preVerificationGas = toBigIntField(params.preVerificationGas, "preVerificationGas");
  const maxFeePerGas = toBigIntField(params.maxFeePerGas, "maxFeePerGas");
  const maxPriorityFeePerGas = toBigIntField(params.maxPriorityFeePerGas, "maxPriorityFeePerGas");

  if ((factory == null) !== (factoryData == null)) {
    fail("factory and factoryData must both be set (counterfactual deploy) or both omitted");
  }
  if (factory != null && (typeof factory !== "string" || !isAddress(factory))) {
    fail("params.factory must be a valid 0x address");
  }
  if (factoryData != null && (typeof factoryData !== "string" || !isHex(factoryData))) {
    fail("params.factoryData must be 0x-prefixed hex");
  }

  const hasPaymaster = paymaster != null;
  if (hasPaymaster) {
    if (typeof paymaster !== "string" || !isAddress(paymaster)) fail("params.paymaster must be a valid 0x address");
    if (paymasterVerificationGasLimit == null || paymasterPostOpGasLimit == null) {
      fail("paymasterVerificationGasLimit and paymasterPostOpGasLimit are required when paymaster is set");
    }
  }
  if (paymasterData != null && (typeof paymasterData !== "string" || !isHex(paymasterData))) {
    fail("params.paymasterData must be 0x-prefixed hex");
  }

  let resolvedNonce;
  if (nonce != null) {
    resolvedNonce = toBigIntField(nonce, "nonce");
  } else {
    if (!client || typeof client.readContract !== "function") {
      fail(
        "params.nonce was omitted and no usable client was provided — pass an explicit nonce or a " +
          "client with an async readContract({address, abi, functionName, args}) method (a real viem " +
          "PublicClient in production, a mock in tests; this adapter makes no network call itself)"
      );
    }
    const key = toBigIntField(nonceKey, "nonceKey");
    resolvedNonce = await client.readContract({
      address: normalizedEntryPoint,
      abi: ENTRYPOINT_ABI,
      functionName: "getNonce",
      args: [normalizedSender, key],
    });
    resolvedNonce = toBigIntField(resolvedNonce, "resolved nonce");
  }

  const userOp = {
    sender: normalizedSender,
    nonce: numberToHex(resolvedNonce),
    factory: factory != null ? getAddress(factory) : null,
    factoryData: factoryData ?? null,
    callData,
    callGasLimit: numberToHex(callGasLimit),
    verificationGasLimit: numberToHex(verificationGasLimit),
    preVerificationGas: numberToHex(preVerificationGas),
    maxFeePerGas: numberToHex(maxFeePerGas),
    maxPriorityFeePerGas: numberToHex(maxPriorityFeePerGas),
    paymaster: hasPaymaster ? getAddress(paymaster) : null,
    paymasterVerificationGasLimit: hasPaymaster ? numberToHex(toBigIntField(paymasterVerificationGasLimit, "paymasterVerificationGasLimit")) : null,
    paymasterPostOpGasLimit: hasPaymaster ? numberToHex(toBigIntField(paymasterPostOpGasLimit, "paymasterPostOpGasLimit")) : null,
    paymasterData: hasPaymaster ? paymasterData : null,
    // Always empty: this adapter assembles UNSIGNED user operations only.
    // No signature is computed, requested, or accepted here.
    signature: "0x",
  };

  return Object.freeze(userOp);
}

export const _internal = { requireModuleAddress, assertGrantIntegrity, assertGrantEncodable, msToSecondsUint48 };
