import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  HERMES_PYPI,
  UV_INSTALLERS,
  UV_VERSION,
  findHostPython,
  installManagedHermes,
  managedHermesPath,
  resolveHermes,
  runtimeStatus,
  runtimeVenvDir,
  verifyUvInstaller,
  whichBin,
} from "../src/cli/runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORACLE = path.join(ROOT, "bin", "oracle.mjs");

function runOracle(args, env = {}) {
  return spawnSync(process.execPath, [ORACLE, ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env, ...env },
  });
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oracle-runtime-"));
}

test("managed runtime paths live under the oracle config dir", () => {
  const home = tempHome();
  process.env.ORACLE_FAKE_HOME = home;
  try {
    assert.ok(runtimeVenvDir().startsWith(path.join(home, ".config", "oracle")));
    assert.ok(managedHermesPath().includes("runtime"));
    assert.ok(managedHermesPath().endsWith("hermes") || managedHermesPath().endsWith("hermes.exe"));
  } finally {
    delete process.env.ORACLE_FAKE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("explicit ORACLE_HERMES_BIN wins over PATH and managed venv", () => {
  process.env.ORACLE_HERMES_BIN = "/tmp/does-not-exist-hermes";
  try {
    const r = resolveHermes();
    assert.equal(r.ok, true);
    assert.equal(r.source, "env");
    assert.equal(r.bin, "/tmp/does-not-exist-hermes");
  } finally {
    delete process.env.ORACLE_HERMES_BIN;
  }
});

test("resolveHermes reports not-installed when nothing is available", () => {
  const home = tempHome();
  const prevPath = process.env.PATH;
  process.env.ORACLE_FAKE_HOME = home;
  process.env.PATH = path.join(home, "empty-bin");
  try {
    const r = resolveHermes();
    assert.equal(r.ok, false);
    assert.equal(r.bin, null);
  } finally {
    process.env.PATH = prevPath;
    delete process.env.ORACLE_FAKE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("host python detection only accepts 3.11 through 3.13", () => {
  const found = findHostPython();
  if (found) {
    const [maj, min] = found.version.split(".").map(Number);
    assert.equal(maj, 3);
    assert.ok(min >= 11 && min < 14, `unexpected python ${found.version}`);
  }
});

test("runtimeStatus is json-serializable and complete", () => {
  const s = runtimeStatus();
  for (const key of ["hermes", "managedVenv", "managedInstalled", "hostPython"]) {
    assert.ok(key in s, `missing ${key}`);
  }
  assert.doesNotThrow(() => JSON.stringify(s));
});

test("oracle bootstrap --json emits machine-readable status without installing", () => {
  const home = tempHome();
  try {
    const r = runOracle(["bootstrap", "--json"], { ORACLE_FAKE_HOME: home });
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.ok("managedVenv" in parsed);
    assert.equal(parsed.managedInstalled, false);
    assert.equal(fs.existsSync(path.join(home, ".config", "oracle", "runtime", "venv")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("oracle bootstrap --help never installs anything", () => {
  const home = tempHome();
  try {
    const r = runOracle(["bootstrap", "--help"], { ORACLE_FAKE_HOME: home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /oracle bootstrap/);
    assert.match(r.stdout, /never need this/);
    assert.equal(fs.existsSync(path.join(home, ".config", "oracle", "runtime")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("bootstrap is advertised in help", () => {
  const r = runOracle(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /oracle bootstrap/);
});

test("read commands work with no runtime installed", () => {
  const home = tempHome();
  try {
    const env = { ORACLE_FAKE_HOME: home, PATH: path.join(home, "empty-bin") };
    const chain = runOracle(["chain", "list"], env);
    assert.equal(chain.status, 0, chain.stderr);
    assert.match(chain.stdout, /hyperliquid/);
    const help = runOracle(["--help"], env);
    assert.equal(help.status, 0, help.stderr);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("non-TTY chat never triggers a bootstrap install", () => {
  const home = tempHome();
  try {
    const r = runOracle(["chat"], {
      ORACLE_FAKE_HOME: home,
      PATH: path.join(home, "empty-bin"),
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no Hermes or external agent required/i);
    assert.match(r.stderr, /OPENROUTER_API_KEY/);
    assert.doesNotMatch(r.stderr, /oracle bootstrap/);
    assert.equal(fs.existsSync(path.join(home, ".config", "oracle", "runtime", "venv")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("ORACLE_NO_BOOTSTRAP=1 opts out of auto-install", () => {
  const home = tempHome();
  try {
    const r = runOracle(["chat"], {
      ORACLE_FAKE_HOME: home,
      PATH: path.join(home, "empty-bin"),
      ORACLE_NO_BOOTSTRAP: "1",
    });
    assert.equal(r.status, 1);
    assert.equal(fs.existsSync(path.join(home, ".config", "oracle", "runtime", "venv")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("oracle model resolves the oracle-managed runtime without a PATH install", () => {
  const home = tempHome();
  const log = path.join(home, "model.log");
  process.env.ORACLE_FAKE_HOME = home;
  try {
    const bin = managedHermesPath();
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$*" > "$ORACLE_TEST_LOG"\n`,
      { mode: 0o755 },
    );
    const r = runOracle(["model"], {
      ORACLE_FAKE_HOME: home,
      ORACLE_TEST_LOG: log,
      PATH: path.join(home, "empty-bin"),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(log, "utf8").trim(), "-p oracle model");
  } finally {
    delete process.env.ORACLE_FAKE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("bootstrap falls back to uv when host python cannot create a venv", () => {
  const home = tempHome();
  const binDir = path.join(home, "bin");
  const hostPython = path.join(binDir, "python3.11");
  const fakeUv = path.join(binDir, "uv");
  const uvPython = path.join(binDir, "uv-python");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    hostPython,
    "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'Python 3.11.9'; exit 0; fi\nexit 1\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    fakeUv,
    "#!/bin/sh\nif [ \"$1\" = \"python\" ] && [ \"$2\" = \"install\" ]; then exit 0; fi\nif [ \"$1\" = \"python\" ] && [ \"$2\" = \"find\" ]; then printf '%s\\n' \"$ORACLE_TEST_UV_PY\"; exit 0; fi\nexit 1\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    uvPython,
    `#!${process.execPath}\nconst fs=require("node:fs"),path=require("node:path");const v=process.argv[4];fs.mkdirSync(path.join(v,"bin"),{recursive:true});fs.writeFileSync(path.join(v,"pyvenv.cfg"),"home = fake\\n");for(const n of ["python3","hermes"]){fs.writeFileSync(path.join(v,"bin",n),"#!/bin/sh\\nexit 0\\n",{mode:0o755});}\n`,
    { mode: 0o755 },
  );
  const saved = {
    path: process.env.PATH,
    home: process.env.ORACLE_FAKE_HOME,
    uv: process.env.ORACLE_UV_BIN,
    uvPy: process.env.ORACLE_TEST_UV_PY,
  };
  process.env.PATH = binDir;
  process.env.ORACLE_FAKE_HOME = home;
  process.env.ORACLE_UV_BIN = fakeUv;
  process.env.ORACLE_TEST_UV_PY = uvPython;
  try {
    const installed = installManagedHermes({ quiet: true });
    assert.equal(installed.ok, true, installed.reason);
    assert.equal(installed.python, "3.13");
    assert.equal(fs.existsSync(managedHermesPath()), true);
  } finally {
    process.env.PATH = saved.path;
    if (saved.home === undefined) delete process.env.ORACLE_FAKE_HOME;
    else process.env.ORACLE_FAKE_HOME = saved.home;
    if (saved.uv === undefined) delete process.env.ORACLE_UV_BIN;
    else process.env.ORACLE_UV_BIN = saved.uv;
    if (saved.uvPy === undefined) delete process.env.ORACLE_TEST_UV_PY;
    else process.env.ORACLE_TEST_UV_PY = saved.uvPy;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("bootstrap installs a pinned pypi package, not a git url", () => {
  assert.match(HERMES_PYPI, /^hermes-agent==\d+\.\d+\.\d+$/);
  const src = fs.readFileSync(path.join(ROOT, "src", "cli", "runtime.mjs"), "utf8");
  assert.doesNotMatch(src, /curl .*\| *(bash|sh)/);
  assert.doesNotMatch(src, /sudo /);
});

test("bootstrap executes only immutable checksummed uv installers", () => {
  assert.match(UV_VERSION, /^\d+\.\d+\.\d+$/);
  for (const spec of Object.values(UV_INSTALLERS)) {
    assert.match(spec.url, new RegExp(`/releases/download/${UV_VERSION}/uv-installer\\.`));
    assert.match(spec.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(verifyUvInstaller(Buffer.from("tampered"), { windows: false }), false);
  assert.equal(verifyUvInstaller(Buffer.from("tampered"), { windows: true }), false);
});

test("whichBin tolerates an empty PATH", () => {
  const prev = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.equal(whichBin("hermes"), null);
  } finally {
    process.env.PATH = prev;
  }
});
