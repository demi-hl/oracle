import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listMessagingPlatforms,
  findMessagingPlatform,
  renderSetupMenu,
} from "./messaging-platforms.mjs";
import { hermesRoot, ensureDir, oracleConfigDir } from "./paths.mjs";

const SECRETISH = /(TOKEN|SECRET|PASSWORD|KEY|AUTH|PRIVATE|MNEMONIC|SEED)/i;

export function profileEnvPath(profile = "oracle") {
  return path.join(hermesRoot(), "profiles", profile, ".env");
}

export function parseDotEnv(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function readProfileEnv(profile = "oracle") {
  const p = profileEnvPath(profile);
  if (!fs.existsSync(p)) return {};
  return parseDotEnv(fs.readFileSync(p, "utf8"));
}

export function writeProfileEnvKey(profile, key, value) {
  if (!key || SECRETISH.test(key) === false && /[^A-Z0-9_]/.test(key)) {
    // keep simple env keys
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    const err = new Error(`invalid env key '${key}'`);
    err.code = "BAD_KEY";
    throw err;
  }
  if (value == null || String(value).trim() === "") {
    const err = new Error(`empty value for ${key}`);
    err.code = "EMPTY";
    throw err;
  }
  const p = profileEnvPath(profile);
  ensureDir(path.dirname(p));
  let text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const lines = text ? text.split(/\r?\n/) : [];
  const next = [];
  let replaced = false;
  const assignment = `${key}=${String(value)}`;
  for (const line of lines) {
    if (line.startsWith(`${key}=`)) {
      next.push(assignment);
      replaced = true;
    } else if (line.length || next.length) {
      next.push(line);
    }
  }
  if (!replaced) {
    if (next.length && next[next.length - 1] !== "") next.push("");
    next.push(assignment);
  }
  while (next.length && next[next.length - 1] === "") next.pop();
  next.push("");
  fs.writeFileSync(p, next.join("\n"), { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // best effort on platforms that ignore mode
  }
  return { path: p, key, set: true };
}

export function platformStatus(profile = "oracle") {
  const env = readProfileEnv(profile);
  const statuses = {};
  for (const p of listMessagingPlatforms()) {
    if (!p.required.length) {
      statuses[p.key] = "manual";
      continue;
    }
    const missing = p.required.filter((k) => !String(env[k] || "").trim());
    statuses[p.key] = missing.length ? "unset" : "ready";
  }
  return { profile, statuses, envPath: profileEnvPath(profile) };
}

export function renderStatus(profile = "oracle") {
  const { statuses } = platformStatus(profile);
  return renderSetupMenu({ profile, statuses });
}

export function setPlatformToken(profile, platformKey, token, extra = {}) {
  const platform = findMessagingPlatform(platformKey);
  if (!platform) {
    const err = new Error(`unknown platform '${platformKey}'`);
    err.code = "UNKNOWN_PLATFORM";
    throw err;
  }
  if (!platform.required.length) {
    const err = new Error(
      `${platform.key} uses hermes interactive setup (oracle setup messaging)`,
    );
    err.code = "NEEDS_INTERACTIVE";
    throw err;
  }
  const primary = platform.required[0];
  writeProfileEnvKey(profile, primary, token);
  for (const [k, v] of Object.entries(extra || {})) {
    if (v != null && String(v).trim()) writeProfileEnvKey(profile, k, v);
  }
  return {
    platform: platform.key,
    set: platform.required,
    profile,
    path: profileEnvPath(profile),
  };
}

export function setupStatePath() {
  return path.join(oracleConfigDir(), "setup-state.json");
}

export function touchSetupState(patch = {}) {
  ensureDir(oracleConfigDir());
  const p = setupStatePath();
  let cur = {};
  if (fs.existsSync(p)) {
    try {
      cur = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      cur = {};
    }
  }
  const next = {
    ...cur,
    ...patch,
    updatedAt: new Date().toISOString(),
    host: os.hostname(),
  };
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

export default {
  profileEnvPath,
  parseDotEnv,
  readProfileEnv,
  writeProfileEnvKey,
  platformStatus,
  renderStatus,
  setPlatformToken,
  setupStatePath,
  touchSetupState,
};
