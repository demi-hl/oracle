#!/usr/bin/env node
// Release gate: shipped prose must not contradict shipped behavior.
//
// Why this exists. The 2026-08-01 four-model audit found the same stale claim
// in 20 places across both packages: docs said the unattended signer was
// limited to `hl` and `poly` long after six bounded surfaces had shipped. The
// worst instances were not READMEs — they were `profiles/oracle/SOUL.md` and
// `skills/oracle-action-semantics/SKILL.md`, which are read by the MODEL. An
// agent told that EVM daemon execution is impossible reasons incorrectly about
// its own authority, and no test suite can see a false sentence.
//
// This scans every doc surface that ships in the tarball, including model-facing
// SOUL and skill text, which is exactly where drift hides longest.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const failures = [];

// Claims that shipped in a real release and are now false.
const STALE_CLAIMS = [
  { re: /limited\s+to\s+`?hl`?\s+and\s+`?poly`?/i, why: "says the unattended signer is limited to hl+poly" },
  { re: /only\s+`?hl`?\s+and\s+`?poly`?\s+are\s+enabled/i, why: "says only hl+poly are daemon-enabled" },
  { re: /daemon\s+surfaces\s+remain\s+`?hl`?\s+and\s+`?poly`?/i, why: "freezes the surface list at hl+poly" },
  { re: /policy-bounded\s+`?hl`?\s+and\s+`?poly`?\s+only/i, why: "restricts the daemon to hl+poly" },
  { re: /agent-facing\s+daemon\s+supports\s+only\s+policy-bounded\s+Hyperliquid\s+and\s+Polymarket\s+execution/i, why: "says the agent-facing daemon supports only Hyperliquid+Polymarket" },
  { re: /`?evm`?,?\s+`?btc`?,?\s+and\s+`?sol`?\s+fail\s+closed\s+at\s+the\s+daemon/i, why: "claims evm/btc/sol are refused at the daemon" },
  { re: /EVM,\s*BTC,?\s*and\s+Solana\s+are\s+not\s+daemon\s+surfaces/i, why: "denies evm/btc/sol are daemon surfaces" },
  { re: /companion\s+daemon\s+is\s+`?hl`?\s*\/\s*`?poly`?[- ]only/i, why: "describes the companion daemon as hl/poly-only" },
  { re: /daemon\s+supports\s+only\s+policy-bounded\s+Hyperliquid\s+and\s+Polymarket/i, why: "describes the daemon as Hyperliquid/Polymarket-only" },
  { re: /unattended\s+signer\s+remains\s+`?hl`?\s*\/\s*`?poly`?/i, why: "freezes the generic signer at hl/poly" },
  { re: /supports\s+autonomous\s+Hyperliquid\s+and\s+Polymarket\s+execution/i, why: "describes the daemon as Hyperliquid/Polymarket-only" },
  { re: /\(HL\s*\+\s*Poly,\s*capped\)/i, why: "documents autosign as hl/poly-only" },
  { re: /policy-bounded\s+HL\s*\/\s*Polymarket\s+exec/i, why: "documents the signer daemon as hl/poly-only" },
  { re: /policy-bounded\s+daemon\s+surfaces:\s*hl\s*\|\s*poly\s*$/i, why: "documents only two of six daemon surfaces" },
  { re: /ORACLE_SIGNER_SURFACES=hl,poly\s*$/i, why: "quickstart freezes ORACLE_SIGNER_SURFACES at hl,poly" },
  { re: /ORACLE_AUTONOMOUS_TRADING=1.*(?:or\s+run\s+the\s+signer\s+daemon|same(?:-tier)?).*oracle-signer/i, why: "frames direct exec and oracle-signer as equivalent agent paths" },
  { re: /(?:or\s+run\s+the\s+signer\s+daemon|same(?:-tier)?).*oracle-signer.*ORACLE_AUTONOMOUS_TRADING=1/i, why: "frames direct exec and oracle-signer as equivalent agent paths" },
  { re: /ORACLE_AUTONOMOUS=1/i, why: "names the dead autonomous env var instead of ORACLE_AUTONOMOUS_TRADING" },
];

// Version pins that go stale the moment a release ships. The audit found the
// quickstart advertising 0.3.6/0.6.1 inside a 0.4.0 tarball, so a copy-paste
// install handed users an older wall set.
function checkVersionPins(rel, text) {
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const pin = line.match(/@oracle-agent\/oracle@(\d+\.\d+\.\d+)/);
    if (pin && pin[1] !== pkg.version) {
      failures.push(
        `${rel}:${i + 1} pins @oracle-agent/oracle@${pin[1]} but this package is ${pkg.version}\n    ${line.trim().slice(0, 120)}`,
      );
    }
    const latest = line.match(/Latest:.*oracle\s+`(\d+\.\d+\.\d+)`/i);
    if (latest && latest[1] !== pkg.version) {
      failures.push(
        `${rel}:${i + 1} advertises oracle ${latest[1]} as latest but this package is ${pkg.version}\n    ${line.trim().slice(0, 120)}`,
      );
    }
    // The 2026-08-03 grok lane found `Source tree: **oracle \`0.5.0\`**` and a
    // `Published npm: **oracle \`0.4.2\`**` line surviving inside a 0.10.0
    // tarball. Both shapes sailed past the two matchers above, so a stranger
    // reading the shipped README saw a version five releases stale. Match any
    // prose that states an oracle version, not just the two blessed prefixes.
    const stated = line.match(/oracle\s+`(\d+\.\d+\.\d+)`/i);
    if (stated && stated[1] !== pkg.version) {
      failures.push(
        `${rel}:${i + 1} states oracle ${stated[1]} but this package is ${pkg.version}\n    ${line.trim().slice(0, 120)}`,
      );
    }
  });
}

// Every markdown surface that ships to a user or a model.
function docFiles() {
  const out = [];
  for (const rel of ["README.md", "SETUP.md", "SECURITY.md"]) {
    if (existsSync(path.join(root, rel))) out.push(rel);
  }
  for (const dir of ["docs", "profiles", "skills"]) {
    const abs = path.join(root, dir);
    if (!existsSync(abs)) continue;
    const walk = (d) => {
      for (const entry of readdirSync(d)) {
        const full = path.join(d, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".md")) out.push(path.relative(root, full));
      }
    };
    walk(abs);
  }
  return out;
}

const files = docFiles();
for (const rel of files) {
  const text = readFileSync(path.join(root, rel), "utf8");
  text.split("\n").forEach((line, i) => {
    for (const claim of STALE_CLAIMS) {
      if (claim.re.test(line)) {
        failures.push(`${rel}:${i + 1} ${claim.why}\n    ${line.trim().slice(0, 140)}`);
      }
    }
  });
  checkVersionPins(rel, text);
}

console.log(`package version: ${pkg.version}`);
console.log(`doc surfaces scanned: ${files.length} (README/SETUP/SECURITY + docs/ + profiles/ + skills/)`);
console.log("");

if (failures.length) {
  console.error(`FAIL — ${failures.length} doc/code drift finding(s):\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  console.error("Shipped prose contradicts shipped behavior. Model-facing SOUL/skill text counts:");
  console.error("an agent that reads a false capability claim reasons wrongly about its own authority.");
  process.exit(1);
}

console.log("PASS — no stale capability claims or version pins in shipped docs");
