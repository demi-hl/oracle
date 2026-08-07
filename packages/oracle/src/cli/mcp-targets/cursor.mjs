import path from "node:path";
import os from "node:os";
import { fakeHome, buildServerSpecs, mergeMcpServers, report } from "./shared.mjs";

function cursorMcpPath() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "mcp.json");
  }
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Roaming", "Cursor", "User", "globalStorage", "mcp.json");
  }
  return path.join(fakeHome(), ".config", "cursor", "mcp.json");
}

export async function installCursor({
  oracleRoot, operator, withControl = false, project = false, printOnly = false, cwd = process.cwd(),
}) {
  const built = buildServerSpecs({ oracleRoot, operator, withControl });
  if (!built.ok) return { ok: false, code: 3, reason: built.reason };
  if (printOnly) {
    return {
      ok: true,
      printText: [
        'Add this to your Cursor MCP config (Cmd+Shift+P → "MCP: Open Configuration"):',
        JSON.stringify({ mcpServers: built.specs }, null, 2),
      ].join("\n\n"),
    };
  }
  const target = cursorMcpPath();
  const result = mergeMcpServers(target, built.specs);
  return { ok: true, ...report(result.status, { path: target, backup: result.backup }) };
}