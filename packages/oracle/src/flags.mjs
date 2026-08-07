/** Global kill-switch shared by sign adapters + local signer. */
import { envFlag } from "./oracle-env.mjs";

export function executeGloballyEnabled() {
  return envFlag("ORACLE_EXECUTE_ENABLED", "MAD_EXECUTE_ENABLED", false);
}

/**
 * Separate kill-switch for the BUILD verb (deploying new contracts through
 * allowlisted factories). Deliberately NOT the same flag as execute: arming
 * trading must never silently arm contract creation. Off by default.
 */
export function deployGloballyEnabled() {
  return envFlag("ORACLE_DEPLOY_ENABLED", "MAD_DEPLOY_ENABLED", false);
}
