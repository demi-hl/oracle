/**
 * Agent grants — the embeddable entry point.
 *
 * Bounded, revocable, time-boxed permission for an agent to act for a user,
 * where the user signs the grant and nobody ever holds their key. The pieces
 * were already here but spread across public-control and public-api, reachable
 * only by deep-importing internal paths. That is not something another team can
 * build against, so this is the seam: one import, one documented surface.
 *
 * What makes it worth extracting rather than reimplementing per project:
 *
 *   - The owner signs a rendered, human-readable policy. Not an opaque hash.
 *   - Every read is pure over an INJECTED store with an EXPLICIT clock, so the
 *     same inputs always produce the same answer and it is testable without a
 *     chain or a database.
 *   - Revocation is first-class, not an afterthought bolted on later.
 *   - `scanPublicReturn` enforces the no-secret invariant on anything that
 *     leaves this layer, so a refactor cannot quietly start returning a key.
 *
 * Custody: this module prepares and validates. It never signs, never
 * broadcasts, and never stores a private key. The custody boundary test walks
 * the real import graph to keep it that way.
 */

export {
  GRANT_STATUS,
  classifyGrant,
  listActiveGrants,
  getGrant,
} from "./grants.mjs";

export {
  ORCHESTRATOR_KINDS,
  scanPublicReturn,
  planConnection,
  activateSession,
  createSessionOrchestrator,
  revokeSession,
  describeActive,
} from "../public-control/session-orchestrator.mjs";

export * as policy from "../public-control/policy-schema.mjs";
export * as render from "../public-control/policy-render.mjs";

/**
 * Human summary of what this layer guarantees. Safe to serve publicly; used by
 * the docs gate to keep the claim and the code from drifting apart.
 */
export const GRANTS_POSTURE = Object.freeze({
  userSigns: true,
  houseCustody: false,
  storesPrivateKeys: false,
  revocable: true,
  timeBoxed: true,
  deterministicReads: true,
  note: "Oracle prepares and validates grants. The user signs; Oracle never holds a key.",
});
