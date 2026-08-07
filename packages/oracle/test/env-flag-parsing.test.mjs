import test from "node:test";
import assert from "node:assert/strict";
import { envEnabled, envFlag } from "../src/oracle-env.mjs";

function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// The bug this locks: envEnabled used `!== "0"`, so with a FALSE default a user
// writing `false` (to keep the surface off) actually turned it ON, because the
// string "false" is not "0". A disable word must never enable a surface.
test("a disable word never enables a default-off flag", () => {
  for (const value of ["0", "false", "off", "no", "FALSE", "Off", " no "]) {
    withEnv({ ORACLE_TEST_FLAG: value }, () => {
      assert.equal(
        envEnabled("ORACLE_TEST_FLAG", "MAD_TEST_FLAG", false),
        false,
        `ORACLE_TEST_FLAG=${JSON.stringify(value)} must not enable`,
      );
    });
  }
});

test("a disable word turns off a default-on flag", () => {
  for (const value of ["0", "false", "off", "no", "FALSE", " Off "]) {
    withEnv({ ORACLE_TEST_FLAG: value }, () => {
      assert.equal(envEnabled("ORACLE_TEST_FLAG", "MAD_TEST_FLAG", true), false);
    });
  }
});

test("unset keeps the declared default", () => {
  withEnv({ ORACLE_TEST_FLAG: null, MAD_TEST_FLAG: null }, () => {
    assert.equal(envEnabled("ORACLE_TEST_FLAG", "MAD_TEST_FLAG", true), true);
    assert.equal(envEnabled("ORACLE_TEST_FLAG", "MAD_TEST_FLAG", false), false);
  });
});

test("an explicit enable value turns on a default-off flag", () => {
  for (const value of ["1", "true", "yes", "on"]) {
    withEnv({ ORACLE_TEST_FLAG: value }, () => {
      assert.equal(envEnabled("ORACLE_TEST_FLAG", "MAD_TEST_FLAG", false), true);
    });
  }
});

// envFlag is the default-OFF reader: enabling must stay strict so a typo can
// never arm a surface. This is deliberately NOT symmetric with envEnabled.
test("envFlag only enables on literal 1", () => {
  for (const value of ["true", "yes", "on", "banana", "0", "false"]) {
    withEnv({ ORACLE_TEST_FLAG: value }, () => {
      assert.equal(envFlag("ORACLE_TEST_FLAG", "MAD_TEST_FLAG", false), false);
    });
  }
  withEnv({ ORACLE_TEST_FLAG: "1" }, () => {
    assert.equal(envFlag("ORACLE_TEST_FLAG", "MAD_TEST_FLAG", false), true);
  });
});
