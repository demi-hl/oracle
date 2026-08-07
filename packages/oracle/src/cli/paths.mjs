import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, "../..");

export function homeDir() {
  return process.env.ORACLE_FAKE_HOME || os.homedir();
}

// In the packaged public desktop the app owns its own config root. Legacy
// fallbacks that reach into a private operator/desk directory on the host must
// resolve to the app-owned dir instead, so an operator install on the same
// machine can never be inherited by the desktop lane.
export function isPublicDesktop() {
  return process.env.ORACLE_PUBLIC_DESKTOP === "1";
}

export function oracleConfigDir() {
  if (isPublicDesktop()) {
    return process.env.ORACLE_CONFIG_DIR || path.join(homeDir(), ".config", "oracle");
  }
  return path.join(homeDir(), ".config", "oracle");
}

export function oracleExecEnvPath() {
  return path.join(oracleConfigDir(), "exec.env");
}

export function hermesRoot() {
  if (process.env.HERMES_HOME) return path.resolve(process.env.HERMES_HOME);
  return path.join(homeDir(), ".hermes");
}

export function claudeCodeUserConfigPath() {
  return path.join(homeDir(), ".claude.json");
}

export function claudeCodeProjectMcpPath(cwd = process.cwd()) {
  return path.join(cwd, ".mcp.json");
}

export function claudeDesktopConfigPath() {
  if (process.platform === "darwin") {
    return path.join(homeDir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return path.join(homeDir(), ".config", "Claude", "claude_desktop_config.json");
}

export function codexConfigPath() {
  return path.join(homeDir(), ".codex", "config.toml");
}

export function chatgptConnectorDir() {
  return path.join(oracleConfigDir(), "connectors");
}

export function chatgptOpenApiPath() {
  return path.join(chatgptConnectorDir(), "chatgpt-openapi.json");
}

export function activeChainPath() {
  return path.join(oracleConfigDir(), "active-chain.json");
}

// Sibling bins move between `bin/` (source tree) and `dist/bin/` (published
// bundle), and PACKAGE_ROOT is computed from whichever file bundled paths.mjs
// in. When the kernel is entered through `dist/bin/oracle.mjs`, PACKAGE_ROOT
// lands on the package root and a fixed `bin/` join points at a directory that
// does not ship — so `oracle init`, `oracle scan`, `oracle route`, and every
// other dispatched subcommand died with MODULE_NOT_FOUND for every installer
// while the standalone `oracle-init` bin worked fine. Check both layouts.
export function packageBin(name) {
  const candidates = [
    path.join(PACKAGE_ROOT, "bin", name),
    path.join(PACKAGE_ROOT, "dist", "bin", name),
    path.join(PACKAGE_ROOT, "..", "bin", name),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const paths = {
  homeDir,
  isPublicDesktop,
  oracleConfigDir,
  oracleExecEnvPath,
  hermesRoot,
  activeChainPath,
  claudeCodeUserConfigPath,
  claudeCodeProjectMcpPath,
  claudeDesktopConfigPath,
  codexConfigPath,
  chatgptConnectorDir,
  chatgptOpenApiPath,
  packageBin,
  ensureDir,
  PACKAGE_ROOT,
};

export default paths;
