// Agent Plugins loader — implements the open standard at https://agent-plugins.org/.
//
// Oracle can load any conformant Agent Plugin from a directory, validate its
// manifest against the canonical schema, and discover skills and MCP servers.
// This makes Oracle an Agent Plugins-compatible client.
//
// Spec: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json
//
// Custody: read-only. This module never signs, never broadcasts, never
// touches key material. Skills and MCP servers are inert until invoked.

import fs from "node:fs";
import path from "node:path";

export const SCHEMA_ID = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const NAME_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\.[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;

/**
 * Validate a plugin.json manifest against the canonical schema.
 * Returns { valid, errors[], warnings[] }.
 * Non-fatal violations are warnings; fatal violations are errors.
 */
export function validateManifest(raw) {
  const errors = [];
  const warnings = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("plugin.json must be a JSON object");
    return { valid: false, errors, warnings };
  }

  // $schema — required, must match canonical
  if (raw.$schema !== SCHEMA_ID) {
    if (!raw.$schema) {
      errors.push("$schema is required — must be " + SCHEMA_ID);
    } else {
      errors.push(`unsupported $schema: ${raw.$schema} (expected ${SCHEMA_ID})`);
    }
  }

  // name — required, kebab-case dot-separated
  if (!raw.name || typeof raw.name !== "string") {
    errors.push("name is required (string)");
  } else if (!NAME_RE.test(raw.name)) {
    errors.push(`name "${raw.name}" must be kebab-case dot-separated (e.g. deployment.tools)`);
  }

  // version — optional, warn if missing
  if (raw.version === undefined || raw.version === null || raw.version === "") {
    warnings.push("version is missing — semantic versioning recommended");
  }

  // description — optional
  if (raw.description !== undefined && typeof raw.description !== "string") {
    warnings.push("description must be a string");
  }

  // author — optional object
  if (raw.author !== undefined) {
    if (typeof raw.author !== "object" || Array.isArray(raw.author)) {
      warnings.push("author must be an object with optional name, email, url");
    }
  }

  // keywords — optional array
  if (raw.keywords !== undefined) {
    if (!Array.isArray(raw.keywords)) {
      warnings.push("keywords must be an array");
    }
  }

  // license — optional string
  if (raw.license !== undefined && typeof raw.license !== "string") {
    warnings.push("license must be a string");
  }

  // Extension fields (unknown top-level) — warn, don't error
  const known = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      warnings.push(`unknown field "${key}" — will be ignored (use extensions.<namespace> for client data)`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Discover skills in a plugin's skills/ directory.
 * Each .md file is a skill. Subdirectories are supported for organization.
 * Returns [{ name, path, content? }]
 */
export function discoverSkills(pluginRoot) {
  const skillsDir = path.join(pluginRoot, "skills");
  const skills = [];

  if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) {
    return skills;
  }

  function walk(dir, prefix = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.name.endsWith(".md")) {
        const skillName = prefix ? `${prefix}/${entry.name.replace(/\.md$/, "")}` : entry.name.replace(/\.md$/, "");
        skills.push({
          name: skillName,
          path: full,
          relativePath: path.relative(skillsDir, full),
        });
      }
    }
  }

  walk(skillsDir);
  return skills;
}

/**
 * Discover MCP server configs in a plugin's mcp/ directory.
 * Each .json file is an MCP server definition.
 * Returns [{ name, path, config }]
 */
export function discoverMcpServers(pluginRoot) {
  const mcpDir = path.join(pluginRoot, "mcp");
  const servers = [];

  if (!fs.existsSync(mcpDir) || !fs.statSync(mcpDir).isDirectory()) {
    return servers;
  }

  for (const entry of fs.readdirSync(mcpDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const full = path.join(mcpDir, entry.name);
    try {
      const config = JSON.parse(fs.readFileSync(full, "utf8"));
      servers.push({
        name: entry.name.replace(/\.json$/, ""),
        path: full,
        config,
      });
    } catch (e) {
      // Invalid JSON in an MCP config — skip this server, don't fail the plugin
      servers.push({
        name: entry.name.replace(/\.json$/, ""),
        path: full,
        error: `invalid JSON: ${e.message}`,
      });
    }
  }

  return servers;
}

/**
 * Load a complete Agent Plugin from a directory.
 * Validates the manifest, discovers skills and MCP servers.
 *
 * Returns:
 *   { ok: true, plugin: { name, version, root, manifest, skills[], mcpServers[], warnings[] } }
 *   { ok: false, error, errors[] }
 */
export function loadPlugin(pluginRoot) {
  const root = path.resolve(pluginRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, error: `plugin directory not found: ${root}` };
  }

  const manifestPath = path.join(root, "plugin.json");
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: `missing plugin.json in ${root}` };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return { ok: false, error: `invalid plugin.json: ${e.message}` };
  }

  const validation = validateManifest(manifest);
  if (!validation.valid) {
    return { ok: false, error: "manifest validation failed", errors: validation.errors };
  }

  const skills = discoverSkills(root);
  const mcpServers = discoverMcpServers(root);

  return {
    ok: true,
    plugin: {
      name: manifest.name,
      version: manifest.version || "0.0.0",
      description: manifest.description || "",
      author: manifest.author || {},
      license: manifest.license || "UNLICENSED",
      root,
      manifest,
      skills,
      mcpServers,
      warnings: [...validation.warnings],
    },
  };
}

/**
 * Scan a directory for installed plugins (directories containing plugin.json).
 * Returns an array of loaded plugin descriptors.
 */
export function scanInstalledPlugins(pluginsDir) {
  const plugins = [];
  if (!fs.existsSync(pluginsDir)) return plugins;

  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginRoot = path.join(pluginsDir, entry.name);
    const result = loadPlugin(pluginRoot);
    if (result.ok) plugins.push(result.plugin);
  }

  return plugins;
}
