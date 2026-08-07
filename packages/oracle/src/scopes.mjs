// Delegation scopes — mirrors the RH agent's Agent Connect model so a user's
// scoped key can only ever authorize actions on THEIR OWN wallet.

export const ALLOWED_SCOPES = new Set([
  "read:markets",
  "read:nfts",
  "read:positions",
  "watch:contracts",
  "prepare:trade",
  "prepare:mint",
  // Build verb. `prepare:build` produces a non-executable proposal describing
  // what would be created. `build:factory` authorizes actually calling an
  // ALLOWLISTED factory — never arbitrary bytecode. See public-control/build-registry.mjs
  "prepare:build",
  "build:factory",
  "agent:shadow",
  "agent:execute",
]);

export const EXECUTE_SCOPE = "agent:execute";
/** Authorizes a real factory call. Gated separately from agent:execute so that
 *  arming trading never implicitly arms contract creation. */
export const BUILD_SCOPE = "build:factory";

// Safe default: everything EXCEPT live execution and live building.
export const DEFAULT_SCOPES = [
  "read:markets",
  "read:nfts",
  "read:positions",
  "watch:contracts",
  "prepare:trade",
  "prepare:mint",
  "prepare:build",
  "agent:shadow",
];

/** Validate + dedupe requested scopes; empty falls back to DEFAULT_SCOPES. */
export function normalizeScopes(scopes) {
  const requested = Array.isArray(scopes) && scopes.length ? scopes : DEFAULT_SCOPES;
  const normalized = [...new Set(requested.map((s) => String(s).trim()).filter(Boolean))];
  const invalid = normalized.filter((s) => !ALLOWED_SCOPES.has(s));
  if (invalid.length) throw new Error(`Invalid scope: ${invalid.join(", ")}`);
  return normalized;
}
