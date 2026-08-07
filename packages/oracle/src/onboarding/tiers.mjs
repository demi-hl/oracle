// Product onboarding tiers — multi-user, non-custodial.
// Tier chooses default scopes. Higher tiers never put user private keys on our box.

import { DEFAULT_SCOPES, EXECUTE_SCOPE } from "../scopes.mjs";
import { createAgentKey, listAgentKeys, revokeAgentKey, authenticateAgentKey } from "./agent-keys.mjs";

/**
 * Tier catalog (product story):
 * - observer:   read-only market/position data
 * - preparer:   can prepare trades/mints (unsigned / advisory)
 * - shadow:     paper/shadow agent loops
 * - executor:   live agent:execute — ONLY if owner is on controller allowlist
 * - local_signer: no API key needed for signing; user signs off-infra (docs only)
 */
export const TIERS = {
  observer: {
    id: "observer",
    label: "Observer",
    description: "Read markets, NFTs, positions. No prepare/execute.",
    scopes: ["read:markets", "read:nfts", "read:positions"],
    custody: "none",
    canExecute: false,
  },
  preparer: {
    id: "preparer",
    label: "Preparer",
    description: "Prepare trades/mints; user or operator co-signs. No live execute scope.",
    scopes: [...DEFAULT_SCOPES].filter((s) => s !== "agent:shadow"),
    custody: "none",
    canExecute: false,
  },
  shadow: {
    id: "shadow",
    label: "Shadow agent",
    description: "Full prepare + agent:shadow paper loops. Still no live execute.",
    scopes: [...DEFAULT_SCOPES],
    custody: "none",
    canExecute: false,
  },
  executor: {
    id: "executor",
    label: "Executor (controller)",
    description:
      "Live agent:execute on the owner's own wallet only. Owner must be an executor controller. Key is NOT a wallet key.",
    scopes: [...DEFAULT_SCOPES, EXECUTE_SCOPE],
    custody: "none — scoped API key only; user wallet key never stored",
    canExecute: true,
  },
  local_signer: {
    id: "local_signer",
    label: "Local signer",
    description:
      "User keeps keys on their device. Desk issues prepare-only key; signing happens off our infra.",
    scopes: ["read:markets", "read:positions", "prepare:trade", "prepare:mint"],
    custody: "none — signing off-box",
    canExecute: false,
    mintKey: true,
  },
};

export function listTiers() {
  return Object.values(TIERS).map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
    scopes: t.scopes,
    custody: t.custody,
    canExecute: t.canExecute,
  }));
}

export function getTier(id) {
  const t = TIERS[id];
  if (!t) throw new Error(`Unknown tier: ${id}`);
  return t;
}

/**
 * Onboard a user wallet onto a tier. Returns one-time raw API key (except pure docs).
 * NEVER accepts or stores a private key.
 */
export function onboardUser({
  owner,
  tier = "observer",
  name,
  controllerAllowlist = [],
  storePath,
  scopes, // optional override
} = {}) {
  if (owner && typeof owner === "object" && owner.privateKey) {
    throw new Error("Refusing privateKey — non-custodial onboarding accepts owner address only");
  }
  const t = getTier(tier);
  const finalScopes = scopes || t.scopes;
  const result = createAgentKey({
    owner,
    name: name || `${t.label} key`,
    scopes: finalScopes,
    tier: t.id,
    controllerAllowlist,
    storePath,
  });
  return {
    tier: t.id,
    custody: t.custody,
    canExecute: t.canExecute && finalScopes.includes(EXECUTE_SCOPE),
    key: result.key, // show once
    record: result.record,
    nextSteps:
      t.id === "local_signer"
        ? [
            "Store the API key for prepare/read calls only",
            "Keep your wallet key on your device / hardware signer",
            "Submit prepared payloads to your local signer — never upload the key here",
          ]
        : t.canExecute
          ? [
              "Store the API key securely",
              "Live execute stays disabled until the separately installed operator enables it",
              "This key can only act on YOUR owner wallet (custody firewall)",
            ]
          : [
              "Store the API key securely",
              "Use with getSigner({ identity: auth.identity, venue }) after authenticateAgentKey",
            ],
  };
}

export function onboardAuthenticate(rawKey, opts) {
  return authenticateAgentKey(rawKey, opts);
}

export function onboardListKeys(owner, opts) {
  return listAgentKeys(owner, opts);
}

export function onboardRevoke(opts) {
  return revokeAgentKey(opts);
}
