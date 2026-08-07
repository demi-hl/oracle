import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PUBLIC_DESKTOP = process.env.ORACLE_PUBLIC_DESKTOP === "1";

export const ORACLE_CONFIG_DIR = PUBLIC_DESKTOP
  ? (process.env.ORACLE_CONFIG_DIR || join(homedir(), ".config", "oracle"))
  : join(homedir(), ".config", "oracle");
// Legacy config dir from before the rename. Kept so existing installs keep
// working; new installs only ever see ~/.config/oracle. The packaged public
// desktop never consults it — it owns its own config root, so an operator/desk
// install on the same machine cannot be inherited.
export const LEGACY_CONFIG_DIR = PUBLIC_DESKTOP
  ? ORACLE_CONFIG_DIR
  : join(homedir(), ".config", "mad-desk");

export function env(primary, legacy, fallback = "") {
  const pv = process.env[primary];
  if (pv != null && String(pv).trim() !== "") return pv;
  const lv = legacy ? process.env[legacy] : undefined;
  if (lv != null && String(lv).trim() !== "") return lv;
  return fallback;
}

export function envFlag(primary, legacy, defaultValue = false) {
  const fallback = defaultValue ? "1" : "";
  return String(env(primary, legacy, fallback)).trim() === "1";
}

const DISABLE_WORDS = ["0", "false", "off", "no"];

// Reading a flag that may default ON. Only an explicit disable word turns it
// off, and an unset value keeps `defaultValue`.
//
// The old shape (`!== "0"`) inverted with a false default: ORACLE_ONBOARD_HTTP
// defaults off, so a user writing `false` to keep it off actually ENABLED it,
// because "false" is not "0". A disable word must never enable a surface.
export function envEnabled(primary, legacy, defaultValue = true) {
  const raw = String(env(primary, legacy, "")).trim().toLowerCase();
  if (raw === "") return defaultValue;
  return !DISABLE_WORDS.includes(raw);
}

export function csvEnv(primary, legacy) {
  return String(env(primary, legacy, ""));
}

export function configPath(file, primary, legacy) {
  const explicit = env(primary, legacy, "");
  if (explicit) return explicit;
  const oraclePath = join(ORACLE_CONFIG_DIR, file);
  if (existsSync(oraclePath)) return oraclePath;
  return join(LEGACY_CONFIG_DIR, file);
}
