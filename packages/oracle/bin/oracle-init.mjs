#!/usr/bin/env node
// oracle-init -- install Oracle's agent lanes into Hermes.
//
// Reads profiles/<lane>/profile.json, validates each against the shipped schema,
// then creates the Hermes profile, installs its SOUL.md, registers the repo's
// skills, and wires the oracle-data MCP server.
//
// Deliberate omissions:
//   * No model or provider is written. Oracle makes no model calls; each lane
//     inherits whatever the operator's Hermes already serves. profile.json carries
//     a capability CLASS ("strong-reasoner"), never a model id, so this installer
//     never pins a vendor.
//   * No grant is armed. Every lane lands DISARMED. Arming is a signed, scoped,
//     expiring act the user performs later.
//
// Default is a DRY RUN. Pass --apply to make changes.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packageAssetDir } from "../src/package-manifest.mjs";

// Sibling bins live next to this file in both layouts (bin/ in source,
// dist/bin/ in the published bundle), so resolve them from here, not the root.
const BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = packageAssetDir("profiles", import.meta.url);
const SKILLS_DIR = packageAssetDir("skills", import.meta.url);

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FORCE = args.includes("--force");
const JSON_OUT = args.includes("--json");
const only = (() => {
  const i = args.indexOf("--only");
  return i >= 0 ? args[i + 1] : null;
})();

const log = (...m) => {
  if (!JSON_OUT) console.log(...m);
};

// ---------------------------------------------------------------- validation

function loadSchema() {
  return JSON.parse(
    fs.readFileSync(path.join(PROFILES_DIR, "profile.schema.json"), "utf8"),
  );
}

// Focused validator for the fields we actually depend on. Not a general JSON
// Schema engine -- pulling one in for eight files would add a dependency to a
// zero-dependency installer.
function validateProfile(def, schema, skillNames) {
  const errors = [];
  const req = schema.required || [];
  for (const k of req) {
    if (def[k] === undefined) errors.push(`missing required field: ${k}`);
  }
  if (def.id && !/^[a-z_][a-z0-9-]*$/.test(def.id)) {
    errors.push(`id "${def.id}" must be lowercase, no dots (Hermes rejects dots)`);
  }
  const roles = schema.properties.role.enum;
  if (def.role && !roles.includes(def.role)) {
    errors.push(`role "${def.role}" not one of ${roles.join(", ")}`);
  }
  const p = def.posture || {};
  if (p.default !== "DISARMED") {
    errors.push("posture.default must be DISARMED -- a lane that ships armed is a bug");
  }
  if (p.signing && !["none", "user-wallet"].includes(p.signing)) {
    errors.push(`posture.signing "${p.signing}" invalid -- Oracle holds no keys`);
  }
  const allowedActions =
    schema.properties.posture.properties.grantActions.items.enum;
  for (const a of p.grantActions || []) {
    if (!allowedActions.includes(a)) {
      errors.push(`grantAction "${a}" not allowed (broadcast/sign actions are forbidden)`);
    }
  }
  if (typeof p.rationale === "string" && p.rationale.length < 20) {
    errors.push("posture.rationale too short -- justify the grant");
  }
  // Every named skill must actually exist. This is the check that would have
  // caught the phantom-skill problem in the original pack manifest.
  for (const s of def.skills || []) {
    if (!skillNames.has(s)) errors.push(`skill "${s}" does not exist in skills/`);
  }
  return errors;
}

// ---------------------------------------------------------------- discovery

function discoverSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return new Map();
  const out = new Map();
  for (const e of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const skillFile = path.join(SKILLS_DIR, e.name, "SKILL.md");
    if (fs.existsSync(skillFile)) out.set(e.name, skillFile);
  }
  return out;
}

function discoverProfiles() {
  if (!fs.existsSync(PROFILES_DIR)) return [];
  const out = [];
  for (const e of fs.readdirSync(PROFILES_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const f = path.join(PROFILES_DIR, e.name, "profile.json");
    if (!fs.existsSync(f)) continue;
    const def = JSON.parse(fs.readFileSync(f, "utf8"));
    def.__dir = path.join(PROFILES_DIR, e.name);
    out.push(def);
  }
  return out;
}

// ---------------------------------------------------------------- hermes glue

function hermesAvailable() {
  try {
    execFileSync("hermes", ["--version"], { stdio: "pipe", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

// Resolve the GLOBAL Hermes root, not a profile-scoped one.
//
// Trap worth knowing: when this runs inside an agent session that is itself
// profile-scoped, HERMES_HOME points at ~/.hermes/profiles/<name>, not ~/.hermes.
// Using it verbatim writes ~/.hermes/profiles/<name>/profiles/<lane>/SOUL.md --
// a nested path Hermes never reads, so the install silently does nothing.
// Detect that shape and walk back up to the real root.
function hermesRoot() {
  const env = (process.env.HERMES_HOME || "").trim();
  if (env) {
    const parts = env.split(path.sep);
    const i = parts.lastIndexOf("profiles");
    // ".../profiles/<name>" -> strip the last two segments
    if (i > 0 && i === parts.length - 2) {
      return parts.slice(0, i).join(path.sep);
    }
    return env;
  }
  return path.join(os.homedir(), ".hermes");
}

function profileExists(id) {
  try {
    const out = execFileSync("hermes", ["profile", "list"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return new RegExp(`(^|\\s)${id}(\\s|$)`, "m").test(out);
  } catch {
    return false;
  }
}

const actions = [];
const skipped = [];
const mcpManual = [];

function sameFile(a, b) {
  try {
    return fs.readFileSync(a, "utf8") === fs.readFileSync(b, "utf8");
  } catch {
    return false;
  }
}

function record(kind, detail) {
  actions.push({ kind, detail, applied: APPLY });
  log(`${APPLY ? "  ✔" : "  ·"} ${kind}: ${detail}`);
}

// Write Hermes mcp_servers.oracle-data directly into the profile config.
// Prefer this over `hermes mcp add`: current Hermes takes --command and --args
// as separate tokens, prompts interactively for tool enablement, and the old
// installer form `--command "node <path>"` silently no-ops under execFileSync.
function yamlScalar(value) {
  if (
    value === "" ||
    /[:#\[\]{},&*!|>'"%@`\s]/.test(value) ||
    /^(?:null|true|false|\d+)$/i.test(value)
  ) {
    return JSON.stringify(value);
  }
  return value;
}

function mcpServerBlock(serverName, scriptPath) {
  return [
    `  ${serverName}:`,
    "    command: node",
    "    args:",
    `      - ${yamlScalar(scriptPath)}`,
    "    enabled: true",
  ].join("\n");
}

function wireMcpIntoConfig(configPath, serverName, scriptPath) {
  const entry = mcpServerBlock(serverName, scriptPath);
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `mcp_servers:\n${entry}\n`, "utf8");
    return "created";
  }

  let txt = fs.readFileSync(configPath, "utf8");
  if (
    txt.includes(scriptPath) &&
    new RegExp(`^\\s*${serverName}:\\s*$`, "m").test(txt)
  ) {
    return "present";
  }

  // Replace an existing server block of the same name (simple indented map).
  const serverRe = new RegExp(
    `^([ \\t]*)${serverName}:\\s*\\n(?:\\1[ \\t]+.*\\n)*`,
    "m",
  );
  if (serverRe.test(txt)) {
    txt = txt.replace(serverRe, `${entry}\n`);
    fs.writeFileSync(configPath, txt, "utf8");
    return "updated";
  }

  if (/^mcp_servers:\s*$/m.test(txt) || /^mcp_servers:\s*\n/m.test(txt)) {
    txt = txt.replace(/^(mcp_servers:\s*\n)/m, `$1${entry}\n`);
  } else if (/^_config_version:.*$/m.test(txt)) {
    txt = txt.replace(
      /^(_config_version:.*\n)/m,
      `$1mcp_servers:\n${entry}\n`,
    );
  } else {
    txt = `mcp_servers:\n${entry}\n${txt}`;
  }
  fs.writeFileSync(configPath, txt, "utf8");
  return "wired";
}

// ---------------------------------------------------------------- main

const schema = loadSchema();
const skills = discoverSkills();
const skillNames = new Set(skills.keys());
let profiles = discoverProfiles();

// The template is documentation, not a lane to install.
profiles = profiles.filter((p) => !p.template);
if (only) profiles = profiles.filter((p) => p.id === only);

log(`oracle-init ${APPLY ? "(APPLY)" : "(dry run -- pass --apply to install)"}`);
log(`  profiles: ${profiles.length}   skills: ${skills.size}`);

// 1. validate everything BEFORE touching the system. A partial install across a
//    profile mesh is worse than no install.
const invalid = [];
for (const def of profiles) {
  const errs = validateProfile(def, schema, skillNames);
  if (errs.length) invalid.push({ id: def.id, errors: errs });
}
if (invalid.length) {
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({ ok: false, invalid }, null, 2)}\n`);
  } else {
    console.error("\nvalidation failed:");
    for (const v of invalid) {
      console.error(`  ${v.id}:`);
      for (const e of v.errors) console.error(`    - ${e}`);
    }
  }
  process.exit(1);
}
log("  validation: ok");

// Ensure a route/slippage attestation secret exists for fresh installs.
// Without it, swap sign/broadcast fails closed (unsigned guards are refused).
// Never overwrite an existing secret.
{
  const cfgDir = path.join(os.homedir(), ".config", "oracle");
  const envPath = path.join(cfgDir, "exec.env");
  let hasSecret = Boolean(
    process.env.ORACLE_ROUTE_ATTESTATION_SECRET || process.env.MAD_ROUTE_ATTESTATION_SECRET
  );
  if (!hasSecret && fs.existsSync(envPath)) {
    try {
      const txt = fs.readFileSync(envPath, "utf8");
      hasSecret = /^ORACLE_ROUTE_ATTESTATION_SECRET=.+$/m.test(txt) || /^MAD_ROUTE_ATTESTATION_SECRET=.+$/m.test(txt);
    } catch {
      /* treat as missing */
    }
  }
  if (hasSecret) {
    record("attestation secret", "present");
  } else {
    record("attestation secret", `generate -> ${path.relative(os.homedir(), envPath)}`);
    if (APPLY) {
      fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(cfgDir, 0o700);
      } catch {
        /* best-effort */
      }
      const secret = randomBytes(32).toString("hex");
      const line = `ORACLE_ROUTE_ATTESTATION_SECRET=${secret}\n`;
      if (fs.existsSync(envPath)) {
        const prev = fs.readFileSync(envPath, "utf8");
        if (!/ORACLE_ROUTE_ATTESTATION_SECRET=/.test(prev) && !/MAD_ROUTE_ATTESTATION_SECRET=/.test(prev)) {
          fs.appendFileSync(envPath, prev.endsWith("\n") || prev.length === 0 ? line : `\n${line}`, { mode: 0o600 });
        }
      } else {
        fs.writeFileSync(envPath, line, { mode: 0o600 });
      }
      try {
        fs.chmodSync(envPath, 0o600);
      } catch {
        /* best-effort */
      }
    }
  }
}

const hermes = hermesAvailable();
// The hermes CLI is a CONVENIENCE, not a requirement.
//
// Verified behaviour: Hermes discovers any profile directory under
// <root>/profiles/<name>/, so writing SOUL.md and skills/ is sufficient to create a
// working lane. `hermes profile create` only pre-seeds boilerplate, and
// `hermes mcp add` only edits that profile's config.
//
// Making the CLI mandatory would mean this installer -- and its tests -- could only
// run on a machine with Hermes already installed, which is both a worse contributor
// experience and untestable in CI. So: install files always, use the CLI when it is
// there, and say plainly what was skipped when it is not.
if (!hermes) {
  log(
    "  hermes CLI: not found -- installing profile files directly.\n" +
      "    (Hermes discovers any directory under <root>/profiles/, so this works.\n" +
      "     MCP wiring is the one step that needs the CLI; instructions printed at the end.)",
  );
} else {
  log("  hermes CLI: found");
}

// 2. install
for (const def of profiles) {
  log(`\n${def.label} (${def.id})`);

  // Snapshot what exists BEFORE we create anything. This is the reliable signal
  // for the no-clobber guard below.
  //
  // Why not just check for the file later: `hermes profile create` writes its own
  // boilerplate SOUL.md, so after creation a SOUL.md always exists. Treating that
  // as "the user's file" would make the guard refuse to install the lane persona,
  // the install would silently no-op, and every lane would run generic Hermes.
  // Only a file that predates our run can hold work worth protecting.
  const laneDir = path.join(hermesRoot(), "profiles", def.id);
  const soulDest = path.join(laneDir, "SOUL.md");
  const soulExistedBefore = fs.existsSync(soulDest);
  const skillExistedBefore = new Map(
    (def.skills || []).map((s) => [
      s,
      fs.existsSync(path.join(laneDir, "skills", s, "SKILL.md")),
    ]),
  );

  const preExisting = hermes ? profileExists(def.id) : fs.existsSync(laneDir);
  if (preExisting) {
    record("profile exists", def.id);
  } else if (hermes) {
    record("create profile", def.id);
    if (APPLY) {
      try {
        execFileSync("hermes", ["profile", "create", def.id], {
          stdio: "pipe",
          timeout: 120_000,
        });
      } catch (err) {
        // Not fatal: writing the directory below is what actually creates the lane.
        record("create note", `hermes profile create failed for ${def.id}; writing files directly`);
      }
    }
  } else {
    record("create profile dir", def.id);
    if (APPLY) fs.mkdirSync(laneDir, { recursive: true });
  }

  // SOUL.md -- never clobber a persona the user wrote.
  const soulSrc = path.join(def.__dir, "SOUL.md");
  if (fs.existsSync(soulSrc)) {
    const collision = soulExistedBefore && !sameFile(soulSrc, soulDest);
    if (collision && !FORCE) {
      record(
        "SKIP SOUL.md (exists)",
        `${path.relative(os.homedir(), soulDest)} -- kept yours; --force to overwrite`,
      );
      skipped.push({ lane: def.id, file: "SOUL.md", reason: "already exists" });
    } else {
      record("install SOUL.md", path.relative(os.homedir(), soulDest));
      if (APPLY) {
        fs.mkdirSync(path.dirname(soulDest), { recursive: true });
        if (collision) {
          const bak = `${soulDest}.bak-oracle-init-${Date.now()}`;
          fs.copyFileSync(soulDest, bak);
          record("backed up", path.relative(os.homedir(), bak));
        }
        fs.copyFileSync(soulSrc, soulDest);
      }
    }
  }

  // skills -- same discipline
  for (const s of def.skills || []) {
    const dest = path.join(laneDir, "skills", s, "SKILL.md");
    const collision = skillExistedBefore.get(s) && !sameFile(skills.get(s), dest);
    if (collision && !FORCE) {
      record("SKIP skill (exists)", `${s} -> ${def.id}`);
      skipped.push({ lane: def.id, file: `skills/${s}`, reason: "already exists" });
      continue;
    }
    record("install skill", `${s} -> ${def.id}`);
    if (APPLY) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(skills.get(s), dest);
    }
  }

  // MCP: write Hermes config directly. CLI is optional convenience only.
    for (const m of def.mcp || []) {
      const scriptPath = path.join(BIN_DIR, "oracle-data-mcp.mjs");
      const configPath = path.join(laneDir, "config.yaml");
      const manual = `hermes -p ${def.id} mcp add ${m} --command node --args ${scriptPath}`;

      if (m !== "oracle-data") {
        record("mcp manual", manual);
        mcpManual.push({ lane: def.id, server: m, command: manual });
        continue;
      }

      record(
        "wire mcp",
        `${m} (${def.id}) -> ${path.relative(os.homedir(), configPath)}`,
      );
      if (APPLY) {
        try {
          fs.mkdirSync(laneDir, { recursive: true });
          const how = wireMcpIntoConfig(configPath, m, scriptPath);
          record(
            "mcp config",
            `${how}: ${path.relative(os.homedir(), configPath)}`,
          );
        } catch (err) {
          record("mcp note", `could not write ${configPath}: ${err.message}`);
          mcpManual.push({ lane: def.id, server: m, command: manual });
        }
      }
    }

    record("posture", `DISARMED (${(def.posture.grantActions || []).join(", ")})`);
  }

  // ── Standalone agent skills ──
  // Copy shipped skill .md files to ~/.config/oracle/skills/ so the
  // standalone agent (skills-loader.mjs) finds them on first chat.
  const standaloneSkillsDir = path.join(os.homedir(), ".config", "oracle", "skills");
  const shippedSkillsDir = SKILLS_DIR;
  if (APPLY && fs.existsSync(shippedSkillsDir)) {
    fs.mkdirSync(standaloneSkillsDir, { recursive: true });
    let copied = 0;
    for (const entry of fs.readdirSync(shippedSkillsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const src = path.join(shippedSkillsDir, entry.name);
      const dst = path.join(standaloneSkillsDir, entry.name);
      if (!FORCE && fs.existsSync(dst)) {
        skipped.push({ lane: "standalone", file: entry.name });
        continue;
      }
      try {
        fs.copyFileSync(src, dst);
        copied++;
      } catch (err) {
        record("skill copy", `failed ${entry.name}: ${err.message}`);
      }
    }
    if (copied) log(`  standalone skills: ${copied} installed to ${standaloneSkillsDir}`);
  }

const summary = {
  ok: true,
  applied: APPLY,
  profiles: profiles.map((p) => p.id),
  skills: [...skillNames],
  actions: actions.length,
  skipped,
  mcpManual,
  hermesDetected: hermes,
  hermesRoot: hermesRoot(),
};

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  log(`\n${APPLY ? "installed" : "would install"} ${profiles.length} lanes.`);
  if (skipped.length) {
    log(`${skipped.length} file(s) already existed and were kept:`);
    for (const s of skipped) log(`  - ${s.lane}/${s.file}`);
    log("pass --force to overwrite (a timestamped .bak is written first).");
  }
  if (mcpManual.length) {
    log("\nMCP wiring needed a manual follow-up:");
    for (const m of mcpManual) log(`  ${m.command}`);
  }
  if (!APPLY) log("re-run with --apply to make changes.");
  log("\nEvery lane is DISARMED. Start the read plane, then chat a lane:");
  log("  npx oracle-data                 # 127.0.0.1:8787 — MCP tools need this");
  log("  hermes -p oracle chat");
  log("\nSet each lane's model in:");
  log(`  ${path.join(hermesRoot(), "profiles", "<lane>", "config.yaml")}`);
}
