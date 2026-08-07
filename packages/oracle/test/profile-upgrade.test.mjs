import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "oracle-upgrade.mjs");

function fixture({ plugin = false, profiles = ["alpha"] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-upgrade-"));
  const pkg = path.join(tmp, "package");
  const home = path.join(tmp, "hermes");
  fs.mkdirSync(path.join(pkg, "skills", "oracle-action-semantics"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "skills", "oracle-action-semantics", "SKILL.md"), "oracle semantics v2\n");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "bin", "oracle-data-mcp.mjs"), "// data\n");
  if (plugin) {
    fs.mkdirSync(path.join(pkg, "plugins", "oracle-owner-gate", "bin"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "plugins", "oracle-owner-gate", "plugin.txt"), "owner gate\n");
    fs.writeFileSync(path.join(pkg, "plugins", "oracle-owner-gate", "bin", "oracle-control-mcp.mjs"), "// control\n");
  }
  for (const name of profiles) fs.mkdirSync(path.join(home, "profiles", name), { recursive: true });
  return { tmp, pkg, home };
}

function run(f, ...args) {
  const proc = spawnSync(process.execPath, [CLI, "--json", "--hermes-home", f.home, "--package-root", f.pkg, ...args], { encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stdout || proc.stderr);
  return JSON.parse(proc.stdout);
}

test("dry-run is default and a fresh profile is planned without writes", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.tmp, { recursive: true, force: true }));
  const result = run(f);
  assert.equal(result.applied, false);
  assert.equal(result.created.length, 2);
  assert.equal(fs.existsSync(path.join(f.home, "profiles", "alpha", "config.yaml")), false);
});

test("customized profile preserves user surfaces and unrelated YAML while replacing Oracle-owned files", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.tmp, { recursive: true, force: true }));
  const profile = path.join(f.home, "profiles", "alpha");
  const config = [
    "# keep this comment", "model: custom/model", "provider: mine", "hooks:", "  after: notify",
    "mcp_servers:", "  custom-server:", "    command: custom", "    enabled: false",
    "  oracle-data:", "    command: stale", "    enabled: false", "",
  ].join("\n");
  fs.writeFileSync(path.join(profile, "config.yaml"), config);
  fs.writeFileSync(path.join(profile, "SOUL.md"), "my soul\n");
  fs.mkdirSync(path.join(profile, "memories")); fs.writeFileSync(path.join(profile, "memories", "one.md"), "memory\n");
  fs.mkdirSync(path.join(profile, "skills", "custom"), { recursive: true }); fs.writeFileSync(path.join(profile, "skills", "custom", "SKILL.md"), "custom\n");
  fs.mkdirSync(path.join(profile, "skills", "oracle-action-semantics"), { recursive: true }); fs.writeFileSync(path.join(profile, "skills", "oracle-action-semantics", "SKILL.md"), "old oracle\n");
  const result = run(f, "--apply");
  const after = fs.readFileSync(path.join(profile, "config.yaml"), "utf8");
  assert.match(after, /# keep this comment/); assert.match(after, /model: custom\/model/); assert.match(after, /custom-server:/);
  assert.match(after, /oracle-data-mcp\.mjs/); assert.doesNotMatch(after, /command: stale/);
  assert.equal(fs.readFileSync(path.join(profile, "SOUL.md"), "utf8"), "my soul\n");
  assert.equal(fs.readFileSync(path.join(profile, "memories", "one.md"), "utf8"), "memory\n");
  assert.equal(fs.readFileSync(path.join(profile, "skills", "custom", "SKILL.md"), "utf8"), "custom\n");
  assert.equal(result.updated.length, 2); assert.equal(result.backups.length, 2);
});

test("malformed YAML fails closed before any profile write", (t) => {
  const f = fixture({ profiles: ["alpha", "beta"] }); t.after(() => fs.rmSync(f.tmp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.home, "profiles", "alpha", "config.yaml"), "model: okay\n");
  fs.writeFileSync(path.join(f.home, "profiles", "beta", "config.yaml"), "mcp_servers: { broken: true\n");
  const proc = spawnSync(process.execPath, [CLI, "--apply", "--json", "--hermes-home", f.home, "--package-root", f.pkg], { encoding: "utf8" });
  assert.notEqual(proc.status, 0); assert.equal(JSON.parse(proc.stdout).ok, false);
  assert.equal(fs.existsSync(path.join(f.home, "profiles", "alpha", "skills")), false);
  assert.equal(fs.readFileSync(path.join(f.home, "profiles", "alpha", "config.yaml"), "utf8"), "model: okay\n");
});

test("second apply is idempotent and creates no additional backups", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.tmp, { recursive: true, force: true }));
  run(f, "--apply");
  const second = run(f, "--apply");
  assert.equal(second.created.length, 0); assert.equal(second.updated.length, 0, JSON.stringify(second, null, 2));
  assert.equal(second.unchanged.length, 2); assert.deepEqual(second.backups, []);
});

test("backups are byte-for-byte faithful", (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.tmp, { recursive: true, force: true }));
  const profile = path.join(f.home, "profiles", "alpha");
  const original = Buffer.from("# bytes\r\nmodel: bespoke\r\n");
  fs.writeFileSync(path.join(profile, "config.yaml"), original);
  const result = run(f, "--apply");
  const backup = result.backups.find((item) => item.original.endsWith("config.yaml"));
  assert.ok(backup); assert.deepEqual(fs.readFileSync(backup.path), original);
});

test("--only scopes all mutations to one profile", (t) => {
  const f = fixture({ profiles: ["alpha", "beta"] }); t.after(() => fs.rmSync(f.tmp, { recursive: true, force: true }));
  const result = run(f, "--apply", "--only", "beta");
  assert.deepEqual(result.profiles, ["beta"]);
  assert.equal(fs.existsSync(path.join(f.home, "profiles", "alpha", "config.yaml")), false);
  assert.equal(fs.existsSync(path.join(f.home, "profiles", "beta", "config.yaml")), true);
});

test("owner-gate plugin and control MCP are conditional on package-root presence", (t) => {
  const absent = fixture(); const present = fixture({ plugin: true });
  t.after(() => { fs.rmSync(absent.tmp, { recursive: true, force: true }); fs.rmSync(present.tmp, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(present.home, "profiles", "alpha", "config.yaml"), [
    "plugins:", "  enabled: [\"custom-plugin\"]", "  entries:", "    custom-plugin:", "      llm:", "        model: custom/model", "",
  ].join("\n"));
  run(absent, "--apply"); run(present, "--apply");
  const absentProfile = path.join(absent.home, "profiles", "alpha");
  const presentProfile = path.join(present.home, "profiles", "alpha");
  assert.equal(fs.existsSync(path.join(absentProfile, "plugins", "oracle-owner-gate")), false);
  assert.doesNotMatch(fs.readFileSync(path.join(absentProfile, "config.yaml"), "utf8"), /oracle-control/);
  assert.equal(fs.readFileSync(path.join(presentProfile, "plugins", "oracle-owner-gate", "plugin.txt"), "utf8"), "owner gate\n");
  const presentConfig = fs.readFileSync(path.join(presentProfile, "config.yaml"), "utf8");
  assert.match(presentConfig, /enabled: \["custom-plugin", "oracle-owner-gate"\]/);
  assert.match(presentConfig, /entries:[\s\S]*custom-plugin:[\s\S]*model: custom\/model/);
  assert.match(presentConfig, /oracle-control:[\s\S]*oracle-control-mcp\.mjs/);
});

test("control MCP is discovered from a sibling installed operator package", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.tmp, { recursive: true, force: true }));
  const operator = path.join(f.tmp, "node_modules", "@oracle-agent", "operator", "bin");
  fs.mkdirSync(operator, { recursive: true });
  fs.writeFileSync(path.join(operator, "oracle-control-mcp.mjs"), "// operator control\n");
  // Place package root as if installed under node_modules/@oracle-agent/oracle
  const oracleRoot = path.join(f.tmp, "node_modules", "@oracle-agent", "oracle");
  fs.cpSync(f.pkg, oracleRoot, { recursive: true });
  const proc = spawnSync(process.execPath, [CLI, "--apply", "--json", "--hermes-home", f.home, "--package-root", oracleRoot], { encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stdout || proc.stderr);
  const cfg = fs.readFileSync(path.join(f.home, "profiles", "alpha", "config.yaml"), "utf8");
  assert.match(cfg, /oracle-control:[\s\S]*operator\/bin\/oracle-control-mcp\.mjs/);
});
