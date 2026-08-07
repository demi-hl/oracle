import fs from "node:fs";
import path from "node:path";
import { DOCTOR_SIGNING_OPTIONAL } from "../first-run.mjs";
import { resolveHermes } from "../runtime.mjs";

function nodeVersionOk() {
  const [maj, min] = process.versions.node.split(".").map(Number);
  return maj > 20 || (maj === 20 && min >= 19);
}

function loadExecEnv(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}


async function probeDataServer(url) {
  try {
    // The server serves /health; / intentionally 404s with a route list, so
    // probing / reported a healthy server as down.
    const res = await fetch(url.replace(/\/$/, "") + "/health");
    return res.ok;
  } catch {
    return false;
  }
}

export default {
  name: "doctor",
  summary: "check read plane; checks signer too when installed",
  group: "read",
  usage: "oracle doctor [--json]",
  async run(ctx) {
    const json = ctx.argv.includes("--json");
    const checks = [];
    let failed = false;
    const push = (id, status, detail, fix = null) => {
      checks.push({ id, status, detail, fix });
      if (status === "fail") failed = true;
    };

    push("node", nodeVersionOk() ? "ok" : "fail", `node ${process.versions.node}`,
      nodeVersionOk() ? null : "install node >= 20.19");

    const execEnvPath = ctx.paths.oracleExecEnvPath();
    const envFile = loadExecEnv(execEnvPath);
    // `oracle init --apply` writes ORACLE_ROUTE_ATTESTATION_SECRET (see
    // bin/oracle-init.mjs), but doctor checked only ORACLE_ATTESTATION_SECRET
    // and ORACLE_STAMP_HMAC_SECRET — so it told the user to rerun an init step
    // that could never satisfy the check.
    const att =
      process.env.ORACLE_ROUTE_ATTESTATION_SECRET ||
      process.env.MAD_ROUTE_ATTESTATION_SECRET ||
      process.env.ORACLE_ATTESTATION_SECRET ||
      process.env.ORACLE_STAMP_HMAC_SECRET ||
      envFile.ORACLE_ROUTE_ATTESTATION_SECRET ||
      envFile.MAD_ROUTE_ATTESTATION_SECRET ||
      envFile.ORACLE_ATTESTATION_SECRET ||
      envFile.ORACLE_STAMP_HMAC_SECRET;
    push("attestation_secret", att ? "ok" : "warn", att ? "present" : "missing",
      att ? null : "run oracle init --apply (writes ~/.config/oracle/exec.env)");

    const dataUrl = process.env.ORACLE_DATA_URL || "http://127.0.0.1:8787";
    const dataUp = await probeDataServer(dataUrl);
    push("data_server", dataUp ? "ok" : "warn", dataUp ? `reachable ${dataUrl}` : `down ${dataUrl}`,
      dataUp ? null : "oracle data serve");

    const runtime = resolveHermes();
    push("agent_runtime", runtime.ok ? "ok" : "warn",
      runtime.ok ? `present ${runtime.bin} (${runtime.source})` : "not installed",
      runtime.ok ? null : "oracle bootstrap");

    const profilesDir = path.join(ctx.paths.hermesRoot(), "profiles");
    let laneCount = 0;
    if (fs.existsSync(profilesDir)) {
      laneCount = fs.readdirSync(profilesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    }
    push("hermes_lanes", laneCount > 0 ? "ok" : "warn",
      laneCount > 0 ? `${laneCount} profile dir(s)` : "no lane profiles found",
      laneCount > 0 ? null : "oracle init --apply");

    const operator = ctx.resolveOperator();
    let operatorBlock = { installed: false };
    if (operator.ok) {
      const r = ctx.dispatchOperator("oracle-agentic-doctor", ["--json"], { stdio: "pipe" });
      let detail = { installed: true, version: operator.version, source: operator.source };
      if (r && typeof r === "object" && r.stdout) {
        try {
          const parsed = JSON.parse(r.stdout);
          detail = {
            installed: true,
            version: operator.version,
            source: operator.source,
            signingReady: parsed.signingReady,
            broadcastReady: parsed.broadcastReady,
            executionReady: parsed.executionReady,
            masterKillSwitch: parsed.masterKillSwitch,
            raw: parsed,
          };
        } catch {
          detail.doctorParseError = true;
          detail.doctorExit = r.code;
        }
      } else if (typeof r === "number") {
        detail.doctorExit = r;
      }
      operatorBlock = detail;
      const signingReady = detail.signingReady === true;
      push(
        "signing",
        signingReady ? "ok" : "warn",
        signingReady
          ? `operator ${operator.version} ready via ${operator.source}`
          : `operator ${operator.version} installed but signing is not ready`,
        signingReady ? null : "oracle sign doctor --json",
      );
    }

    const report = { ok: !failed, checks, operator: operatorBlock };
    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      for (const c of checks) {
        process.stdout.write(`${c.status.toUpperCase().padEnd(4)} ${c.id}: ${c.detail}\n`);
        if (c.fix) process.stdout.write(`     fix: ${c.fix}\n`);
      }
      if (!operator.ok) process.stdout.write(`INFO ${DOCTOR_SIGNING_OPTIONAL}\n`);
    }
    return failed ? 1 : 0;
  },
};
