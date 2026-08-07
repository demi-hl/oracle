import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

export const UPGRADE_VERSION = "oracle-profile-upgrade/v1";

function exists(file) {
  try { fs.accessSync(file); return true; } catch { return false; }
}

function snapshot(dir) {
  if (!exists(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath || entry.path, entry.name))
    .sort()
    .map((file) => [path.relative(dir, file), fs.readFileSync(file)]);
}

function desiredTree(source) {
  const files = snapshot(source);
  files.push([".oracle-upgrade-version", Buffer.from(`${UPGRADE_VERSION}\n`)]);
  return files.sort(([a], [b]) => a.localeCompare(b));
}

function treeMatches(dest, files) {
  const actual = snapshot(dest);
  return actual.length === files.length && actual.every(([name, body], i) =>
    name === files[i][0] && body.equals(files[i][1]));
}

function tempSibling(target) {
  return `${target}.tmp-oracle-upgrade-${process.pid}-${randomBytes(6).toString("hex")}`;
}

function backupName(target) {
  let candidate = `${target}.bak-oracle-upgrade`;
  for (let n = 1; exists(candidate); n += 1) candidate = `${target}.bak-oracle-upgrade-${n}`;
  return candidate;
}

function installTree(source, dest, apply, report) {
  if (!exists(source) || !fs.statSync(source).isDirectory()) return;
  const files = desiredTree(source);
  if (treeMatches(dest, files)) {
    report.unchanged.push(dest);
    return;
  }
  const wasPresent = exists(dest);
  (wasPresent ? report.updated : report.created).push(dest);
  if (!apply) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = tempSibling(dest);
  let backup = null;
  fs.mkdirSync(tmp);
  try {
    for (const [name, body] of files) {
      const out = path.join(tmp, name);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, body);
    }
    if (wasPresent) {
      backup = backupName(dest);
      fs.renameSync(dest, backup);
      report.backups.push({ path: backup, original: dest });
    }
    fs.renameSync(tmp, dest);
  } catch (error) {
    if (exists(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
    if (backup && !exists(dest) && exists(backup)) fs.renameSync(backup, dest);
    throw error;
  }
}

// This deliberately accepts only the ordinary block-style YAML Hermes writes.
// Unsupported constructs fail closed rather than risking a lossy rewrite.
function validateYaml(text, file) {
  if (/^mcp_servers:[ \t]*(?!\{\}[ \t]*(?:#.*)?$)\S+/m.test(text)) {
    throw new Error(`${file}: mcp_servers must be a block mapping`);
  }
  const stack = [];
  const keys = new Map();
  const lines = text.split(/\r?\n/);
  let flow = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (/^\s*#/.test(raw)) continue;
    if (/^\s*\t|^ +\t/.test(raw)) throw new Error(`${file}:${index + 1}: tabs are not supported in YAML indentation`);
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || /^\s*(?:---|\.\.\.)\s*$/.test(line)) continue;
    const quoteFree = line.replace(/'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"/g, "");
    for (const char of quoteFree) {
      if ("[{".includes(char)) flow += 1;
      if ("]}".includes(char)) flow -= 1;
      if (flow < 0) throw new Error(`${file}:${index + 1}: unbalanced flow collection`);
    }
    if (/^\s*[^#\-][^:]*:\s*(?:.*)?$/.test(line)) {
      const indent = line.match(/^ */)[0].length;
      const key = line.trimStart().match(/^([^:]+):/)[1].trim();
      while (stack.length && stack.at(-1).indent >= indent) stack.pop();
      const parent = stack.map((item) => item.key).join("/");
      const id = `${parent}|${indent}|${key}`;
      if (keys.has(id)) throw new Error(`${file}:${index + 1}: duplicate mapping key ${key}`);
      keys.set(id, true);
      if (/^[^:]+:\s*(?:#.*)?$/.test(line.trimStart())) stack.push({ indent, key });
    } else if (!/^\s*-\s+/.test(line) && flow === 0) {
      throw new Error(`${file}:${index + 1}: unsupported or malformed YAML`);
    }
  }
  if (flow !== 0) throw new Error(`${file}: unbalanced flow collection`);
  if (/^\s*[^#\n]*:\s*[>|][+-]?\s*$/m.test(text)) {
    // Block scalars are safe to preserve outside mcp_servers, but editing inside
    // one would require a complete YAML parser.
    const mcp = topLevelBlock(text, "mcp_servers");
    if (mcp && /:\s*[>|][+-]?\s*$/m.test(mcp.body)) throw new Error(`${file}: block scalars inside mcp_servers are unsupported`);
  }
}

function topLevelBlock(text, name) {
  const re = new RegExp(`^${name}:[^\\S\\r\\n]*(?:#.*)?$`, "m");
  const match = re.exec(text);
  if (!match) return null;
  const start = match.index;
  const bodyStart = text.indexOf("\n", start) + 1;
  if (!bodyStart) return { start, end: text.length, bodyStart: text.length, body: "" };
  const rest = text.slice(bodyStart);
  const next = /^(?=\S[^\r\n]*:)/m.exec(rest);
  const end = next ? bodyStart + next.index : text.length;
  return { start, bodyStart, end, body: text.slice(bodyStart, end) };
}

function scalar(value) {
  return JSON.stringify(value);
}

function serverBlock(name, command) {
  const words = command.command === "node" ? [command.script] : command.args;
  const lines = [`  ${name}:`, `    command: ${scalar(command.command)}`];
  if (words?.length) lines.push("    args:", ...words.map((arg) => `      - ${scalar(arg)}`));
  lines.push("    enabled: true", `    # ${UPGRADE_VERSION}`);
  return `${lines.join("\n")}\n`;
}

function mergeMcp(text, desired) {
  text = text.replace(
    /^(mcp_servers:)\s*\{\}\s*(#.*)?$/m,
    (_line, head, comment) => `${head}${comment ? ` ${comment}` : ""}`,
  );
  const block = topLevelBlock(text, "mcp_servers");
  if (!block) {
    const prefix = text.length && !text.endsWith("\n") ? "\n" : "";
    return `${text}${prefix}mcp_servers:\n${[...desired].map(([n, c]) => serverBlock(n, c)).join("")}`;
  }
  let body = block.body;
  for (const [name, command] of desired) {
    const child = new RegExp(`^  ${name}:[^\\S\\r\\n]*(?:#.*)?\\r?\\n(?:^(?: {3,}|\\s*$).*\\r?\\n?)*`, "m");
    const replacement = serverBlock(name, command);
    body = child.test(body) ? body.replace(child, replacement) : `${body}${body && !body.endsWith("\n") ? "\n" : ""}${replacement}`;
  }
  return `${text.slice(0, block.bodyStart)}${body}${text.slice(block.end)}`;
}

function mergeEnabledPlugin(text, pluginId) {
  text = text.replace(
    /^(plugins:)\s*\{\}\s*(#.*)?$/m,
    (_line, head, comment) => `${head}${comment ? ` ${comment}` : ""}`,
  );
  const item = `    - ${scalar(pluginId)}\n`;
  const block = topLevelBlock(text, "plugins");
  if (!block) {
    const prefix = text.length && !text.endsWith("\n") ? "\n" : "";
    return `${text}${prefix}plugins:\n  enabled:\n${item}`;
  }
  let body = block.body;
  const flow = /^  enabled:\s*\[([^\]]*)\](.*)$/m.exec(body);
  if (flow) {
    const values = flow[1].split(",").map((value) => value.trim().replace(/^["']|["']$/g, ""));
    if (!values.includes(pluginId)) {
      const joined = flow[1].trim() ? `${flow[1].trimEnd()}, ${scalar(pluginId)}` : scalar(pluginId);
      body = body.replace(flow[0], `  enabled: [${joined}]${flow[2]}`);
    }
  } else {
    const sequence = /^  enabled:\s*(?:#.*)?\r?\n((?:^ {4}-.*\r?\n?)*)/m.exec(body);
    if (sequence) {
      const values = sequence[1].split(/\r?\n/).map((line) => line.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, ""));
      if (!values.includes(pluginId)) body = body.replace(sequence[0], `${sequence[0]}${item}`);
    } else {
      body = `${body}${body && !body.endsWith("\n") ? "\n" : ""}  enabled:\n${item}`;
    }
  }
  return `${text.slice(0, block.bodyStart)}${body}${text.slice(block.end)}`;
}

function writeAtomic(file, body, report) {
  const present = exists(file);
  const old = present ? fs.readFileSync(file, "utf8") : null;
  if (old === body) { report.unchanged.push(file); return; }
  (present ? report.updated : report.created).push(file);
  if (!report.applied) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (present) {
    const backup = backupName(file);
    fs.copyFileSync(file, backup);
    report.backups.push({ path: backup, original: file });
  }
  const tmp = tempSibling(file);
  try {
    fs.writeFileSync(tmp, body, { mode: present ? fs.statSync(file).mode : 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    if (exists(tmp)) fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function resolveControl(packageRoot, explicit) {
  if (explicit) {
    const [command, ...args] = explicit;
    return { command, args };
  }
  const candidates = [
    path.join(packageRoot, "bin", "oracle-control-mcp.mjs"),
    path.join(packageRoot, "plugins", "oracle-owner-gate", "bin", "oracle-control-mcp.mjs"),
    path.join(packageRoot, "plugins", "oracle-owner-gate", "oracle-control-mcp.mjs"),
    // Control MCP ships with the local operator package, not the prepare-only public root.
    path.join(packageRoot, "..", "@oracle-agent", "operator", "bin", "oracle-control-mcp.mjs"),
    path.join(packageRoot, "..", "..", "@oracle-agent", "operator", "bin", "oracle-control-mcp.mjs"),
  ];
  for (const script of candidates) {
    if (exists(script) && fs.statSync(script).isFile()) return { command: "node", script: path.resolve(script) };
  }
  try {
    const require = createRequire(path.join(packageRoot, "package.json"));
    const operatorPkg = path.dirname(require.resolve("@oracle-agent/operator/package.json"));
    const script = path.join(operatorPkg, "bin", "oracle-control-mcp.mjs");
    if (exists(script) && fs.statSync(script).isFile()) return { command: "node", script: path.resolve(script) };
  } catch {}
  return null;
}

export function upgradeProfiles({ hermesHome, packageRoot, only = null, apply = false, controlCommand = null }) {
  const profilesRoot = path.join(hermesHome, "profiles");
  const report = { ok: true, applied: apply, version: UPGRADE_VERSION, hermesHome, packageRoot, profiles: [], created: [], updated: [], unchanged: [], backups: [] };
  let profiles = exists(profilesRoot) ? fs.readdirSync(profilesRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
  if (only) profiles = profiles.filter((name) => name === only);
  if (only && profiles.length === 0) throw new Error(`profile not found: ${only}`);
  report.profiles = profiles;

  // Validate every selected config before planning or performing any write.
  const configs = new Map();
  for (const profile of profiles) {
    const file = path.join(profilesRoot, profile, "config.yaml");
    const text = exists(file) ? fs.readFileSync(file, "utf8") : "";
    validateYaml(text, file);
    configs.set(profile, text);
  }

  const skillSource = path.join(packageRoot, "skills", "oracle-action-semantics");
  if (!exists(skillSource)) throw new Error(`required Oracle skill is missing: ${skillSource}`);
  const pluginSource = path.join(packageRoot, "plugins", "oracle-owner-gate");
  const control = resolveControl(packageRoot, controlCommand);
  const dataScript = path.join(packageRoot, "bin", "oracle-data-mcp.mjs");
  if (!exists(dataScript)) throw new Error(`oracle-data MCP command is missing: ${dataScript}`);

  for (const profile of profiles) {
    const root = path.join(profilesRoot, profile);
    installTree(skillSource, path.join(root, "skills", "oracle-action-semantics"), apply, report);
    if (exists(pluginSource)) installTree(pluginSource, path.join(root, "plugins", "oracle-owner-gate"), apply, report);
    const desired = new Map([["oracle-data", { command: "node", script: dataScript }]]);
    if (control) desired.set("oracle-control", control);
    let config = mergeMcp(configs.get(profile), desired);
    if (exists(pluginSource)) config = mergeEnabledPlugin(config, "oracle-owner-gate");
    writeAtomic(path.join(root, "config.yaml"), config, report);
  }
  return report;
}
