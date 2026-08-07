import { spawnSync } from "node:child_process";
import path from "node:path";
import { fakeHome, buildServerSpecs, mergeMcpServers, report } from "./shared.mjs";

function claudeJsonPath() { return path.join(fakeHome(), ".claude.json"); }
function projectMcpPath(cwd) { return path.join(cwd || process.cwd(), ".mcp.json"); }

function tryClaudeCli(name, spec) {
  const probe = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 10000 });
  if (probe.error || probe.status !== 0) return null;
  const r = spawnSync("claude", ["mcp", "add-json", name, JSON.stringify(spec), "--scope", "user"], {
    encoding: "utf8", timeout: 30000,
  });
  if (r.status !== 0) return { ok: false, stderr: r.stderr || r.stdout || "failed" };
  return { ok: true };
}

export async function installClaudeCode({
  oracleRoot, operator, withControl = false, project = false, printOnly = false, cwd = process.cwd(),
}) {
  const built = buildServerSpecs({ oracleRoot, operator, withControl });
  if (!built.ok) return { ok: false, code: 3, reason: built.reason };
  if (printOnly) return { ok: true, print: { mcpServers: built.specs } };
  if (project) {
    const target = projectMcpPath(cwd);
    const result = mergeMcpServers(target, built.specs);
    return { ok: true, ...report(result.status, { path: target, backup: result.backup }) };
  }
  let usedCli = false;
  for (const [name, spec] of Object.entries(built.specs)) {
    const cli = tryClaudeCli(name, spec);
    if (cli && cli.ok) { usedCli = true; continue; }
    break;
  }
  if (usedCli) return { ok: true, ...report("written", { method: "claude-cli" }) };
  const target = claudeJsonPath();
  const result = mergeMcpServers(target, built.specs);
  return { ok: true, ...report(result.status, { path: target, backup: result.backup }) };
}
