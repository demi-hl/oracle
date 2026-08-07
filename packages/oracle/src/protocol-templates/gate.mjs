// Protocol template security gate.
// Refuse prepare-deploy unless Foundry tests are green.
// Static analysis (slither) is required when available; otherwise documented skip.
// This is NOT a substitute for a paid Solidity firm audit.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PKG_ROOT = resolve(HERE, "../..");
const TEMPLATES_ROOT = join(PKG_ROOT, "protocols", "templates");

export const TEMPLATE_AUDIT_DISCLAIMER =
  "Template + Foundry tests + optional static analysis. NOT a paid security-firm audit. Do not put mainnet TVL on forks without an independent Solidity audit.";

export function listProtocolTemplates() {
  if (!existsSync(TEMPLATES_ROOT)) return [];
  return readdirSync(TEMPLATES_ROOT)
    .filter((name) => statSync(join(TEMPLATES_ROOT, name)).isDirectory())
    .map((id) => {
      const dir = join(TEMPLATES_ROOT, id);
      const security = join(dir, "SECURITY.md");
      return {
        id,
        path: dir,
        securityNotice: existsSync(security) ? readFileSync(security, "utf8").slice(0, 500) : null,
        disclaimer: TEMPLATE_AUDIT_DISCLAIMER,
      };
    });
}

function forgeBin() {
  if (process.env.FORGE_BIN) return process.env.FORGE_BIN;
  const home = process.env.HOME || "";
  const candidates = ["forge", join(home, ".foundry/bin/forge")];
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return null;
}

function slitherBin() {
  if (process.env.SLITHER_BIN) return process.env.SLITHER_BIN;
  const r = spawnSync("slither", ["--version"], { encoding: "utf8" });
  return r.status === 0 ? "slither" : null;
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${process.env.HOME || ""}/.foundry/bin:${process.env.PATH || ""}` },
    timeout: 120_000,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

function hashTree(dir) {
  const h = createHash("sha256");
  function walk(p) {
    const st = statSync(p);
    if (st.isDirectory()) {
      if (["lib", "out", "cache", ".git"].includes(p.split("/").pop())) return;
      for (const name of readdirSync(p).sort()) walk(join(p, name));
    } else if (st.isFile() && (p.endsWith(".sol") || p.endsWith(".toml") || p.endsWith(".md"))) {
      h.update(p);
      h.update(readFileSync(p));
    }
  }
  walk(dir);
  return h.digest("hex");
}

/**
 * Run security gate on a template id.
 * @param {string} templateId e.g. "safe-erc20"
 * @param {{ allowSkipStatic?: boolean }} opts
 */
export function runProtocolTemplateGate(templateId, opts = {}) {
  const allowSkipStatic = opts.allowSkipStatic !== false; // default allow skip if no slither
  const dir = join(TEMPLATES_ROOT, templateId);
  if (!existsSync(dir)) {
    throw new Error(`protocol-templates: unknown template "${templateId}"`);
  }

  const forge = forgeBin();
  if (!forge) {
    throw new Error(
      "protocol-templates: forge not found. Install Foundry (https://getfoundry.sh) then: cd protocols/templates/" +
        templateId +
        " && forge install && forge test"
    );
  }

  // ensure libs (not vendored in git)
  if (!existsSync(join(dir, "lib", "forge-std"))) {
    const a = run(forge, ["install", "foundry-rs/forge-std", "--no-git"], dir);
    if (!a.ok) throw new Error(`protocol-templates: forge install forge-std failed\n${a.stderr}`);
  }
  if (!existsSync(join(dir, "lib", "openzeppelin-contracts"))) {
    const b = run(forge, ["install", "OpenZeppelin/openzeppelin-contracts@v5.0.2", "--no-git"], dir);
    if (!b.ok) throw new Error(`protocol-templates: forge install openzeppelin failed\n${b.stderr}`);
  }

  const tests = run(forge, ["test", "-q"], dir);
  if (!tests.ok) {
    throw new Error(
      `protocol-templates: forge test FAILED for ${templateId}\n${tests.stdout}\n${tests.stderr}`.slice(0, 2000)
    );
  }

  let staticAnalysis = { tool: null, ok: true, skipped: true, reason: "slither not installed" };
  const slither = slitherBin();
  if (slither) {
    const s = run(slither, [".", "--filter-paths", "lib", "--exclude-dependencies"], dir);
    staticAnalysis = {
      tool: "slither",
      ok: s.ok,
      skipped: false,
      stdout: (s.stdout || "").slice(0, 1500),
      stderr: (s.stderr || "").slice(0, 500),
    };
    if (!s.ok && !opts.allowStaticFail) {
      throw new Error(`protocol-templates: slither FAILED for ${templateId}\n${s.stdout}\n${s.stderr}`.slice(0, 2000));
    }
  } else if (!allowSkipStatic) {
    throw new Error("protocol-templates: slither required (allowSkipStatic=false) but not installed");
  }

  const sourceHash = hashTree(dir);
  return {
    ok: true,
    templateId,
    path: dir,
    forgeTests: { ok: true, tool: "forge", summary: "forge test passed" },
    staticAnalysis,
    sourceHash,
    disclaimer: TEMPLATE_AUDIT_DISCLAIMER,
    firmAudit: false,
  };
}

/**
 * Build artifact after gate. Returns bytecode for unsigned deploy prepare.
 */
export function buildProtocolTemplate(templateId, opts = {}) {
  const gate = runProtocolTemplateGate(templateId, opts);
  const forge = forgeBin();
  const dir = gate.path;
  const build = run(forge, ["build", "-q"], dir);
  if (!build.ok) {
    throw new Error(`protocol-templates: forge build failed\n${build.stderr}`.slice(0, 1500));
  }
  // default contract name heuristic
  const contractName = opts.contractName || (templateId === "safe-erc20" ? "SafeERC20" : null);
  if (!contractName) throw new Error("protocol-templates: contractName required");
  const artifactPath = join(dir, "out", `${contractName}.sol`, `${contractName}.json`);
  if (!existsSync(artifactPath)) {
    throw new Error(`protocol-templates: artifact missing at ${artifactPath}`);
  }
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  return {
    gate,
    contractName,
    abi: artifact.abi,
    bytecode: artifact.bytecode?.object || artifact.bytecode,
    deployedBytecode: artifact.deployedBytecode?.object || artifact.deployedBytecode,
    artifactPath,
  };
}
