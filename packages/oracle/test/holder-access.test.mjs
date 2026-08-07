// CLI holder enforcement.
//
// The gate is only worth shipping if it actually sits in front of commands. The
// mutation that matters here is "delete the check from the kernel", so these
// tests assert on the kernel's real routing path, not just the helper.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkAccess,
  configuredAddress,
  UNGATED_COMMANDS,
  DENIED_MESSAGE,
} from "../src/cli/holder-access.mjs";

const HOLDER = "0x1c0ec596303ce6666f5a4d24c29e78cf881cb5d3";
const NON_HOLDER = "0x0000000000000000000000000000000000000001";

const holds = async () => 1n;
const holdsNothing = async () => 0n;
const noop = () => {};

test("a non-holder is denied a gated command", async () => {
  const result = await checkAccess("scan", {
    operator: () => false,
    address: NON_HOLDER,
    balanceOf: holdsNothing,
    cache: null,
    persist: noop,
    env: {},
  });
  assert.equal(result.allow, false);
  assert.equal(result.reason, "denied");
  assert.match(result.message, /Locals Only/);
});

test("a holder is allowed", async () => {
  const result = await checkAccess("scan", {
    operator: () => false,
    address: HOLDER,
    balanceOf: holds,
    cache: null,
    persist: noop,
    env: {},
  });
  assert.equal(result.allow, true);
  assert.equal(result.reason, "holder");
});

test("chat is gated, so bare `oracle` cannot slip past the check", async () => {
  const result = await checkAccess("chat", {
    operator: () => false,
    address: NON_HOLDER,
    balanceOf: holdsNothing,
    cache: null,
    persist: noop,
    env: {},
  });
  assert.equal(result.allow, false);
});

test("commands needed to REACH holder status are never gated", () => {
  // Gating `init` would deadlock: the gate reads the wallet `init` creates.
  for (const noun of ["init", "gate", "help", "version", "doctor", "auth", "model"]) {
    assert.ok(UNGATED_COMMANDS.has(noun), `${noun} must stay ungated`);
  }
  // And the things worth protecting must NOT be on that list.
  for (const noun of ["chat", "scan", "route", "prepare", "data", "chain"]) {
    assert.equal(UNGATED_COMMANDS.has(noun), false, `${noun} must be gated`);
  }
});

test("no configured wallet asks the user to onboard rather than accusing them", async () => {
  const result = await checkAccess("scan", {
    operator: () => false,
    address: null,
    balanceOf: holds,
    cache: null,
    persist: noop,
    env: {},
  });
  assert.equal(result.allow, false);
  assert.equal(result.reason, "no-wallet");
  assert.match(result.message, /oracle init/);
});

test("an RPC failure does not lock a paying holder out", async () => {
  // Fail-open is deliberate: being unable to check is not proof of absence, and
  // a holder should not lose their tool because HyperEVM had a bad minute.
  const result = await checkAccess("scan", {
    operator: () => false,
    address: HOLDER,
    balanceOf: async () => { throw new Error("rpc down"); },
    cache: null,
    persist: noop,
    env: {},
  });
  assert.equal(result.allow, true);
  assert.equal(result.reason, "unverifiable");
  assert.match(result.warning, /could not verify/i);
});

test("a cached denial is not silently reused for a different wallet", async () => {
  // Importing a holding wallet after being denied must re-check immediately.
  let checked = false;
  const result = await checkAccess("scan", {
    operator: () => false,
    address: HOLDER,
    balanceOf: async () => { checked = true; return 1n; },
    cache: { address: NON_HOLDER, holder: false, checkedAt: Date.now() },
    persist: noop,
    env: {},
  });
  assert.equal(checked, true, "stale cache for another wallet was reused");
  assert.equal(result.allow, true);
});

test("the bypass is env-only and off by default", async () => {
  const denied = await checkAccess("scan", {
    operator: () => false,
    address: NON_HOLDER, balanceOf: holdsNothing, cache: null, persist: noop, env: {},
  });
  assert.equal(denied.allow, false);

  const bypassed = await checkAccess("scan", {
    operator: () => false,
    address: NON_HOLDER, balanceOf: holdsNothing, cache: null, persist: noop,
    env: { ORACLE_GATE_BYPASS: "1" },
  });
  assert.equal(bypassed.allow, true);
  assert.equal(bypassed.reason, "bypass");
});

test("the configured wallet is read from the local exec env", () => {
  const dir = mkdtempSync(join(tmpdir(), "oracle-gate-"));
  try {
    const envPath = join(dir, "exec.env");
    writeFileSync(envPath, `# comment\nORACLE_EVM_ADDRESS="${HOLDER}"\n`);
    assert.equal(configuredAddress(envPath), HOLDER);

    writeFileSync(envPath, "ORACLE_EVM_ADDRESS=not-an-address\n");
    assert.equal(configuredAddress(envPath), null);

    assert.equal(configuredAddress(join(dir, "missing.env")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the denial message names the contract and the way out", () => {
  assert.match(DENIED_MESSAGE, /0x62FCFAf7573AD8B41a0FBF347AfEb85e06599A75/);
  assert.match(DENIED_MESSAGE, /oracle gate status/);
});

test("the kernel actually enforces the gate on its routing path", async () => {
  // The helper being correct is worthless if the kernel never calls it. This
  // reads the real kernel source and pins the wiring.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const kernel = readFileSync(resolve(here, "../src/cli/kernel.mjs"), "utf8");

  assert.match(kernel, /import \{ checkAccess \}/, "kernel does not import the gate");
  const calls = kernel.match(/await checkAccess\(/g) || [];
  assert.ok(
    calls.length >= 3,
    `expected the gate on the noun path and both chat paths, found ${calls.length}`,
  );
});

test("the admin operator is not gated behind the user token", async () => {
  // Operator is never published, holds the keys, and does the signing. Making
  // the admin also hold a Locals Only NFT would lock the owner out of their own
  // executor wallet the moment that NFT moved.
  const result = await checkAccess("scan", {
    operator: () => ({ ok: true, version: "0.15.0" }),
    address: null,
    balanceOf: async () => {
      throw new Error("balanceOf must not be consulted for an operator");
    },
    cache: null,
    persist: () => {},
    env: {},
  });

  assert.equal(result.allow, true);
  assert.equal(result.reason, "operator");
});

test("a broken operator resolver falls through to the holder check", async () => {
  // A resolver that throws must not become an accidental denial for a real
  // holder, nor an accidental unlock for a non-holder.
  const result = await checkAccess("scan", {
    operator: () => {
      throw new Error("resolver blew up");
    },
    address: "0x1111111111111111111111111111111111111111",
    balanceOf: async () => 0n,
    cache: null,
    persist: () => {},
    env: {},
  });

  assert.equal(result.allow, false);
  assert.equal(result.reason, "denied");
});
