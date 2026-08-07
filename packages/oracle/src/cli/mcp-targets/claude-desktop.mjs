import fs from "node:fs";
import path from "node:path";
import { fakeHome, buildServerSpecs, mergeMcpServers, report } from "./shared.mjs";

function desktopConfigPath() {
  if (process.platform === "darwin") {
    return path.join(fakeHome(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return path.join(fakeHome(), ".config", "Claude", "claude_desktop_config.json");
}

export async function installClaudeDesktop({ oracleRoot, operator, withControl = false, printOnly = false }) {
  const built = buildServerSpecs({ oracleRoot, operator, withControl });
  if (!built.ok) return { ok: false, code: 3, reason: built.reason };
  const target = desktopConfigPath();
  const payload = { mcpServers: built.specs };
  if (printOnly) return { ok: true, print: payload };
  const parent = path.dirname(target);
  if (!fs.existsSync(parent)) {
    return { ok: true, status: "printed (Claude Desktop not detected)", path: target, print: payload };
  }
  const result = mergeMcpServers(target, built.specs);
  return { ok: true, ...report(result.status, { path: target, backup: result.backup }) };
}
