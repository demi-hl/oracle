// Shared secret resolution for attestation modules.
//
// Attestations are minted inside the trusted boundary to bind a dynamic execution
// target (a route, a vault, a GMX order) so that model-authored JSON cannot become
// authorization on its own. That makes the secret's LOOKUP path security-relevant:
// reading it from a wrong or attacker-writable location is as bad as leaking it.
//
// Extracted here because three modules had drifted into three near-identical copies,
// each carrying a hardcoded operator home directory -- which is both a leak of the
// author's environment and simply broken for anyone else, since a public user has no
// matching private home path.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Candidate env-file locations, in priority order.
 *
 * Resolved from the CURRENT user's home, never a baked-in absolute path.
 */
function envFileCandidates() {
  // Under test, do NOT read the developer's real ~/.config secrets. A suite
  // that silently picks up a secret on the maintainer's box and finds none on a
  // contributor's machine is not reproducible, and the difference shows up as
  // mysterious pass/fail drift rather than an honest failure.
  if (process.env.ORACLE_TEST_ISOLATE_SECRETS === "1") {
    const explicitOnly = (process.env.ORACLE_EXEC_ENV_FILE || "").trim();
    return explicitOnly ? [explicitOnly] : [];
  }

  const explicit = (
    process.env.ORACLE_EXEC_ENV_FILE ||
    process.env.MAD_EXEC_ENV_FILE || // legacy name, kept for existing deployments
    ""
  ).trim();

  const home = homedir();
  // The packaged public desktop owns its own config root and must never inherit
  // a private operator/desk env file that happens to exist on the host.
  if (process.env.ORACLE_PUBLIC_DESKTOP === "1") {
    const owned = (process.env.ORACLE_CONFIG_DIR || join(home, ".config", "oracle")).trim();
    return [explicit, join(owned, "exec.env")].filter(Boolean);
  }
  return [
    explicit,
    join(home, ".config", "oracle", "exec.env"),
    join(home, ".config", "mad-desk", "exec.env"), // legacy dir
  ].filter(Boolean);
}

/**
 * Resolve an attestation secret.
 *
 * Order: explicit argument, then env var, then an env FILE. The file fallback exists
 * so a long-lived deployment can keep the secret out of the process environment
 * (where it would show up in `ps` output and child processes).
 *
 * @param {string|undefined} secret explicit override
 * @param {string} primaryEnv e.g. "ORACLE_ROUTE_ATTESTATION_SECRET"
 * @param {string} legacyEnv e.g. "MAD_ROUTE_ATTESTATION_SECRET"
 * @returns {string}
 * @throws when no secret can be found -- fail closed, never mint unsigned
 */
export function resolveAttestationSecret(secret, primaryEnv, legacyEnv) {
  let value = secret ?? process.env[primaryEnv] ?? process.env[legacyEnv];

  if (!String(value || "").trim()) {
    for (const envFile of envFileCandidates()) {
      try {
        const txt = readFileSync(envFile, "utf8");
        // Accept either name in the file, primary winning.
        const m =
          txt.match(new RegExp(`^${primaryEnv}=(.*)$`, "m")) ||
          txt.match(new RegExp(`^${legacyEnv}=(.*)$`, "m"));
        if (m) {
          value = m[1].trim();
          if (value) break;
        }
      } catch {
        // Unreadable or absent: try the next candidate. A missing optional file is
        // not an error; running out of candidates is, and that is handled below.
      }
    }
  }

  if (!String(value || "").trim()) {
    throw new Error(
      `${primaryEnv} required for attestation. Set it in the environment, or place ` +
        `${primaryEnv}=<value> in ~/.config/oracle/exec.env`,
    );
  }
  return value;
}
