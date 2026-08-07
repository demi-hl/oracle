// oracle plugins — install, list, and manage Agent Plugins.
//
// Implements the Agent Plugins open standard (https://agent-plugins.org/).
// Every conformant plugin ships a plugin.json manifest plus optional
// skills/ and mcp/ directories. Oracle validates, installs, and loads them.
//
// Commands:
//   oracle plugins install <path>     install from a local directory
//   oracle plugins install <url>      clone a git repo and install
//   oracle plugins list               show installed plugins
//   oracle plugins remove <name>      uninstall a plugin
//   oracle plugins scan <path>        validate without installing
//   oracle plugins setup              interactive setup wizard
//
// Plugins are installed to ~/.config/oracle/plugins/<name>/.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { oracleConfigDir } from "../paths.mjs";
import { loadPlugin, scanInstalledPlugins, SCHEMA_ID } from "../../plugins/agent-plugin-loader.mjs";

function pluginsDir() {
  const dir = path.join(oracleConfigDir(), "plugins");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function usage() {
  return [
    "oracle plugins — manage Agent Plugins (https://agent-plugins.org/)",
    "",
    "  oracle plugins install <path>       install from a local directory",
    "  oracle plugins install <git-url>    clone a repo and install",
    "  oracle plugins list                 show installed plugins",
    "  oracle plugins remove <name>        uninstall a plugin",
    "  oracle plugins scan <path>          validate without installing",
    "  oracle plugins setup                interactive setup wizard",
    "",
    "plugins are installed to ~/.config/oracle/plugins/<name>/",
    `schema: ${SCHEMA_ID}`,
  ].join("\n");
}

function installFromDir(sourceDir, { name: forceName } = {}) {
  const abs = path.resolve(sourceDir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    process.stderr.write(`error: ${sourceDir} is not a directory\n`);
    return 1;
  }

  const result = loadPlugin(abs);
  if (!result.ok) {
    process.stderr.write(`error: invalid plugin at ${abs}\n`);
    if (result.errors) {
      for (const e of result.errors) process.stderr.write(`  - ${e}\n`);
    }
    return 1;
  }

  const p = result.plugin;
  const destName = forceName || p.name.replace(/\//g, "-");
  const dest = path.join(pluginsDir(), destName);

  if (fs.existsSync(dest)) {
    process.stderr.write(`plugin "${destName}" already installed. use oracle plugins remove first.\n`);
    return 1;
  }

  // Copy the plugin directory
  fs.cpSync(abs, dest, { recursive: true });
  process.stdout.write(`installed ${p.name} (v${p.version}) to ${dest}\n`);
  process.stdout.write(`  ${p.skills.length} skills, ${p.mcpServers.length} MCP servers\n`);

  if (p.warnings.length) {
    for (const w of p.warnings) process.stdout.write(`  warning: ${w}\n`);
  }

  return 0;
}

function installFromGit(url) {
  const tmp = path.join(pluginsDir(), ".tmp-" + Date.now());
  try {
    const r = spawnSync("git", ["clone", "--depth", "1", url, tmp], {
      stdio: "pipe",
      timeout: 60_000,
    });
    if (r.status !== 0) {
      process.stderr.write(`error: git clone failed: ${String(r.stderr).slice(0, 200)}\n`);
      return 1;
    }
    return installFromDir(tmp);
  } finally {
    // Cleanup temp dir
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function cmdList() {
  const plugins = scanInstalledPlugins(pluginsDir());
  if (!plugins.length) {
    process.stdout.write("no plugins installed\n");
    process.stdout.write(`install with: oracle plugins install <path|url>\n`);
    return 0;
  }

  process.stdout.write(`${plugins.length} plugin(s) installed\n\n`);
  for (const p of plugins) {
    const dirName = path.basename(p.root);
    process.stdout.write(`  ${p.name} (v${p.version})\n`);
    process.stdout.write(`    path: ${p.root}\n`);
    if (p.description) process.stdout.write(`    desc: ${p.description}\n`);
    process.stdout.write(`    ${p.skills.length} skills, ${p.mcpServers.length} MCP servers\n`);
    if (p.license !== "UNLICENSED") process.stdout.write(`    license: ${p.license}\n`);
    process.stdout.write("\n");
  }
  return 0;
}

function cmdRemove(name) {
  if (!name) {
    process.stderr.write("usage: oracle plugins remove <name>\n");
    return 1;
  }

  const dest = path.join(pluginsDir(), name);
  if (!fs.existsSync(dest)) {
    process.stderr.write(`plugin "${name}" not found\n`);
    return 1;
  }

  fs.rmSync(dest, { recursive: true, force: true });
  process.stdout.write(`removed plugin "${name}"\n`);
  return 0;
}

function cmdScan(sourceDir) {
  const abs = path.resolve(sourceDir);
  const result = loadPlugin(abs);

  if (!result.ok) {
    process.stderr.write(`invalid plugin: ${result.error}\n`);
    if (result.errors) {
      for (const e of result.errors) process.stderr.write(`  error: ${e}\n`);
    }
    return 1;
  }

  const p = result.plugin;
  process.stdout.write(`valid plugin: ${p.name} (v${p.version})\n`);
  process.stdout.write(`  schema: ${p.manifest.$schema}\n`);
  process.stdout.write(`  skills: ${p.skills.length} found\n`);
  for (const s of p.skills) {
    process.stdout.write(`    - ${s.name} (${s.relativePath})\n`);
  }
  process.stdout.write(`  mcp servers: ${p.mcpServers.length} found\n`);
  for (const m of p.mcpServers) {
    const status = m.error ? `ERROR: ${m.error}` : "ok";
    process.stdout.write(`    - ${m.name}: ${status}\n`);
  }
  if (p.warnings.length) {
    process.stdout.write(`  warnings:\n`);
    for (const w of p.warnings) process.stdout.write(`    - ${w}\n`);
  }
  return 0;
}

function cmdSetup() {
  process.stdout.write([
    "oracle plugins setup",
    "",
    "Agent Plugins (https://agent-plugins.org/) is an open standard for",
    "portable AI agent tooling. Plugins ship skills and MCP servers in a",
    "standard package format that works across compatible clients.",
    "",
    "To create a plugin:",
    "  1. Create a directory with a plugin.json manifest",
    "  2. Add skills as .md files in skills/",
    "  3. Add MCP server configs as .json files in mcp/",
    "  4. Validate: oracle plugins scan <dir>",
    "  5. Install: oracle plugins install <dir>",
    "",
    "To install an existing plugin:",
    "  oracle plugins install <path>       local directory",
    "  oracle plugins install <git-url>    git repository",
    "",
    `schema: ${SCHEMA_ID}`,
    "",
  ].join("\n"));
  return 0;
}

export default {
  name: "plugins",
  summary: "manage Agent Plugins (open-standard portable agent tooling)",
  group: "read",
  usage: usage(),
  async run(ctx) {
    const args = [...ctx.argv];
    const verb = (args[0] || "help").toLowerCase();
    const rest = args.slice(1);

    if (verb === "-h" || verb === "--help" || verb === "help") {
      process.stdout.write(usage() + "\n");
      return 0;
    }

    if (verb === "list" || verb === "ls") {
      return cmdList();
    }

    if (verb === "install" || verb === "add") {
      const target = rest[0];
      if (!target) {
        process.stderr.write("usage: oracle plugins install <path|url>\n");
        return 1;
      }
      // Detect git URL
      if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("git@")) {
        return installFromGit(target);
      }
      return installFromDir(target);
    }

    if (verb === "remove" || verb === "rm" || verb === "uninstall") {
      return cmdRemove(rest[0]);
    }

    if (verb === "scan" || verb === "validate") {
      return cmdScan(rest[0] || ".");
    }

    if (verb === "setup") {
      return cmdSetup();
    }

    process.stderr.write(`oracle plugins: unknown verb '${verb}'\n${usage()}\n`);
    return 1;
  },
};
