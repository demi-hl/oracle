import fs from "node:fs";
import path from "node:path";
import { fakeHome, buildServerSpecs, backupFile, report } from "./shared.mjs";

const BEGIN = "# oracle-mcp-install begin";
const END = "# oracle-mcp-install end";

function codexPath() { return path.join(fakeHome(), ".codex", "config.toml"); }

function renderBlock(specs) {
  const lines = [BEGIN];
  for (const [name, spec] of Object.entries(specs)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`command = ${JSON.stringify(spec.command)}`);
    lines.push(`args = [${spec.args.map((a) => JSON.stringify(a)).join(", ")}]`);
    lines.push("");
  }
  lines.push(END);
  return lines.join("\n") + "\n";
}

function stripExistingBlock(text) {
  return text.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`, "g"), "");
}

export async function installCodex({ oracleRoot, operator, withControl = false, printOnly = false }) {
  const built = buildServerSpecs({ oracleRoot, operator, withControl });
  if (!built.ok) return { ok: false, code: 3, reason: built.reason };
  const block = renderBlock(built.specs);
  const target = codexPath();
  if (printOnly) return { ok: true, printText: block, path: target };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const prev = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (prev.includes(block.trim())) return { ok: true, ...report("present", { path: target, backup: null }) };
  const stripped = stripExistingBlock(prev);
  const next = (stripped.trimEnd() + "\n\n" + block).replace(/^\n+/, "");
  if (prev.trim() === next.trim()) return { ok: true, ...report("present", { path: target, backup: null }) };
  const backup = prev ? backupFile(target) : null;
  fs.writeFileSync(target, next.endsWith("\n") ? next : next + "\n");
  return { ok: true, ...report("written", { path: target, backup }) };
}
