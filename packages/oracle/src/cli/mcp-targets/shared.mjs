import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PACKAGE_ROOT, packageBin } from "../paths.mjs";

export function fakeHome() {
  return process.env.ORACLE_FAKE_HOME || os.homedir();
}

export function buildServerSpecs({ oracleRoot = PACKAGE_ROOT, operator = null, withControl = false } = {}) {
  // Resolve through the same both-layouts helper the kernel uses: the bundled
  // artifact ships bins under dist/bin/, so a fixed <root>/bin/ join emitted an
  // MCP config pointing at a file that does not exist in a real install.
  const dataMcp = oracleRoot === PACKAGE_ROOT
    ? packageBin("oracle-data-mcp.mjs")
    : [
        path.join(oracleRoot, "bin", "oracle-data-mcp.mjs"),
        path.join(oracleRoot, "dist", "bin", "oracle-data-mcp.mjs"),
      ].find((candidate) => fs.existsSync(candidate)) || path.join(oracleRoot, "bin", "oracle-data-mcp.mjs");

  const specs = {
    "oracle-data": {
      command: "node",
      args: [dataMcp],
    },
  };
  if (withControl) {
    if (!operator || !operator.ok) return { ok: false, reason: "operator-missing" };
    const control = operator.bins?.["oracle-control-mcp"] || operator.controlMcp || null;
    if (!control) return { ok: false, reason: "control-bin-missing" };
    specs["oracle-control"] = { command: "node", args: [control] };
  }
  return { ok: true, specs };
}

export function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const bak = `${filePath}.bak-oracle-${Math.floor(Date.now() / 1000)}`;
  fs.copyFileSync(filePath, bak);
  return bak;
}

export function readJson(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return structuredClone(fallback);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n");
}

export function mergeMcpServers(filePath, specs) {
  const existing = readJson(filePath, {});
  if (!existing.mcpServers || typeof existing.mcpServers !== "object") existing.mcpServers = {};
  let changed = false;
  for (const [name, spec] of Object.entries(specs)) {
    const prev = existing.mcpServers[name];
    if (prev && JSON.stringify(prev) === JSON.stringify(spec)) continue;
    existing.mcpServers[name] = spec;
    changed = true;
  }
  if (!changed) return { status: "present", backup: null };
  const backup = backupFile(filePath);
  writeJson(filePath, existing);
  return { status: "written", backup };
}

export function report(status, detail = {}) {
  return { status, ...detail };
}
