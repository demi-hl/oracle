import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORACLE = path.join(ROOT, "bin", "oracle.mjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-plugins-security-"));
  const home = path.join(root, "home");
  const config = path.join(home, ".config", "oracle");
  const plugins = path.join(config, "plugins");
  fs.mkdirSync(plugins, { recursive: true });
  return { root, home, config, plugins };
}

function runOracle(home, args) {
  return spawnSync(process.execPath, [ORACLE, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ORACLE_FAKE_HOME: home },
  });
}

test("plugins remove deletes one installed plugin", () => {
  const f = fixture();
  try {
    const plugin = path.join(f.plugins, "legit.plugin");
    const sibling = path.join(f.config, "keep");
    fs.mkdirSync(plugin);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(plugin, "plugin.json"), "{}\n");
    fs.writeFileSync(path.join(sibling, "canary"), "keep\n");

    const result = runOracle(f.home, ["plugins", "remove", "legit.plugin"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(plugin), false);
    assert.equal(fs.readFileSync(path.join(sibling, "canary"), "utf8"), "keep\n");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("plugins remove rejects traversal and path-shaped names", () => {
  const f = fixture();
  try {
    const sibling = path.join(f.config, "keep");
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, "canary"), "keep\n");

    for (const name of ["..", ".", "../keep", "legit/../keep", "/tmp", "legit\\..\\keep"] ) {
      const result = runOracle(f.home, ["plugins", "remove", name]);
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      assert.match(result.stderr, /invalid plugin name/i, name);
      assert.equal(fs.readFileSync(path.join(sibling, "canary"), "utf8"), "keep\n", name);
      assert.equal(fs.existsSync(f.config), true, name);
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("plugins remove refuses symlinked plugin directories", () => {
  const f = fixture();
  try {
    const outside = path.join(f.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "canary"), "keep\n");
    fs.symlinkSync(outside, path.join(f.plugins, "linked.plugin"), "dir");

    const result = runOracle(f.home, ["plugins", "remove", "linked.plugin"]);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /refusing to remove/i);
    assert.equal(fs.readFileSync(path.join(outside, "canary"), "utf8"), "keep\n");
    assert.equal(fs.lstatSync(path.join(f.plugins, "linked.plugin")).isSymbolicLink(), true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("plugins remove refuses a symlinked plugin root", () => {
  const f = fixture();
  try {
    const outside = path.join(f.root, "outside");
    const plugin = path.join(outside, "legit.plugin");
    fs.rmSync(f.plugins, { recursive: true });
    fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(path.join(plugin, "canary"), "keep\n");
    fs.symlinkSync(outside, f.plugins, "dir");

    const result = runOracle(f.home, ["plugins", "remove", "legit.plugin"]);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /refusing to remove/i);
    assert.equal(fs.readFileSync(path.join(plugin, "canary"), "utf8"), "keep\n");
    assert.equal(fs.lstatSync(f.plugins).isSymbolicLink(), true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
