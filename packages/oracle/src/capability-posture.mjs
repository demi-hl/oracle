// Oracle capability posture.
//
// THE RULE, stated once, in one place:
//
//   A capability is ARMED when the user has supplied the credential it needs.
//   Nothing executes unless the user asks for that specific action.
//   Autonomous trading is the sole exception: it stays OFF until explicitly
//   enabled, because it is the only mode where Oracle acts without a request.
//
// Why this shape:
//
//   The old model ("everything disarmed until N env flags are set") punished
//   the honest self-hoster. Someone who had already handed Oracle a signing key
//   still could not buy an NFT without hunting down a second, third, and fourth
//   feature flag. That is not security — it is friction that teaches people to
//   set ORACLE_*_ENABLED=1 everywhere, which is strictly worse than a coherent
//   default.
//
//   Supplying a key IS the authorization decision. What actually protects the
//   user is not a flag; it is that every action is USER-INITIATED and bounded
//   by caps at the moment it runs.
//
//   The one thing a key does NOT authorize is Oracle acting on its own. An
//   agent that trades while you sleep is a different risk class from an agent
//   that buys the NFT you just named. So AUTONOMOUS trading — and only that —
//   requires a separate, explicit opt-in.

export const CAPABILITY_TIERS = Object.freeze({
  READ: "read",
  PREPARE: "prepare",
  EXECUTE: "execute",
  AUTONOMOUS: "autonomous",
});

/** Credential each capability needs before it can be armed. */
const CREDENTIAL_FOR = Object.freeze({
  "evm:prepare": ["ORACLE_EVM_ADDRESS", "EVM_KEYSTORE_FILE", "ORACLE_SIGNER_ADDRESS"],
  "evm:execute": ["EVM_KEYSTORE_FILE", "ORACLE_KEYSTORE_FILE"],
  "btc:execute": ["BTC_WIF_FILE", "ORACLE_BTC_WIF_FILE"],
  "solana:execute": ["SOLANA_KEYPAIR_FILE", "ORACLE_SOLANA_KEYPAIR_FILE"],
  "nft:buy": [],
  "nft:mint": [],
  "cow:submit": [],
});

function hasAnyEnv(names, env) {
  return names.some((n) => String(env[n] ?? "").trim() !== "");
}

/**
 * Is autonomous (unattended) trading enabled?
 *
 * This is the ONLY capability that a present key does not arm, because it is
 * the only one where Oracle initiates value movement without the user asking
 * for that specific action.
 */
export function autonomousTradingEnabled(env = process.env) {
  return String(env.ORACLE_AUTONOMOUS_TRADING ?? "").trim() === "1";
}

/**
 * Decide whether a capability may run.
 *
 * @param {string} capability   e.g. "nft:buy", "btc:execute"
 * @param {object} opts
 * @param {boolean} opts.userInitiated  the user asked for THIS action, now
 * @param {boolean} opts.autonomous     Oracle initiated it on its own
 */
export function capabilityStatus(capability, { env = process.env, userInitiated = false, autonomous = false } = {}) {
  const needed = CREDENTIAL_FOR[capability] ?? [];
  const keyPresent = needed.length === 0 || hasAnyEnv(needed, env);

  if (autonomous && !autonomousTradingEnabled(env)) {
    return {
      capability,
      armed: keyPresent,
      allowed: false,
      reason:
        "autonomous trading is off — set ORACLE_AUTONOMOUS_TRADING=1 to let Oracle act without an explicit request",
    };
  }

  if (!keyPresent) {
    return {
      capability,
      armed: false,
      allowed: false,
      reason: `no credential configured for ${capability} — set one of: ${needed.join(", ")}`,
    };
  }

  if (!userInitiated && !autonomous) {
    return {
      capability,
      armed: true,
      allowed: false,
      reason: "armed, but nothing runs until you ask for this action",
    };
  }

  return { capability, armed: true, allowed: true, reason: null };
}

/** Throwing form for call sites that should refuse rather than branch. */
export function assertCapability(capability, opts = {}) {
  const status = capabilityStatus(capability, opts);
  if (!status.allowed) {
    const err = new Error(`oracle: ${capability} not permitted — ${status.reason}`);
    err.status = status;
    throw err;
  }
  return status;
}

/** Human-readable posture for a status surface. */
export function posture(env = process.env) {
  const caps = Object.keys(CREDENTIAL_FOR);
  const armed = caps.filter((c) => capabilityStatus(c, { env, userInitiated: true }).allowed);
  return {
    model: "key-present = armed; user-initiated = runs; autonomous = opt-in",
    armed,
    autonomousTrading: autonomousTradingEnabled(env) ? "ENABLED" : "off",
    note: "Nothing executes unless you ask for it. Caps and simulation still apply to every action.",
  };
}
