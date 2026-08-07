// Tests for the profile mesh + oracle-init installer.
//
// The installer touches a user's real Hermes directory, so the properties worth
// testing are: (a) every shipped lane is valid and DISARMED, (b) no lane names a
// skill that doesn't exist -- the phantom-skill bug the original pack manifest
// had -- and (c) --apply never destroys a user's existing SOUL.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILES = path.join(ROOT, "profiles");
const SKILLS = path.join(ROOT, "skills");
const INIT = path.join(ROOT, "bin", "oracle-init.mjs");

function lanes() {
  return fs
    .readdirSync(PROFILES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(PROFILES, e.name, "profile.json"))
    .filter((p) => fs.existsSync(p))
    .map((p) => JSON.parse(fs.readFileSync(p, "utf8")));
}

function skillNames() {
  return new Set(
    fs
      .readdirSync(SKILLS, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(SKILLS, e.name, "SKILL.md")))
      .map((e) => e.name),
  );
}

test("every lane ships DISARMED with no signing authority", () => {
  for (const def of lanes()) {
    assert.equal(
      def.posture.default,
      "DISARMED",
      `${def.id} must ship DISARMED`,
    );
    assert.ok(
      ["none", "user-wallet"].includes(def.posture.signing),
      `${def.id} signing must be none|user-wallet, got ${def.posture.signing}`,
    );
  }
});

test("no lane requests a broadcast or signing grant action", () => {
  // Every allowed action is read, simulate, or prepare. If a future lane asks for
  // broadcast, that is a custody change and must not pass silently.
  const allowed = new Set([
    "read:chain",
    "simulate:tx",
    "prepare:swap",
    "prepare:order",
    "prepare:deploy",
    "prepare:verify",
    "prepare:mint",
    "prepare:inscription",
  ]);
  for (const def of lanes()) {
    for (const a of def.posture.grantActions) {
      assert.ok(allowed.has(a), `${def.id} requests forbidden action "${a}"`);
      assert.ok(
        !/^(broadcast|sign|send):/.test(a),
        `${def.id} must not request "${a}"`,
      );
    }
  }
});

test("every skill a lane names actually exists", () => {
  const have = skillNames();
  const missing = [];
  for (const def of lanes()) {
    for (const s of def.skills || []) {
      if (!have.has(s)) missing.push(`${def.id} -> ${s}`);
    }
  }
  assert.deepEqual(missing, [], `lanes reference non-existent skills:\n  ${missing.join("\n  ")}`);
});

test("Oracle and Robinhood lanes ship binding watch/arm execution semantics", () => {
  const byId = new Map(lanes().map((lane) => [lane.id, lane]));
  for (const id of ["oracle", "robinhood-agent"]) {
    assert.ok(
      byId.get(id)?.skills?.includes("oracle-action-semantics"),
      `${id} must install oracle-action-semantics`,
    );
  }

  const body = fs.readFileSync(
    path.join(SKILLS, "oracle-action-semantics", "SKILL.md"),
    "utf8",
  );
  assert.match(body, /public prepare plane/i);
  assert.match(body, /generic.*signer.*hl.*poly/is);
  assert.match(body, /owner-gated.*EVM executor/is);
  assert.match(body, /watch.*alert_only/is);
  assert.match(body, /arm.*execute/is);
});

test("multichain launch skills stay prepare-only and fail closed", () => {
  const names = [
    "oracle-multichain-token-launch",
    "oracle-multichain-nft-launch",
  ];
  for (const name of names) {
    const body = fs.readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8");
    assert.match(body, /UNSUPPORTED/);
    assert.match(body, /Never broadcast from this skill\./);
    assert.match(body, /user signs/i);
    assert.match(body, /support status/i);
  }

  for (const id of ["oracle", "protocol-builder"]) {
    const def = lanes().find((lane) => lane.id === id);
    assert.ok(def, `missing ${id} lane`);
    for (const name of names) {
      assert.ok(def.skills.includes(name), `${id} must install ${name}`);
    }
  }
});

test("lane ids are Hermes-legal (lowercase, no dots)", () => {
  for (const def of lanes()) {
    assert.match(
      def.id,
      /^[a-z_][a-z0-9-]*$/,
      `${def.id} is not a legal Hermes profile name (dots are rejected by Hermes)`,
    );
  }
});

test("no lane pins a model id or provider", () => {
  // Oracle is model-agnostic. profile.json carries a capability CLASS so the
  // installer never writes a vendor into a user's config.
  for (const def of lanes()) {
    const blob = JSON.stringify(def);
    assert.ok(
      !/claude-|gpt-|grok-|deepseek-|qwen|provider"\s*:/i.test(blob),
      `${def.id} must not pin a model or provider`,
    );
  }
});

test("posture rationale is present and substantive on every lane", () => {
  for (const def of lanes()) {
    assert.ok(
      typeof def.posture.rationale === "string" && def.posture.rationale.length >= 20,
      `${def.id} needs a real posture rationale`,
    );
  }
});

test("dry run is the default: no --apply means no writes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-init-dry-"));
  try {
    const out = execFileSync("node", [INIT, "--json"], {
      encoding: "utf8",
      env: { ...process.env, HERMES_HOME: tmp },
      timeout: 120_000,
    });
    const summary = JSON.parse(out);
    assert.equal(summary.applied, false);
    assert.ok(summary.ok);
    // Nothing should have been created.
    assert.equal(
      fs.existsSync(path.join(tmp, "profiles")),
      false,
      "dry run must not create profile directories",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("--apply installs SOUL and skills into a clean Hermes root", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-init-apply-"));
  try {
    execFileSync("node", [INIT, "--apply", "--only", "solana-agent", "--json"], {
      encoding: "utf8",
      env: { ...process.env, HERMES_HOME: tmp },
      timeout: 180_000,
    });

    const soul = path.join(tmp, "profiles", "solana-agent", "SOUL.md");
    assert.ok(fs.existsSync(soul), "SOUL.md should be installed");
    assert.match(fs.readFileSync(soul, "utf8"), /solana agent/i);

    const skill = path.join(
      tmp,
      "profiles",
      "solana-agent",
      "skills",
      "oracle-solana",
      "SKILL.md",
    );
    assert.ok(fs.existsSync(skill), "lane skill should be installed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("--apply does NOT clobber an existing SOUL.md", () => {
  // The failure this prevents: a user already has a profile named "oracle" with a
  // hand-written persona, runs the installer, and loses it.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-init-noclobber-"));
  try {
    const dir = path.join(tmp, "profiles", "solana-agent");
    fs.mkdirSync(dir, { recursive: true });
    const soul = path.join(dir, "SOUL.md");
    const mine = "# my own persona\nDo not overwrite me.\n";
    fs.writeFileSync(soul, mine);

    const out = execFileSync(
      "node",
      [INIT, "--apply", "--only", "solana-agent", "--json"],
      {
        encoding: "utf8",
        env: { ...process.env, HERMES_HOME: tmp },
        timeout: 180_000,
      },
    );

    assert.equal(fs.readFileSync(soul, "utf8"), mine, "user's SOUL.md must survive");
    const summary = JSON.parse(out);
    assert.ok(
      summary.skipped.some((s) => s.file === "SOUL.md"),
      "skip must be reported, not silent",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("--force overwrites but backs the original up first", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-init-force-"));
  try {
    const dir = path.join(tmp, "profiles", "solana-agent");
    fs.mkdirSync(dir, { recursive: true });
    const soul = path.join(dir, "SOUL.md");
    const mine = "# my own persona\n";
    fs.writeFileSync(soul, mine);

    execFileSync(
      "node",
      [INIT, "--apply", "--force", "--only", "solana-agent", "--json"],
      {
        encoding: "utf8",
        env: { ...process.env, HERMES_HOME: tmp },
        timeout: 180_000,
      },
    );

    assert.notEqual(fs.readFileSync(soul, "utf8"), mine, "--force should replace");
    const backups = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("SOUL.md.bak-oracle-init-"));
    assert.equal(backups.length, 1, "a backup must be written before overwriting");
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), mine);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("installs WITHOUT the hermes CLI on PATH (CI parity)", () => {
  // Regression: the installer used to hard-exit when `hermes` was absent, so it
  // could only run on a machine that already had Hermes -- and its own tests could
  // not run in CI. Hermes discovers any directory under <root>/profiles/, so file
  // installation never needed the CLI. Only MCP wiring does.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-init-nocli-"));
  try {
    // Build a minimal PATH that can still find node but NOT the hermes wrapper.
    //
    // Do not hardcode /usr/bin here: CI runners install node under
    // /opt/hostedtoolcache/..., so a fixed PATH makes the spawn itself fail with
    // ENOENT and the test reports a false negative about the installer.
    const nodeDir = path.dirname(process.execPath);
    const minimalPath = [nodeDir, "/usr/bin", "/bin"].join(path.delimiter);

    const out = execFileSync(
      "node",
      [INIT, "--apply", "--only", "solana-agent", "--json"],
      {
        encoding: "utf8",
        env: { PATH: minimalPath, HERMES_HOME: tmp },
        timeout: 180_000,
      },
    );
    const summary = JSON.parse(out);
    assert.equal(summary.ok, true);
    assert.equal(
      summary.hermesDetected,
      false,
      `this test must run without the hermes CLI; PATH was ${minimalPath}`,
    );

    // Files still land.
    assert.ok(fs.existsSync(path.join(tmp, "profiles", "solana-agent", "SOUL.md")));
    assert.ok(
      fs.existsSync(
        path.join(tmp, "profiles", "solana-agent", "skills", "oracle-solana", "SKILL.md"),
      ),
    );

    // And MCP is wired into the profile config without needing the hermes CLI.
    assert.ok(summary.mcpManual.length === 0, "oracle-data MCP should be auto-written, not manual");
    const cfg = fs.readFileSync(
      path.join(tmp, "profiles", "solana-agent", "config.yaml"),
      "utf8",
    );
    assert.match(cfg, /mcp_servers:/);
    assert.match(cfg, /oracle-data:/);
    assert.match(cfg, /command:\s*node/);
    assert.match(cfg, /oracle-data-mcp\.mjs/);
    assert.match(cfg, /enabled:\s*true/);
    // Manual form (if ever needed) must use --command node --args <path>, not
    // the broken single-string `--command "node <path>"` that Hermes rejects.
    assert.doesNotMatch(
      JSON.stringify(summary),
      /--command "node /,
      "must not emit the broken hermes mcp add form",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("installer rejects an invalid lane instead of half-installing", () => {
  // Validation runs across ALL lanes before any write, because a partial install
  // across a profile mesh is worse than no install.
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-init-bad-"));
  try {
    // Minimal fake repo: schema + one bad lane + the skills dir.
    fs.mkdirSync(path.join(tmpRepo, "profiles", "bad-lane"), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, "bin"), { recursive: true });
    fs.cpSync(SKILLS, path.join(tmpRepo, "skills"), { recursive: true });
    fs.copyFileSync(
      path.join(PROFILES, "profile.schema.json"),
      path.join(tmpRepo, "profiles", "profile.schema.json"),
    );
    fs.copyFileSync(INIT, path.join(tmpRepo, "bin", "oracle-init.mjs"));
    fs.writeFileSync(
      path.join(tmpRepo, "profiles", "bad-lane", "profile.json"),
      JSON.stringify({
        id: "bad-lane",
        label: "bad",
        role: "venue",
        description: "a lane that asks for too much",
        skills: ["does-not-exist"],
        posture: {
          default: "DISARMED",
          grantActions: ["read:chain"],
          signing: "user-wallet",
          rationale: "this rationale is long enough to pass",
        },
      }),
    );

    let failed = false;
    try {
      execFileSync("node", [path.join(tmpRepo, "bin", "oracle-init.mjs"), "--json"], {
        encoding: "utf8",
        timeout: 120_000,
        stdio: "pipe",
      });
    } catch {
      failed = true;
    }
    assert.ok(failed, "a lane naming a missing skill must fail validation");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
