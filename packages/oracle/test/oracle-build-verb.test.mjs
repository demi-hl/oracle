// Oracle BUILD verb — boundary tests.
//
// The whole value of a deploy verb is that it CANNOT become arbitrary deploy.
// These tests exist to prove that boundary, not to prove the happy path works.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  BUILD_EXECUTE_SCOPE,
  BUILD_PREPARE_SCOPE,
  BUILD_REGISTRY,
  buildExecutionAllowed,
  buildProposal,
  listBuildTargets,
  renderBuildProposal,
  validateBuildRequest,
} from "../src/public-control/build-registry.mjs";
import { ALLOWED_SCOPES, DEFAULT_SCOPES, normalizeScopes } from "../src/scopes.mjs";

const GOOD_ARGS = {
  name: "Test Token",
  symbol: "TEST",
  creator: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  reflectionBps: 0,
};

function withFactory(fn) {
  const f = BUILD_REGISTRY[988].factories["stable.tokenFactory"];
  const prev = f.address;
  f.address = "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6";
  try {
    return fn();
  } finally {
    f.address = prev;
  }
}

// ---- the core boundary: no arbitrary bytecode, ever -------------------------

test("fail closed: raw bytecode is rejected outright", () => {
  for (const field of ["bytecode", "initCode", "init_code", "data", "creationCode", "salt"]) {
    assert.throws(
      () =>
        validateBuildRequest({
          chainId: 988,
          target: "stable.tokenFactory",
          args: GOOD_ARGS,
          [field]: "0x6080604052",
        }),
      /arbitrary deploy is not supported/,
      `field "${field}" must be rejected`,
    );
  }
});

test("fail closed: unknown chain has no build targets", () => {
  assert.throws(
    () => validateBuildRequest({ chainId: 1, target: "stable.tokenFactory", args: GOOD_ARGS }),
    /no build targets/,
  );
});

test("fail closed: unknown factory target on a known chain", () => {
  assert.throws(
    () => validateBuildRequest({ chainId: 988, target: "evil.factory", args: GOOD_ARGS }),
    /unknown build target/,
  );
});

test("fail closed: a target with no pinned address cannot be built", () => {
  // Stable's factory is intentionally unpinned until an operator supplies a
  // verified mainnet address. Knowing HOW to build must not imply being able to.
  assert.equal(BUILD_REGISTRY[988].factories["stable.tokenFactory"].address, null);
  assert.throws(
    () => validateBuildRequest({ chainId: 988, target: "stable.tokenFactory", args: GOOD_ARGS }),
    /no pinned factory address/,
  );
});

test("fail closed: non-object and missing inputs", () => {
  assert.throws(() => validateBuildRequest(null), /must be an object/);
  assert.throws(() => validateBuildRequest([]), /must be an object/);
  assert.throws(() => validateBuildRequest({}), /chainId required/);
  assert.throws(() => validateBuildRequest({ chainId: 988 }), /target required/);
});

// ---- argument validation ---------------------------------------------------

test("args are validated against the factory's own limits", () => {
  withFactory(() => {
    const base = { chainId: 988, target: "stable.tokenFactory" };

    assert.throws(
      () => validateBuildRequest({ ...base, args: { ...GOOD_ARGS, name: "" } }),
      /args.name required/,
    );
    assert.throws(
      () => validateBuildRequest({ ...base, args: { ...GOOD_ARGS, symbol: "" } }),
      /args.symbol required/,
    );
    assert.throws(
      () => validateBuildRequest({ ...base, args: { ...GOOD_ARGS, creator: "nope" } }),
      /args.creator must be a valid address/,
    );
    // factory MAX_REFLECTION_BPS is 3000
    assert.throws(
      () => validateBuildRequest({ ...base, args: { ...GOOD_ARGS, reflectionBps: 3001 } }),
      /reflectionBps must be an integer 0-3000/,
    );
    assert.throws(
      () => validateBuildRequest({ ...base, args: { ...GOOD_ARGS, reflectionBps: -1 } }),
      /reflectionBps must be an integer 0-3000/,
    );
  });
});

test("a valid request normalizes to a bounded plan", () => {
  withFactory(() => {
    const plan = validateBuildRequest({
      chainId: 988,
      target: "stable.tokenFactory",
      args: { ...GOOD_ARGS, reflectionBps: 500 },
    });
    assert.equal(plan.chainId, 988);
    assert.equal(plan.method, "createLaunch");
    assert.equal(plan.args.reflectionBps, 500);
    // Economics come from the audited contract, not the caller.
    assert.equal(plan.fixed.creatorFeeBps, 7000);
    assert.equal(plan.fixed.graduationReserveBps, 2000);
  });
});

test("caller cannot override the fixed economics", () => {
  withFactory(() => {
    const plan = validateBuildRequest({
      chainId: 988,
      target: "stable.tokenFactory",
      args: { ...GOOD_ARGS, creatorFeeBps: 9999, graduationReserveBps: 1 },
    });
    // Injected economics are ignored entirely, not merged.
    assert.equal(plan.fixed.creatorFeeBps, 7000);
    assert.equal(plan.fixed.graduationReserveBps, 2000);
    assert.equal(plan.args.creatorFeeBps, undefined);
  });
});

// ---- proposals carry no authority ------------------------------------------

test("a build proposal is explicitly non-executable", () => {
  withFactory(() => {
    const p = buildProposal({ chainId: 988, target: "stable.tokenFactory", args: GOOD_ARGS });
    assert.equal(p.kind, "build.proposal");
    assert.equal(p.executable, false);
    // A proposal must never carry signing/broadcast material.
    for (const k of ["privateKey", "signature", "rawTx", "bearer", "token"]) {
      assert.equal(k in p, false, `proposal must not contain "${k}"`);
    }
  });
});

test("proposal renders the fixed economics in plain English", () => {
  withFactory(() => {
    const plan = validateBuildRequest({
      chainId: 988,
      target: "stable.tokenFactory",
      args: GOOD_ARGS,
    });
    const text = renderBuildProposal(plan);
    assert.match(text, /Test Token/);
    assert.match(text, /creator 70% \/ protocol 30%/);
    assert.match(text, /No arbitrary code is deployed/);
  });
});

// ---- execution gating ------------------------------------------------------

test("build execution requires BOTH the scope and the global arm flag", () => {
  const prev = process.env.ORACLE_DEPLOY_ENABLED;
  try {
    delete process.env.ORACLE_DEPLOY_ENABLED;
    // scope alone is not enough
    let g = buildExecutionAllowed([BUILD_EXECUTE_SCOPE]);
    assert.equal(g.hasScope, true);
    assert.equal(g.armed, false);
    assert.equal(g.allowed, false);

    process.env.ORACLE_DEPLOY_ENABLED = "1";
    // arm alone is not enough
    g = buildExecutionAllowed([BUILD_PREPARE_SCOPE]);
    assert.equal(g.hasScope, false);
    assert.equal(g.allowed, false);

    // both
    g = buildExecutionAllowed([BUILD_EXECUTE_SCOPE]);
    assert.equal(g.allowed, true);
  } finally {
    if (prev === undefined) delete process.env.ORACLE_DEPLOY_ENABLED;
    else process.env.ORACLE_DEPLOY_ENABLED = prev;
  }
});

test("arming trade execution does NOT arm building", () => {
  const prevExec = process.env.ORACLE_EXECUTE_ENABLED;
  const prevDeploy = process.env.ORACLE_DEPLOY_ENABLED;
  try {
    process.env.ORACLE_EXECUTE_ENABLED = "1";
    delete process.env.ORACLE_DEPLOY_ENABLED;
    const g = buildExecutionAllowed([BUILD_EXECUTE_SCOPE]);
    assert.equal(g.armed, false, "execute flag must not arm the build verb");
    assert.equal(g.allowed, false);
  } finally {
    if (prevExec === undefined) delete process.env.ORACLE_EXECUTE_ENABLED;
    else process.env.ORACLE_EXECUTE_ENABLED = prevExec;
    if (prevDeploy === undefined) delete process.env.ORACLE_DEPLOY_ENABLED;
    else process.env.ORACLE_DEPLOY_ENABLED = prevDeploy;
  }
});

// ---- scope wiring ----------------------------------------------------------

test("build scopes are registered and default is prepare-only", () => {
  assert.equal(ALLOWED_SCOPES.has("prepare:build"), true);
  assert.equal(ALLOWED_SCOPES.has("build:factory"), true);
  // Safe default may PROPOSE a build but never authorize one.
  assert.equal(DEFAULT_SCOPES.includes("prepare:build"), true);
  assert.equal(DEFAULT_SCOPES.includes("build:factory"), false);
  assert.equal(DEFAULT_SCOPES.includes("agent:execute"), false);
});

test("build scopes survive normalizeScopes", () => {
  const out = normalizeScopes(["prepare:build", "build:factory"]);
  assert.deepEqual(out, ["prepare:build", "build:factory"]);
  assert.throws(() => normalizeScopes(["deploy:anything"]), /Invalid scope/);
});

// ---- discovery -------------------------------------------------------------

test("listBuildTargets reports capability separately from availability", () => {
  const targets = listBuildTargets();
  const stable = targets.find((t) => t.target === "stable.tokenFactory");
  assert.ok(stable, "Stable token factory must be a known target");
  assert.equal(stable.chainId, 988);
  assert.equal(stable.method, "createLaunch");
  // Known, but not yet buildable — nothing is deployed to 988 mainnet.
  assert.equal(stable.available, false);
  assert.equal(stable.address, null);
});
