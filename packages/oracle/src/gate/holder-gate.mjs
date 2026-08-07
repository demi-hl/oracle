/**
 * Locals Only holder gate (distribution).
 *
 * This is the HOSTED gate that decides who may download and install Oracle. It
 * is deliberately NOT part of the keyless local plane: the local app runs on the
 * user's own machine, so any check inside that process is a one-line bypass.
 * Enforcement only means something on a server the operator controls, which is
 * why this module lives apart from packages/oracle/src/public-api.
 *
 * What a holder actually does: connect a wallet, sign one message, get the
 * install command. Holding the NFT is the credential.
 *
 * What this module never does:
 *   - sign a transaction (verifyMessage RECOVERS a signer; it does not sign)
 *   - hold, read, or request key material
 *   - broadcast anything
 *
 * The three properties that make the gate real rather than decorative:
 *   1. balanceOf proves a token sits at an address. The SIGNATURE proves the
 *      caller controls that address. Neither alone is sufficient, so both are
 *      required, in that order, every time.
 *   2. Nonces are single-use and time-boxed, so a captured signature cannot be
 *      replayed into a second session.
 *   3. The signed message names this service and states that signing grants no
 *      trading authority, so a signature farmed by another dapp does not open
 *      this door.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Contract, JsonRpcProvider, verifyMessage } from "ethers";

/** Locals Only, HyperEVM. Verified on-chain: name "Locals Only", symbol LOCALS, totalSupply 500. */
export const LOCALS_ONLY_CONTRACT = "0x62FCFAf7573AD8B41a0FBF347AfEb85e06599A75";
export const LOCALS_ONLY_CHAIN_ID = 999;
export const LOCALS_ONLY_RPC = "https://rpc.hyperliquid.xyz/evm";

const ERC721_BALANCE_ABI = ["function balanceOf(address owner) view returns (uint256)"];

export const NONCE_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function isAddress(value) {
  return ADDRESS_RE.test(String(value || ""));
}

/**
 * In-memory nonce store. One process, one gate; a restart invalidates pending
 * challenges, which is correct behaviour rather than a limitation.
 */
export function createNonceStore() {
  const nonces = new Map();
  return {
    put(nonce, record) {
      nonces.set(nonce, record);
    },
    /** Reads AND removes: a nonce is valid exactly once. */
    take(nonce) {
      const record = nonces.get(nonce);
      nonces.delete(nonce);
      return record ?? null;
    },
    prune(now = Date.now()) {
      for (const [nonce, record] of nonces) {
        if (record.expiresAt < now) nonces.delete(nonce);
      }
    },
    get size() {
      return nonces.size;
    },
  };
}

/**
 * Build the message a holder signs.
 *
 * Binds the service identity, the claimed address, and the nonce. The closing
 * line is load-bearing: it tells the signer, in a wallet popup, that this
 * grants no spending authority. A gate that asks for an ambiguous signature
 * trains users to approve ambiguous signatures.
 */
export function challengeMessage({ domain, address, nonce, issuedAt }) {
  return [
    `${domain} wants you to sign in to Oracle.`,
    "",
    `Address: ${address}`,
    `Chain ID: ${LOCALS_ONLY_CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    "",
    "Signing proves you control this wallet so Oracle can check it holds a",
    "Locals Only NFT. It does not submit a transaction, move funds, or grant",
    "any trading authority.",
  ].join("\n");
}

export function issueChallenge(address, { domain = "oracle.local", store, ttlMs = NONCE_TTL_MS, now = Date.now() } = {}) {
  if (!isAddress(address)) throw new Error("invalid-address");
  const nonce = randomBytes(18).toString("hex");
  const issuedAt = new Date(now).toISOString();
  const message = challengeMessage({ domain, address, nonce, issuedAt });
  const expiresAt = now + ttlMs;
  store.put(nonce, { address: address.toLowerCase(), message, expiresAt });
  return { nonce, message, expiresAt: new Date(expiresAt).toISOString() };
}

/** Live ERC-721 balance on the gate chain. Read-only. */
export async function holderBalance(address, {
  contract = LOCALS_ONLY_CONTRACT,
  rpc = LOCALS_ONLY_RPC,
  chainId = LOCALS_ONLY_CHAIN_ID,
} = {}) {
  const provider = new JsonRpcProvider(rpc, chainId, { staticNetwork: true });
  const erc721 = new Contract(contract, ERC721_BALANCE_ABI, provider);
  return BigInt(await erc721.balanceOf(address));
}

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueSession({ address, balance, secret, ttlMs = SESSION_TTL_MS, now = Date.now() }) {
  const payload = Buffer.from(
    JSON.stringify({
      address: address.toLowerCase(),
      balance: String(balance),
      gate: "locals-only",
      expiresAt: now + ttlMs,
    }),
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function readSession(token, { secret, now = Date.now() } = {}) {
  try {
    const [payload, signature] = String(token || "").split(".");
    if (!payload || !signature) return null;
    const expected = Buffer.from(sign(payload, secret));
    const supplied = Buffer.from(signature);
    // Length check first: timingSafeEqual throws on a length mismatch.
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isAddress(session.address) || !Number.isFinite(session.expiresAt) || session.expiresAt < now) return null;
    if (session.gate !== "locals-only") return null;
    return session;
  } catch {
    return null;
  }
}

/**
 * Verify a signed challenge and, on success, issue a session.
 *
 * Order matters. Signature first: an unverified address is an attacker-supplied
 * string, and running a balance check on it would let anyone probe whether an
 * arbitrary wallet holds the NFT. Only after control is proven do we ask the
 * chain what that wallet holds.
 *
 * `balanceOf` is injectable so tests can drive the non-holder path without
 * needing a wallet that provably holds nothing forever.
 */
export async function verifyChallenge({
  nonce,
  signature,
  store,
  secret,
  balanceOf = holderBalance,
  now = Date.now(),
  sessionTtlMs = SESSION_TTL_MS,
}) {
  const challenge = store.take(nonce);
  if (!challenge) throw new Error("challenge-not-found");
  if (challenge.expiresAt < now) throw new Error("challenge-expired");

  let recovered;
  try {
    recovered = verifyMessage(challenge.message, signature).toLowerCase();
  } catch {
    throw new Error("bad-signature");
  }
  if (recovered !== challenge.address) throw new Error("address-mismatch");

  const balance = await balanceOf(recovered);
  if (BigInt(balance) <= 0n) throw new Error("not-a-holder");

  return {
    token: issueSession({ address: recovered, balance, secret, ttlMs: sessionTtlMs, now }),
    address: recovered,
    balance: String(balance),
    expiresAt: new Date(now + sessionTtlMs).toISOString(),
  };
}
