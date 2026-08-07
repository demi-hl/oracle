import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envEnabled, envFlag } from "../src/oracle-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Env flags have a POLARITY and getting it backwards fails silently.
//
// The bug this locks (found 2026-08-01): envEnabled was `!== "0"`. Used with a
// FALSE default, that inverts — `ORACLE_ONBOARD_HTTP=false`, written by a user
// who wanted the surface OFF, ENABLED it, because "false" is not "0".
//
// The rule:
//   default-ON  -> every common disable word must disable. Failing to disable
//                  leaves authority standing.
//   default-OFF -> only an explicit enable value may enable. A disable word
//                  must never turn something on.
//
// Both directions fail toward LESS authority. The asymmetry is the point.
//
// Deliberate exception, do not "fix" it: ORACLE_VALUE_CAPS_ENABLED in
// exec-policy.mjs keeps a strict `!== "0"` parse. That flag LIFTS a spend cap,
// so its polarity is inverted relative to a kill switch — a stray "false" must
// leave the cap wall standing rather than silently removing it.

const DISABLE_WORDS = ["0", "false", "off", "no", "FALSE", "Off", " no "];
const ENABLE_WORDS = ["1", "true", "yes", "on"];

function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("a disable word never enables a default-OFF flag", () => {
  for (const word of DISABLE_WORDS) {
    withEnv({ ORACLE_GATE_PROBE: word }, () => {
      assert.equal(
        envEnabled("ORACLE_GATE_PROBE", "MAD_GATE_PROBE", false),
        false,
        `ORACLE_GATE_PROBE=${JSON.stringify(word)} must not enable a default-off surface`,
      );
    });
  }
});

test("a disable word turns off a default-ON flag", () => {
  for (const word of DISABLE_WORDS) {
    withEnv({ ORACLE_GATE_PROBE: word }, () => {
      assert.equal(envEnabled("ORACLE_GATE_PROBE", "MAD_GATE_PROBE", true), false);
    });
  }
});

test("unset keeps the declared default in both directions", () => {
  withEnv({ ORACLE_GATE_PROBE: null, MAD_GATE_PROBE: null }, () => {
    assert.equal(envEnabled("ORACLE_GATE_PROBE", "MAD_GATE_PROBE", true), true);
    assert.equal(envEnabled("ORACLE_GATE_PROBE", "MAD_GATE_PROBE", false), false);
  });
});

test("envFlag stays strict so a typo can never arm a surface", () => {
  for (const word of ["true", "yes", "on", "banana", "0", "false"]) {
    withEnv({ ORACLE_GATE_PROBE: word }, () => {
      assert.equal(envFlag("ORACLE_GATE_PROBE", "MAD_GATE_PROBE", false), false);
    });
  }
  withEnv({ ORACLE_GATE_PROBE: "1" }, () => {
    assert.equal(envFlag("ORACLE_GATE_PROBE", "MAD_GATE_PROBE", false), true);
  });
});

test("the execute and deploy arm flags are not enabled by a disable word", async () => {
  const flags = await import("../src/flags.mjs");
  assert.equal(typeof flags.executeGloballyEnabled, "function");
  assert.equal(typeof flags.deployGloballyEnabled, "function");
  for (const word of DISABLE_WORDS) {
    withEnv({ ORACLE_EXECUTE_ENABLED: word, MAD_EXECUTE_ENABLED: word }, () => {
      assert.equal(flags.executeGloballyEnabled(), false, `ORACLE_EXECUTE_ENABLED=${word} must not arm`);
    });
    withEnv({ ORACLE_DEPLOY_ENABLED: word, MAD_DEPLOY_ENABLED: word }, () => {
      assert.equal(flags.deployGloballyEnabled(), false, `ORACLE_DEPLOY_ENABLED=${word} must not arm`);
    });
  }
});

// Grep guard. The specific defect was a bare `!== "0"` against an env var.
// New ones must route through envEnabled/envFlag instead.
test("no new env flag is parsed with a bare !== \"0\" comparison", () => {
  const offenders = [];
  const skip = new Set(["node_modules", ".git", "test"]);
  // exec-policy's value-caps toggle is the documented exception above.
  const ALLOWED = new Set(["src/exec-policy.mjs"]);

  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.endsWith(".mjs")) continue;
      const rel = path.relative(root, abs);
      if (ALLOWED.has(rel)) continue;
      readFileSync(abs, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/env\([^)]*\)[^\n]*!==\s*["']0["']|process\.env\.[A-Z_]+[^\n]*!==\s*["']0["']/.test(line)) {
            offenders.push(`${rel}:${i + 1} ${line.trim().slice(0, 120)}`);
          }
        });
    }
  }

  walk(path.join(root, "src"));
  walk(path.join(root, "bin"));

  assert.deepEqual(
    offenders,
    [],
    `env flags must use envEnabled()/envFlag(), not a bare !== "0":\n${offenders.join("\n")}`,
  );
});
