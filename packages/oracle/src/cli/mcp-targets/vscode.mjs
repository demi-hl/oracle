import path from "node:path";
import os from "node:os";
import { fakeHome, buildServerSpecs, mergeMcpServers, report, readJson, writeJson, backupFile } from "./shared.mjs";

function vscodeGlobalMcpPath() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Code", "User", "globalStorage", "mcp.json");
  }
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Roaming", "Code", "User", "globalStorage", "mcp.json");
  }
  return path.join(fakeHome(), ".config", "Code", "User", "globalStorage", "mcp.json");
}

function vscodeWorkspaceMcpPath(cwd) {
  return path.join(cwd || process.cwd(), ".vscode", "mcp.json");
}

export async function installVscode({
  oracleRoot, operator, withControl = false, project = false, printOnly = false, cwd = process.cwd(),
}) {
  const built = buildServerSpecs({ oracleRoot, operator, withControl });
  if (!built.ok) return { ok: false, code: 3, reason: built.reason };
  if (printOnly) {
    return {
      ok: true,
      printText: [
        'Add this to your VS Code MCP config (.vscode/mcp.json):',
        JSON.stringify({ mcpServers: built.specs }, null, 2),
        "",
        "Alternatively, add to VS Code settings.json:",
        `"mcp.servers": ${JSON.stringify(built.specs, null, 2)}`,
      ].join("\n"),
    };
  }
  const target = project ? vscodeWorkspaceMcpPath(cwd) : vscodeGlobalMcpPath();
  const result = mergeMcpServers(target, built.specs);
  return { ok: true, ...report(result.status, { path: target, backup: result.backup }) };
}