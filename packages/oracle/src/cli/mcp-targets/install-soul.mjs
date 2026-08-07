import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { backupFile, readJson, writeJson } from "./shared.mjs";

const SOUL_SOURCE = join(dirname(new URL(import.meta.url).pathname), "..", "..", "..", "profiles", "oracle", "SOUL.md");

function loadSoul() {
  // Try the bundled path first, then the npm package path
  const candidates = [
    SOUL_SOURCE,
    join(homedir(), ".config", "oracle", "SOUL.md"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error("SOUL.md not found — run 'oracle bootstrap' first");
}

/**
 * Install Oracle's SOUL into the target AI client as a system prompt.
 */
export async function installSoul(target, { cwd = process.cwd(), printOnly = false } = {}) {
  const soul = loadSoul();

  if (target === "claude-code" || target === "claude") {
    const claudeMd = join(cwd, "CLAUDE.md");
    const existing = existsSync(claudeMd) ? readFileSync(claudeMd, "utf8") : "";
    
    // Prepend SOUL before existing CLAUDE.md
    const newContent = `# Oracle Agent Instructions\n${soul}\n---\n${existing}`;
    
    if (printOnly) {
      return { ok: true, printText: `# Would write to ${claudeMd}:\n\n${newContent.slice(0, 500)}...`, status: "printed" };
    }

    const bak = backupFile(claudeMd);
    writeFileSync(claudeMd, newContent, "utf8");
    return { ok: true, path: claudeMd, backup: bak, status: "installed" };
  }

  if (target === "cursor") {
    const cursorRules = join(cwd, ".cursorrules");
    const existing = existsSync(cursorRules) ? readFileSync(cursorRules, "utf8") : "";
    const newContent = `# Oracle Agent Instructions\n${soul}\n---\n${existing}`;

    if (printOnly) {
      return { ok: true, printText: `# Would write to ${cursorRules}:\n\n${newContent.slice(0, 500)}...`, status: "printed" };
    }

    const bak = backupFile(cursorRules);
    writeFileSync(cursorRules, newContent, "utf8");
    return { ok: true, path: cursorRules, backup: bak, status: "installed" };
  }

  if (target === "claude-desktop") {
    // Claude Desktop reads from a custom instructions field in its config
    const configPath = join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    if (!existsSync(configPath)) {
      return { ok: false, reason: "Claude Desktop config not found. Open Claude Desktop once first, then retry." };
    }

    const config = readJson(configPath);
    
    if (printOnly) {
      return { ok: true, printText: `# Would add Oracle SOUL to Claude Desktop custom instructions\n\n${soul.slice(0, 500)}...`, status: "printed" };
    }

    const bak = backupFile(configPath);
    config.customInstructions = config.customInstructions || "";
    config.customInstructions = `# Oracle Agent Instructions\n${soul}\n---\n${config.customInstructions}`;
    writeJson(configPath, config);
    return { ok: true, path: configPath, backup: bak, status: "installed" };
  }

  if (target === "codex" || target === "copilot") {
    // GitHub Copilot/Codex: write to .github/copilot-instructions.md
    const instructionsDir = join(cwd, ".github");
    const instructionsPath = join(instructionsDir, "copilot-instructions.md");
    const existing = existsSync(instructionsPath) ? readFileSync(instructionsPath, "utf8") : "";

    if (printOnly) {
      return { ok: true, printText: `# Would write to ${instructionsPath}:\n\n${soul.slice(0, 500)}...`, status: "printed" };
    }

    if (!existsSync(instructionsDir)) mkdirSync(instructionsDir, { recursive: true });
    const bak = backupFile(instructionsPath);
    writeFileSync(instructionsPath, `${soul}\n---\n${existing}`, "utf8");
    return { ok: true, path: instructionsPath, backup: bak, status: "installed" };
  }

  if (target === "vscode" || target === "vs-code") {
    // VS Code: write to .vscode/instructions.md (Copilot custom instructions)
    const vscodeDir = join(cwd, ".vscode");
    const instructionsPath = join(vscodeDir, "instructions.md");

    if (printOnly) {
      return { ok: true, printText: `# Would write to ${instructionsPath}:\n\n${soul.slice(0, 500)}...`, status: "printed" };
    }

    if (!existsSync(vscodeDir)) mkdirSync(vscodeDir, { recursive: true });
    const bak = backupFile(instructionsPath);
    writeFileSync(instructionsPath, `${soul}\n`, "utf8");
    return { ok: true, path: instructionsPath, backup: bak, status: "installed" };
  }

  return { ok: false, reason: `--with-soul not supported for target '${target}'` };
}