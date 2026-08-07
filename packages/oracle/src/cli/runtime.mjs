import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homeDir, oracleConfigDir, ensureDir } from "./paths.mjs";

export const HERMES_VERSION = "0.19.0";
export const HERMES_PYPI = `hermes-agent==${HERMES_VERSION}`;
const MIN_PY = [3, 11];
const MAX_PY_EXCLUSIVE = [3, 14];
export const UV_PYTHON = "3.13";
export const UV_VERSION = "0.12.1";
export const UV_INSTALLERS = Object.freeze({
  posix: Object.freeze({
    url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-installer.sh`,
    sha256: "d3f5412d38c99f9d024901843bf98206f0d2c6dbe64df40d0b740e2751ca62c1",
  }),
  windows: Object.freeze({
    url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-installer.ps1`,
    sha256: "b9ec035151bfbb11d616dbd69886498d885551489eddf095ea3c0ad59f640eb0",
  }),
});

export function verifyUvInstaller(bytes, { windows = process.platform === "win32" } = {}) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const spec = windows ? UV_INSTALLERS.windows : UV_INSTALLERS.posix;
  const digest = createHash("sha256").update(body).digest("hex");
  const text = body.toString("utf8");
  return digest === spec.sha256 && text.length >= 1_000 && text.includes(UV_VERSION);
}

export function runtimeDir() {
  return path.join(oracleConfigDir(), "runtime");
}

export function runtimeVenvDir() {
  return path.join(runtimeDir(), "venv");
}

function venvBin(name) {
  const dir = process.platform === "win32" ? "Scripts" : "bin";
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  return path.join(runtimeVenvDir(), dir, exe);
}

export function managedHermesPath() {
  return venvBin("hermes");
}

export function managedPythonPath() {
  const py = venvBin("python3");
  return fs.existsSync(py) ? py : venvBin("python");
}

export function managedUvPath() {
  return path.join(runtimeDir(), "uv", process.platform === "win32" ? "uv.exe" : "uv");
}

export function whichBin(bin) {
  const suffixes = process.platform === "win32" && !path.extname(bin)
    ? ["", ".exe", ".cmd", ".bat"]
    : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const c = path.join(dir, `${bin}${suffix}`);
      try {
        if (fs.existsSync(c)) return c;
      } catch {}
    }
  }
  return null;
}

function parsePyVersion(out) {
  const m = /Python (\d+)\.(\d+)\.(\d+)/.exec(out || "");
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function versionSupported(v) {
  if (!v) return false;
  const [maj, min] = v;
  if (maj < MIN_PY[0] || (maj === MIN_PY[0] && min < MIN_PY[1])) return false;
  if (maj > MAX_PY_EXCLUSIVE[0] || (maj === MAX_PY_EXCLUSIVE[0] && min >= MAX_PY_EXCLUSIVE[1])) {
    return false;
  }
  return true;
}

export function findHostPython() {
  const candidates = [
    process.env.ORACLE_PYTHON,
    "python3.13",
    "python3.12",
    "python3.11",
    "python3",
    "python",
  ].filter(Boolean);
  for (const cand of candidates) {
    const bin = path.isAbsolute(cand) ? (fs.existsSync(cand) ? cand : null) : whichBin(cand);
    if (!bin) continue;
    const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000 });
    const v = parsePyVersion(`${r.stdout || ""}${r.stderr || ""}`);
    if (versionSupported(v)) return { bin, version: v.join("."), source: "host" };
  }
  return null;
}

function uvBin() {
  return (
    process.env.ORACLE_UV_BIN ||
    whichBin("uv") ||
    (fs.existsSync(path.join(homeDir(), ".local", "bin", "uv"))
      ? path.join(homeDir(), ".local", "bin", "uv")
      : null) ||
    (fs.existsSync(managedUvPath()) ? managedUvPath() : null)
  );
}

function downloadFile(url, dest) {
  const script = [
    "const fs=require('node:fs');",
    "const [url,dest]=process.argv.slice(1);",
    "fetch(url).then(r=>{if(!r.ok)throw new Error('http '+r.status);return r.arrayBuffer()})",
    ".then(b=>fs.writeFileSync(dest,Buffer.from(b)))",
    ".catch(e=>{console.error(e.message);process.exit(1)});",
  ].join("");
  return spawnSync(process.execPath, ["-e", script, url, dest], {
    encoding: "utf8",
    timeout: 2 * 60_000,
  });
}

export function installManagedUv({ quiet = false } = {}) {
  const existing = uvBin();
  if (existing) return { ok: true, bin: existing, reused: true };

  ensureDir(runtimeDir());
  const windows = process.platform === "win32";
  const installer = path.join(runtimeDir(), windows ? "uv-install.ps1" : "uv-install.sh");
  const spec = windows ? UV_INSTALLERS.windows : UV_INSTALLERS.posix;
  const dl = downloadFile(spec.url, installer);
  if (dl.status !== 0) {
    return {
      ok: false,
      reason: `could not download the uv installer (${dl.status})`,
      stderr: (dl.stderr || "").slice(-800),
    };
  }

  const body = fs.readFileSync(installer);
  if (!verifyUvInstaller(body, { windows })) {
    return { ok: false, reason: `uv ${UV_VERSION} installer checksum mismatch` };
  }

  const installDir = path.dirname(managedUvPath());
  ensureDir(installDir);
  const command = windows
    ? (whichBin("powershell.exe") || whichBin("powershell"))
    : (whichBin("sh") || "/bin/sh");
  if (!command) return { ok: false, reason: windows ? "PowerShell not found" : "sh not found" };
  const args = windows
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer]
    : [installer];
  const inst = spawnSync(command, args, {
    stdio: quiet ? "pipe" : "inherit",
    encoding: "utf8",
    timeout: 5 * 60_000,
    env: {
      ...process.env,
      UV_INSTALL_DIR: installDir,
      UV_NO_MODIFY_PATH: "1",
    },
  });
  if (inst.status !== 0 || !fs.existsSync(managedUvPath())) {
    return {
      ok: false,
      reason: `uv install failed (${inst.status})`,
      stderr: (inst.stderr || "").slice(-800),
    };
  }
  return { ok: true, bin: managedUvPath(), reused: false };
}

export function provisionPythonViaUv({ quiet = false } = {}) {
  const installed = installManagedUv({ quiet });
  if (!installed.ok) return installed;
  const uv = installed.bin;

  const uvEnv = {
    ...process.env,
    UV_PYTHON_INSTALL_DIR: path.join(runtimeDir(), "python"),
    UV_CACHE_DIR: path.join(runtimeDir(), "cache"),
  };
  const inst = spawnSync(uv, ["python", "install", "--no-bin", UV_PYTHON], {
    stdio: quiet ? "pipe" : "inherit",
    encoding: "utf8",
    timeout: 15 * 60_000,
    env: uvEnv,
  });
  if (inst.status !== 0) {
    return {
      ok: false,
      reason: `uv python install ${UV_PYTHON} failed (${inst.status})`,
      stderr: (inst.stderr || "").slice(-800),
    };
  }

  const found = spawnSync(uv, ["python", "find", UV_PYTHON], {
    encoding: "utf8",
    timeout: 60_000,
    env: uvEnv,
  });
  const bin = (found.stdout || "").trim().split(/\r?\n/)[0];
  if (found.status !== 0 || !bin || !fs.existsSync(bin)) {
    return { ok: false, reason: `uv could not locate python ${UV_PYTHON}` };
  }
  return { ok: true, bin, version: UV_PYTHON, source: "uv" };
}

/**
 * Resolve the hermes runtime this Oracle install should use.
 * Order: explicit override -> system PATH -> oracle-managed venv.
 */
export function resolveHermes() {
  if (process.env.ORACLE_HERMES_BIN) {
    return { ok: true, bin: process.env.ORACLE_HERMES_BIN, source: "env" };
  }
  const onPath = whichBin("hermes");
  if (onPath) return { ok: true, bin: onPath, source: "path" };
  const managed = managedHermesPath();
  if (fs.existsSync(managed)) return { ok: true, bin: managed, source: "managed" };
  return { ok: false, bin: null, source: null };
}

export function runtimeStatus() {
  const resolved = resolveHermes();
  const host = findHostPython();
  return {
    hermes: resolved,
    managedVenv: runtimeVenvDir(),
    managedInstalled: fs.existsSync(managedHermesPath()),
    hostPython: host,
    uv: uvBin(),
  };
}

function run(cmd, args, { quiet }) {
  return spawnSync(cmd, args, {
    stdio: quiet ? "pipe" : "inherit",
    encoding: "utf8",
    timeout: 20 * 60_000,
  });
}

/**
 * Create ~/.config/oracle/runtime/venv and install hermes-agent into it.
 * Never touches system python or global site-packages.
 */
export function installManagedHermes({ quiet = false, upgrade = false } = {}) {
  let host = findHostPython();
  if (!host) {
    const viaUv = provisionPythonViaUv({ quiet });
    if (viaUv.ok) {
      host = { bin: viaUv.bin, version: viaUv.version, source: "uv" };
    } else {
      return {
        ok: false,
        reason:
          `no supported python found (need 3.11-3.13) and uv could not provide one: ${viaUv.reason}. ` +
          "install uv (https://docs.astral.sh/uv) or python 3.13, then re-run 'oracle bootstrap'",
      };
    }
  }

  ensureDir(runtimeDir());
  const venv = runtimeVenvDir();
  const alreadyInstalled = fs.existsSync(managedHermesPath());
  if (alreadyInstalled && !upgrade) {
    return { ok: true, bin: managedHermesPath(), reused: true };
  }

  if (!fs.existsSync(path.join(venv, "pyvenv.cfg"))) {
    let mk = run(host.bin, ["-m", "venv", venv], { quiet });
    if (mk.status !== 0 && host.source !== "uv") {
      fs.rmSync(venv, { recursive: true, force: true });
      const viaUv = provisionPythonViaUv({ quiet });
      if (viaUv.ok) {
        host = { bin: viaUv.bin, version: viaUv.version, source: "uv" };
        mk = run(host.bin, ["-m", "venv", venv], { quiet });
      } else {
        return {
          ok: false,
          reason: `python -m venv failed (${mk.status}) and uv fallback failed: ${viaUv.reason}`,
          stderr: (mk.stderr || "").slice(-800),
        };
      }
    }
    if (mk.status !== 0) {
      return {
        ok: false,
        reason: `isolated python -m venv failed (${mk.status})`,
        stderr: (mk.stderr || "").slice(-800),
      };
    }
  }

  const py = managedPythonPath();
  if (!fs.existsSync(py)) {
    return { ok: false, reason: `venv python missing at ${py}` };
  }

  const pipArgs = ["-m", "pip", "install", "--disable-pip-version-check"];
  if (upgrade) pipArgs.push("--upgrade");
  pipArgs.push(HERMES_PYPI);
  const inst = run(py, pipArgs, { quiet });
  if (inst.status !== 0) {
    return {
      ok: false,
      reason: `pip install ${HERMES_PYPI} failed (${inst.status})`,
      stderr: (inst.stderr || "").slice(-1200),
    };
  }

  const bin = managedHermesPath();
  if (!fs.existsSync(bin)) {
    return { ok: false, reason: `hermes entrypoint not found after install (${bin})` };
  }
  return { ok: true, bin, reused: false, python: host.version };
}

export const runtime = {
  HERMES_PYPI,
  HERMES_VERSION,
  UV_PYTHON,
  runtimeDir,
  runtimeVenvDir,
  managedHermesPath,
  managedPythonPath,
  managedUvPath,
  findHostPython,
  installManagedUv,
  provisionPythonViaUv,
  resolveHermes,
  runtimeStatus,
  installManagedHermes,
  whichBin,
};

export default runtime;
