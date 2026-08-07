import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "../..");

export const OPERATOR_BIN_NAMES = Object.freeze([
  "oracle-vault",
  "oracle-credential",
  "oracle-signer",
  "oracle-runner",
  "oracle-agentic-init",
  "oracle-agentic-doctor",
  "oracle-control-mcp",
  "oracle-operator-caps",
]);

export const SIGN_NOUNS = Object.freeze([
  "vault",
  "credential",
  "signer",
  "runner",
  "sign",
]);

export const OPERATOR_NOT_INSTALLED_MESSAGE = `oracle: signing is unavailable in the public package.

  The public 'oracle' package is prepare-only and never handles keys.
  Owner-operated signing is private infrastructure and has no public npm install.
  Review and sign prepared artifacts in your own wallet instead.

  Nothing about your read/research/prepare setup is affected.
`;

export const SIGN_HINT =
  "hint: run 'oracle sign init' to provision keys, or 'oracle sign doctor --json' for detail.";

function whichOnPath(binName) {
  const pathEnv = process.env.PATH || "";
  const parts = pathEnv.split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of parts) {
    for (const ext of exts) {
      const candidate = path.join(dir, binName + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function binsFromDir(binDir) {
  const bins = {};
  for (const name of OPERATOR_BIN_NAMES) {
    const candidates = [
      path.join(binDir, name),
      path.join(binDir, `${name}.mjs`),
      path.join(binDir, `${name}.js`),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        bins[name] = c;
        break;
      }
    }
  }
  return bins;
}

function findPackageRoot(entryPath) {
  let dir = path.dirname(entryPath);
  while (dir !== path.dirname(dir)) {
    const pkgJson = path.join(dir, "package.json");
    if (fs.existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
        if (pkg.name === "@oracle-agent/operator") return { root: dir, pkg };
      } catch {
        // continue upward
      }
    }
    dir = path.dirname(dir);
  }
  return null;
}

function tryResolvePackage(fromPaths) {
  for (const from of fromPaths) {
    try {
      const req = createRequire(path.join(from, "package.json"));
      let found;
      try {
        const pkgJson = req.resolve("@oracle-agent/operator/package.json");
        found = {
          root: path.dirname(pkgJson),
          pkg: JSON.parse(fs.readFileSync(pkgJson, "utf8")),
        };
      } catch {
        const entry = req.resolve("@oracle-agent/operator");
        found = findPackageRoot(entry);
      }
      if (!found) continue;
      const { root, pkg } = found;
      const binField = pkg.bin || {};
      const bins = {};
      for (const [name, rel] of Object.entries(binField)) {
        bins[name] = path.resolve(root, rel);
      }
      const extra = binsFromDir(path.join(root, "bin"));
      for (const [k, v] of Object.entries(extra)) {
        if (!bins[k]) bins[k] = v;
      }
      return {
        ok: true,
        binDir: path.join(root, "bin"),
        version: pkg.version || "unknown",
        bins,
        source: `require:${from}`,
      };
    } catch {
      // continue
    }
  }
  return null;
}

function tryCapsOnPath() {
  const capsBin = whichOnPath("oracle-operator-caps");
  if (!capsBin) return null;
  const r = spawnSync(capsBin, [], {
    encoding: "utf8",
    timeout: 5000,
    env: process.env,
  });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const report = JSON.parse(r.stdout);
    if (!report || typeof report !== "object" || !report.bins) return null;
    return {
      ok: true,
      binDir: path.dirname(Object.values(report.bins)[0] || capsBin),
      version: report.version || "unknown",
      bins: report.bins,
      source: "caps-path",
      controlMcp: report.controlMcp,
    };
  } catch {
    return null;
  }
}

function tryPathProbe() {
  const bins = {};
  for (const name of OPERATOR_BIN_NAMES) {
    const hit = whichOnPath(name);
    if (hit) bins[name] = hit;
  }
  if (!Object.keys(bins).length) return null;
  return {
    ok: true,
    binDir: path.dirname(Object.values(bins)[0]),
    version: "unknown",
    bins,
    source: "path-probe",
  };
}

export function resolveOperator() {
  if (process.env.ORACLE_PUBLIC_DESKTOP === "1") return { ok: false, source: "public-desktop" };
  const envDir = process.env.ORACLE_OPERATOR_BIN_DIR;
  if (envDir) {
    const abs = path.resolve(envDir);
    if (!fs.existsSync(abs)) return { ok: false };
    const bins = binsFromDir(abs);
    if (!Object.keys(bins).length) return { ok: false };
    let version = "unknown";
    const pkgCandidate = path.resolve(abs, "../package.json");
    if (fs.existsSync(pkgCandidate)) {
      try {
        version = JSON.parse(fs.readFileSync(pkgCandidate, "utf8")).version || version;
      } catch {
        // ignore
      }
    }
    return { ok: true, binDir: abs, version, bins, source: "env:ORACLE_OPERATOR_BIN_DIR" };
  }

  const fromPkg =
    tryResolvePackage([process.cwd(), PACKAGE_ROOT]) ||
    tryCapsOnPath() ||
    tryPathProbe();
  return fromPkg || { ok: false };
}

export function printOperatorNotInstalled(stream = process.stderr) {
  stream.write(OPERATOR_NOT_INSTALLED_MESSAGE);
  if (!OPERATOR_NOT_INSTALLED_MESSAGE.endsWith("\n")) stream.write("\n");
}

export function dispatchOperator(binName, argv = [], opts = {}) {
  const resolved = resolveOperator();
  if (!resolved.ok) {
    printOperatorNotInstalled(opts.stderr || process.stderr);
    return 3;
  }
  const binPath = resolved.bins[binName];
  if (!binPath) {
    const err = opts.stderr || process.stderr;
    err.write(`oracle: operator bin '${binName}' not found in resolved operator (${resolved.source})\n`);
    return 3;
  }

  const stdio = opts.stdio || "inherit";
  const isJs = /\.(mjs|cjs|js)$/.test(binPath);
  const command = isJs ? process.execPath : binPath;
  const args = isJs ? [binPath, ...argv] : [...argv];
  const r = spawnSync(command, args, {
    stdio,
    env: opts.env || process.env,
    cwd: opts.cwd || process.cwd(),
    encoding: stdio === "pipe" ? "utf8" : undefined,
  });

  if (r.error) {
    const err = opts.stderr || process.stderr;
    err.write(`oracle: failed to spawn ${binName}: ${r.error.message}\n`);
    return 1;
  }

  const code = typeof r.status === "number" ? r.status : 1;
  if (code !== 0 && opts.appendHintOnError) {
    const err = opts.stderr || process.stderr;
    err.write(SIGN_HINT + "\n");
  }
  if (stdio === "pipe") {
    return { code, stdout: r.stdout || "", stderr: r.stderr || "" };
  }
  return code;
}

export default {
  resolveOperator,
  dispatchOperator,
  printOperatorNotInstalled,
  OPERATOR_NOT_INSTALLED_MESSAGE,
  SIGN_HINT,
  SIGN_NOUNS,
  OPERATOR_BIN_NAMES,
};
