// Hyperliquid HyperCore staking lane: HYPE stake / unstake / delegate.
//
// Reads are public info endpoints. Writes are PREPARE-ONLY: this module returns
// EIP-712 typed data plus the exact action payload for the user's own wallet to
// sign. It never signs, never posts to /exchange, never holds a key.
//
// Flow the user actually performs:
//   spot -> staking balance      : cDeposit
//   staking balance -> validator : tokenDelegate (isUndelegate=false)
//   validator -> staking balance : tokenDelegate (isUndelegate=true)   [1 day validator lockup]
//   staking balance -> spot      : cWithdraw                            [7 day unstaking queue]

import { stampPrepared } from "../../prepare-envelope.mjs";
import { httpJson } from "../http.mjs";
import { hlInfo } from "./hl-info.mjs";
export const HYPE_STAKING_DECIMALS = 8;
export const HYPE_WEI_PER_TOKEN = 10n ** BigInt(HYPE_STAKING_DECIMALS);
export const HL_SIGNATURE_CHAIN_ID = "0xa4b1"; // Arbitrum One, per Hyperliquid user-signed action spec
export const HL_UNSTAKING_QUEUE_DAYS = 7;
export const HL_VALIDATOR_LOCKUP_DAYS = 1;
// The signed action encodes wei as uint64.
export const MAX_UINT64 = 2n ** 64n - 1n;

function exchangeUrl(opts = {}) {
  if (opts.exchangeUrl) return opts.exchangeUrl;
  if (process.env.HL_EXCHANGE_URL) return process.env.HL_EXCHANGE_URL;
  const testnet = opts.testnet || process.env.HL_TESTNET === "1";
  return testnet ? "https://api.hyperliquid-testnet.xyz/exchange" : "https://api.hyperliquid.xyz/exchange";
}

function hyperliquidChain(opts = {}) {
  return opts.testnet || process.env.HL_TESTNET === "1" ? "Testnet" : "Mainnet";
}

function evmAddress(value, label) {
  const addr = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error(`hl-staking: ${label} must be a 0x EVM address`);
  return addr.toLowerCase();
}

/** HYPE amount (decimal string or number) -> integer wei string at 8 decimals. */
export function hypeToWei(amount, label = "amount") {
  const text = String(amount ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`hl-staking: ${label} must be a positive decimal HYPE amount`);
  const [whole, frac = ""] = text.split(".");
  if (frac.length > HYPE_STAKING_DECIMALS) {
    throw new Error(`hl-staking: ${label} has more than ${HYPE_STAKING_DECIMALS} decimals`);
  }
  const wei = BigInt(whole) * HYPE_WEI_PER_TOKEN + BigInt((frac + "0".repeat(HYPE_STAKING_DECIMALS)).slice(0, HYPE_STAKING_DECIMALS) || "0");
  if (wei <= 0n) throw new Error(`hl-staking: ${label} must be greater than zero`);
  if (wei > MAX_UINT64) throw new Error(`hl-staking: ${label} exceeds the uint64 range the signed action encodes`);
  return wei.toString();
}

/**
 * The EIP-712 field is uint64. JavaScript's Number loses integer precision
 * above 2^53, so passing Number(wei) can hand the wallet a DIFFERENT amount
 * than the one Oracle prepared and displayed. Keep wei exact: emit a JS number
 * only while it is provably lossless, otherwise emit the decimal string, which
 * every EIP-712 encoder accepts for uintN.
 */
function exactWei(weiString) {
  const n = BigInt(weiString);
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : weiString;
}

export function weiToHype(wei) {
  const n = BigInt(String(wei || "0"));
  const whole = n / HYPE_WEI_PER_TOKEN;
  const frac = (n % HYPE_WEI_PER_TOKEN).toString().padStart(HYPE_STAKING_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

// ---------------------------------------------------------------- reads

export async function hlStakingHealth(opts = {}) {
  try {
    const validators = await hlValidatorSummaries(opts);
    return {
      ok: validators.count > 0,
      provider: "hl-staking",
      chain: hyperliquidChain(opts),
      validators: validators.count,
      exec: false,
    };
  } catch (error) {
    return { ok: false, provider: "hl-staking", error: String(error?.message || error).slice(0, 160), exec: false };
  }
}

export async function hlValidatorSummaries(opts = {}) {
  const raw = await hlInfo({ type: "validatorSummaries" }, opts);
  const list = Array.isArray(raw) ? raw : [];
  const validators = list.map((v) => ({
    validator: v.validator ?? null,
    name: v.name ?? null,
    isActive: v.isActive ?? null,
    isJailed: v.isJailed ?? null,
    commission: v.commission ?? null,
    stake: v.stake ?? null,
    nRecentBlocks: v.nRecentBlocks ?? null,
  }));
  return { provider: "hl-staking", count: validators.length, validators, exec: false, raw };
}

export async function hlDelegatorSummary(args = {}, opts = {}) {
  const user = evmAddress(args.user || args.address, "user");
  const raw = await hlInfo({ type: "delegatorSummary", user }, opts);
  return {
    provider: "hl-staking",
    user,
    delegatedWei: raw?.delegated ?? null,
    undelegatedWei: raw?.undelegated ?? null,
    totalPendingWithdrawalWei: raw?.totalPendingWithdrawal ?? null,
    nPendingWithdrawals: raw?.nPendingWithdrawals ?? null,
    delegatedHype: raw?.delegated != null ? String(raw.delegated) : null,
    undelegatedHype: raw?.undelegated != null ? String(raw.undelegated) : null,
    exec: false,
    raw,
  };
}

export async function hlDelegations(args = {}, opts = {}) {
  const user = evmAddress(args.user || args.address, "user");
  const raw = await hlInfo({ type: "delegations", user }, opts);
  const list = Array.isArray(raw) ? raw : [];
  return {
    provider: "hl-staking",
    user,
    count: list.length,
    delegations: list.map((d) => ({
      validator: d.validator ?? null,
      amount: d.amount ?? null,
      lockedUntilTimestamp: d.lockedUntilTimestamp ?? null,
    })),
    exec: false,
    raw,
  };
}

export async function hlDelegatorRewards(args = {}, opts = {}) {
  const user = evmAddress(args.user || args.address, "user");
  const raw = await hlInfo({ type: "delegatorRewards", user }, opts);
  return { provider: "hl-staking", user, rewards: Array.isArray(raw) ? raw : [], exec: false };
}

export async function hlDelegatorHistory(args = {}, opts = {}) {
  const user = evmAddress(args.user || args.address, "user");
  const raw = await hlInfo({ type: "delegatorHistory", user }, opts);
  return { provider: "hl-staking", user, history: Array.isArray(raw) ? raw : [], exec: false };
}

// ------------------------------------------------------------- prepares

function nonceNow(args = {}) {
  const n = args.nonce == null ? Date.now() : Number(args.nonce);
  if (!Number.isInteger(n) || n <= 0) throw new Error("hl-staking: nonce must be a positive integer ms timestamp");
  return n;
}

function signatureChainId(opts = {}) {
  return String(opts.signatureChainId || process.env.HL_SIGNATURE_CHAIN_ID || HL_SIGNATURE_CHAIN_ID);
}

function eip712Domain(opts = {}) {
  return {
    name: "HyperliquidSignTransaction",
    version: "1",
    chainId: Number(BigInt(signatureChainId(opts))),
    verifyingContract: "0x0000000000000000000000000000000000000000",
  };
}

function preparedAction({ kind, action, types, primaryType, message, opts, notes, caps }) {
  return stampPrepared({
    provider: "hl-staking",
    venue: "hypercore",
    chain: hyperliquidChain(opts),
    kind,
    prepareReady: true,
    executionReady: false,
    signingReady: false,
    broadcastReady: false,
    requiresUserSignature: true,
    signWith: "user wallet (EIP-712 typed data)",
    submitTo: exchangeUrl(opts),
    submitShape: { action, nonce: action.nonce, signature: "<user 65-byte signature>" },
    action,
    typedData: {
      domain: eip712Domain(opts),
      types,
      primaryType,
      message,
    },
    caps: caps || null,
    notes,
    exec: false,
  }, { provider: "hl-staking", kind });
}

/** spot HYPE -> staking balance. Instant. */
export function hlPrepareStakeDeposit(args = {}, opts = {}) {
  const wei = hypeToWei(args.amountHype ?? args.amount, "amountHype");
  const maxHype = args.maxHype == null ? null : hypeToWei(args.maxHype, "maxHype");
  if (maxHype && BigInt(wei) > BigInt(maxHype)) {
    throw new Error(`hl-staking: amount ${weiToHype(wei)} HYPE exceeds maxHype cap ${weiToHype(maxHype)} HYPE`);
  }
  const nonce = nonceNow(args);
  const chain = hyperliquidChain(opts);
  const action = {
    type: "cDeposit",
    hyperliquidChain: chain,
    signatureChainId: signatureChainId(opts),
    wei: exactWei(wei),
    nonce,
  };
  return preparedAction({
    kind: "hype-stake-deposit",
    action,
    primaryType: "HyperliquidTransaction:CDeposit",
    types: {
      "HyperliquidTransaction:CDeposit": [
        { name: "hyperliquidChain", type: "string" },
        { name: "wei", type: "uint64" },
        { name: "nonce", type: "uint64" },
      ],
    },
    message: { hyperliquidChain: chain, wei: exactWei(wei), nonce },
    opts,
    caps: { amountHype: weiToHype(wei), maxHype: maxHype ? weiToHype(maxHype) : null },
    notes: [
      "Moves HYPE from your Hyperliquid spot balance into your staking balance.",
      "Staking balance still earns nothing until it is delegated to a validator.",
      "Oracle prepared this. Your wallet signs it. Nothing was submitted.",
    ],
  });
}

/** staking balance -> spot HYPE. Enters the 7 day unstaking queue. */
export function hlPrepareStakeWithdraw(args = {}, opts = {}) {
  const wei = hypeToWei(args.amountHype ?? args.amount, "amountHype");
  const nonce = nonceNow(args);
  const chain = hyperliquidChain(opts);
  const action = {
    type: "cWithdraw",
    hyperliquidChain: chain,
    signatureChainId: signatureChainId(opts),
    wei: exactWei(wei),
    nonce,
  };
  return preparedAction({
    kind: "hype-stake-withdraw",
    action,
    primaryType: "HyperliquidTransaction:CWithdraw",
    types: {
      "HyperliquidTransaction:CWithdraw": [
        { name: "hyperliquidChain", type: "string" },
        { name: "wei", type: "uint64" },
        { name: "nonce", type: "uint64" },
      ],
    },
    message: { hyperliquidChain: chain, wei: exactWei(wei), nonce },
    opts,
    caps: { amountHype: weiToHype(wei) },
    notes: [
      `Starts the ${HL_UNSTAKING_QUEUE_DAYS} day unstaking queue back to spot. The HYPE is not liquid during the queue.`,
      "Undelegate from the validator first: only undelegated staking balance can be withdrawn.",
      "Oracle prepared this. Your wallet signs it. Nothing was submitted.",
    ],
  });
}

/** staking balance <-> validator. isUndelegate=false stakes, true unstakes. */
export function hlPrepareDelegate(args = {}, opts = {}) {
  const validator = evmAddress(args.validator, "validator");
  const wei = hypeToWei(args.amountHype ?? args.amount, "amountHype");
  const isUndelegate = Boolean(args.isUndelegate ?? args.undelegate ?? false);
  const maxHype = args.maxHype == null ? null : hypeToWei(args.maxHype, "maxHype");
  if (!isUndelegate && maxHype && BigInt(wei) > BigInt(maxHype)) {
    throw new Error(`hl-staking: delegate amount ${weiToHype(wei)} HYPE exceeds maxHype cap ${weiToHype(maxHype)} HYPE`);
  }
  const nonce = nonceNow(args);
  const chain = hyperliquidChain(opts);
  const action = {
    type: "tokenDelegate",
    hyperliquidChain: chain,
    signatureChainId: signatureChainId(opts),
    validator,
    wei: exactWei(wei),
    isUndelegate,
    nonce,
  };
  return preparedAction({
    kind: isUndelegate ? "hype-undelegate" : "hype-delegate",
    action,
    primaryType: "HyperliquidTransaction:TokenDelegate",
    types: {
      "HyperliquidTransaction:TokenDelegate": [
        { name: "hyperliquidChain", type: "string" },
        { name: "validator", type: "address" },
        { name: "wei", type: "uint64" },
        { name: "isUndelegate", type: "bool" },
        { name: "nonce", type: "uint64" },
      ],
    },
    message: { hyperliquidChain: chain, validator, wei: exactWei(wei), isUndelegate, nonce },
    opts,
    caps: { amountHype: weiToHype(wei), maxHype: maxHype ? weiToHype(maxHype) : null, validator },
    notes: isUndelegate
      ? [
          "Returns stake from the validator to your staking balance.",
          `Delegations carry a ${HL_VALIDATOR_LOCKUP_DAYS} day validator lockup before they can be undelegated.`,
          "Oracle prepared this. Your wallet signs it. Nothing was submitted.",
        ]
      : [
          "Delegates staking balance to the chosen validator so it starts earning.",
          `Once delegated, the stake is locked with that validator for ${HL_VALIDATOR_LOCKUP_DAYS} day.`,
          "Check the validator's commission and jail status before delegating.",
          "Oracle prepared this. Your wallet signs it. Nothing was submitted.",
        ],
  });
}

/**
 * Read-only preflight: does the user actually hold enough in the right bucket
 * for the requested stake/unstake move? Never mutates anything.
 */
export async function hlStakingPreflight(args = {}, opts = {}) {
  const user = evmAddress(args.user || args.address, "user");
  const summary = await hlDelegatorSummary({ user }, opts);
  const delegations = await hlDelegations({ user }, opts);
  return {
    provider: "hl-staking",
    user,
    stakingBalanceUndelegated: summary.undelegatedWei,
    stakingBalanceDelegated: summary.delegatedWei,
    pendingWithdrawals: summary.nPendingWithdrawals,
    delegations: delegations.delegations,
    unstakingQueueDays: HL_UNSTAKING_QUEUE_DAYS,
    validatorLockupDays: HL_VALIDATOR_LOCKUP_DAYS,
    exec: false,
  };
}

/** Never used by Oracle itself. Exposed so a self-hoster can see the exact submit shape. */
export function hlStakingSubmitShape(opts = {}) {
  return {
    method: "POST",
    url: exchangeUrl(opts),
    body: { action: "<prepared action>", nonce: "<action.nonce>", signature: "<user signature r/s/v>" },
    note: "Oracle does not submit this. The signing wallet or its owner posts it. There is deliberately no submit function in this module.",
  };
}
