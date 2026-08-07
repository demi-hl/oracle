import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOperator, dispatchOperator, OPERATOR_NOT_INSTALLED_MESSAGE } from "../src/cli/operator-dispatch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_DIR = path.join(ROOT, "src", "cli");

function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (ent.isFile() && ent.name.endsWith(".mjs")) acc.push(p);
  }
  return acc;
}

test("no src/cli file imports operator package", () => {
  for (const f of walk(CLI_DIR)) {
    const src = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(src, /from\s+["']@oracle-agent\/operator(?:\/[^"']*)?["']/, f);
    assert.doesNotMatch(src, /require\(\s*["']@oracle-agent\/operator(?:\/[^"']*)?["']\s*\)/, f);
  }
});

test("ORACLE_OPERATOR_BIN_DIR resolves fake vault", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-op-bins-"));
  const vault = path.join(dir, "oracle-vault");
  fs.writeFileSync(vault, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n", { mode: 0o755 });
  fs.chmodSync(vault, 0o755);
  const prev = process.env.ORACLE_OPERATOR_BIN_DIR;
  process.env.ORACLE_OPERATOR_BIN_DIR = dir;
  try {
    const r = resolveOperator();
    assert.equal(r.ok, true);
    assert.equal(r.source, "env:ORACLE_OPERATOR_BIN_DIR");
    const result = dispatchOperator("oracle-vault", ["inspect", "/tmp/x", "--stdout"], { stdio: "pipe" });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["inspect", "/tmp/x", "--stdout"]);
  } finally {
    if (prev === undefined) delete process.env.ORACLE_OPERATOR_BIN_DIR;
    else process.env.ORACLE_OPERATOR_BIN_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolves operator when package.json is hidden by exports", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-op-package-"));
  const pkgRoot = path.join(dir, "node_modules", "@oracle-agent", "operator");
  const entry = path.join(pkgRoot, "src", "index.mjs");
  const vault = path.join(pkgRoot, "bin", "oracle-vault.mjs");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.mkdirSync(path.dirname(vault), { recursive: true });
  fs.writeFileSync(entry, "export const ok = true;\n");
  fs.writeFileSync(vault, "#!/usr/bin/env node\n");
  fs.writeFileSync(
    path.join(pkgRoot, "package.json"),
    JSON.stringify({
      name: "@oracle-agent/operator",
      version: "9.8.7",
      type: "module",
      exports: { ".": "./src/index.mjs" },
      bin: { "oracle-vault": "./bin/oracle-vault.mjs" },
    }),
  );
  fs.writeFileSync(path.join(dir, "package.json"), "{}");

  const cwd = process.cwd();
  const prev = process.env.ORACLE_OPERATOR_BIN_DIR;
  delete process.env.ORACLE_OPERATOR_BIN_DIR;
  process.chdir(dir);
  try {
    const r = resolveOperator();
    assert.equal(r.ok, true);
    assert.equal(r.version, "9.8.7");
    assert.equal(r.bins["oracle-vault"], vault);
    assert.match(r.source, /^require:/);
  } finally {
    process.chdir(cwd);
    if (prev === undefined) delete process.env.ORACLE_OPERATOR_BIN_DIR;
    else process.env.ORACLE_OPERATOR_BIN_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing operator dispatch exits 3", () => {
  const prev = process.env.ORACLE_OPERATOR_BIN_DIR;
  process.env.ORACLE_OPERATOR_BIN_DIR = path.join(os.tmpdir(), "no-such-oracle-op-bins");
  try {
    assert.equal(resolveOperator().ok, false);
    let err = "";
    const code = dispatchOperator("oracle-vault", ["inspect"], {
      stdio: "pipe",
      stderr: { write: (c) => { err += c; } },
    });
    assert.equal(code, 3);
    assert.match(err, /signing is unavailable in the public package/);
    assert.match(err, /has no public npm install/);
    assert.doesNotMatch(err, /npm i(?:nstall)?\s+(?:-g\s+)?@oracle-agent\/operator/);
    assert.ok(OPERATOR_NOT_INSTALLED_MESSAGE.includes("prepare-only"));
  } finally {
    if (prev === undefined) delete process.env.ORACLE_OPERATOR_BIN_DIR;
    else process.env.ORACLE_OPERATOR_BIN_DIR = prev;
  }
});


test("public desktop mode ignores host operator installations", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-op-public-desktop-"));
  const vault = path.join(dir, "oracle-vault");
  fs.writeFileSync(vault, "#!/usr/bin/env node\nprocess.stdout.write('should-not-run');\n", { mode: 0o755 });
  const prevDir = process.env.ORACLE_OPERATOR_BIN_DIR;
  const prevDesktop = process.env.ORACLE_PUBLIC_DESKTOP;
  process.env.ORACLE_OPERATOR_BIN_DIR = dir;
  process.env.ORACLE_PUBLIC_DESKTOP = "1";
  try {
    assert.equal(resolveOperator().ok, false);
    assert.equal(resolveOperator().source, "public-desktop");
  } finally {
    if (prevDir === undefined) delete process.env.ORACLE_OPERATOR_BIN_DIR;
    else process.env.ORACLE_OPERATOR_BIN_DIR = prevDir;
    if (prevDesktop === undefined) delete process.env.ORACLE_PUBLIC_DESKTOP;
    else process.env.ORACLE_PUBLIC_DESKTOP = prevDesktop;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bare operator binaries on PATH are ignored", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-op-path-"));
  const marker = path.join(dir, "executed");
  const signer = path.join(dir, "oracle-signer");
  fs.writeFileSync(signer, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`, { mode: 0o755 });
  const prevDir = process.env.ORACLE_OPERATOR_BIN_DIR;
  const prevPath = process.env.PATH;
  delete process.env.ORACLE_OPERATOR_BIN_DIR;
  process.env.PATH = `${dir}${path.delimiter}${prevPath || ""}`;
  try {
    assert.equal(resolveOperator().ok, false);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    if (prevDir === undefined) delete process.env.ORACLE_OPERATOR_BIN_DIR;
    else process.env.ORACLE_OPERATOR_BIN_DIR = prevDir;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("operator capability probes on PATH are ignored", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-op-caps-path-"));
  const marker = path.join(dir, "executed");
  const caps = path.join(dir, "oracle-operator-caps");
  fs.writeFileSync(
    caps,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\nprocess.stdout.write(JSON.stringify({bins:{"oracle-signer":${JSON.stringify(path.join(dir, "oracle-signer"))}}}));\n`,
    { mode: 0o755 },
  );
  const prevDir = process.env.ORACLE_OPERATOR_BIN_DIR;
  const prevPath = process.env.PATH;
  delete process.env.ORACLE_OPERATOR_BIN_DIR;
  process.env.PATH = `${dir}${path.delimiter}${prevPath || ""}`;
  try {
    assert.equal(resolveOperator().ok, false);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    if (prevDir === undefined) delete process.env.ORACLE_OPERATOR_BIN_DIR;
    else process.env.ORACLE_OPERATOR_BIN_DIR = prevDir;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
