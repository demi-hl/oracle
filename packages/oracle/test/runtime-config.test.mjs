// Tests for src/public-control/runtime-config.mjs (Slice K).
//
// Pure config-parsing tests: no live network, no private-stack imports.
// Every case passes a plain object as the "env" so process.env is never
// mutated by this suite.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadPublicConfig,
  resolveChain,
  redactedConfig,
  RuntimeConfigError,
  DEFAULT_CHAIN_ID,
  DEFAULT_PUBLIC_HOST,
  DEFAULT_PUBLIC_PORT,
} from "../src/public-control/runtime-config.mjs";

import { ENTRYPOINT_V07 } from "../src/public-control/aa-adapter.mjs";

// ---------------------------------------------------------------------------
// env parsing
// ---------------------------------------------------------------------------

test("loadPublicConfig seeds Base 8453 + Arbitrum 42161 by default", () => {
  const config = loadPublicConfig({});
  assert.deepEqual(Object.keys(config.chains).sort(), ["42161", "8453"]);
  assert.equal(config.chains["8453"].name, "Base");
  assert.equal(config.chains["42161"].name, "Arbitrum");
  assert.equal(config.defaultChainId, DEFAULT_CHAIN_ID);
  assert.equal(config.publicHost, DEFAULT_PUBLIC_HOST);
  assert.equal(config.publicPort, DEFAULT_PUBLIC_PORT);
});

test("loadPublicConfig reads bundlerUrl/paymasterUrl per chain from env", () => {
  const config = loadPublicConfig({
    ORACLE_BUNDLER_URL_8453: "https://bundler.example/base",
    ORACLE_PAYMASTER_URL_8453: "https://paymaster.example/base",
    ORACLE_BUNDLER_URL_42161: "https://bundler.example/arb",
  });
  assert.equal(config.chains["8453"].bundlerUrl, "https://bundler.example/base");
  assert.equal(config.chains["8453"].paymasterUrl, "https://paymaster.example/base");
  assert.equal(config.chains["42161"].bundlerUrl, "https://bundler.example/arb");
  assert.equal(config.chains["42161"].paymasterUrl, undefined);
});

test("loadPublicConfig omits bundlerUrl/paymasterUrl when env unset or blank", () => {
  const config = loadPublicConfig({ ORACLE_BUNDLER_URL_8453: "   " });
  assert.equal("bundlerUrl" in config.chains["8453"], false);
  assert.equal("paymasterUrl" in config.chains["8453"], false);
});

test("loadPublicConfig reads loopback publicHost/publicPort from ORACLE_PUBLIC_* env", () => {
  const config = loadPublicConfig({
    ORACLE_PUBLIC_HOST: "127.0.0.1",
    ORACLE_PUBLIC_PORT: "9100",
  });
  assert.equal(config.publicHost, "127.0.0.1");
  assert.equal(config.publicPort, 9100);
});

test("loadPublicConfig falls back to legacy MAD_PUBLIC_* env when ORACLE_* unset", () => {
  const config = loadPublicConfig({
    MAD_PUBLIC_HOST: "localhost",
    MAD_PUBLIC_PORT: "9200",
  });
  assert.equal(config.publicHost, "localhost");
  assert.equal(config.publicPort, 9200);
});

test("loadPublicConfig refuses non-loopback public hosts", () => {
  assert.throws(() => loadPublicConfig({ ORACLE_PUBLIC_HOST: "0.0.0.0" }), RuntimeConfigError);
  assert.throws(() => loadPublicConfig({ MAD_PUBLIC_HOST: "192.168.1.5" }), RuntimeConfigError);
});

test("loadPublicConfig rejects a non-integer ORACLE_PUBLIC_PORT", () => {
  assert.throws(() => loadPublicConfig({ ORACLE_PUBLIC_PORT: "not-a-port" }), RuntimeConfigError);
});

test("loadPublicConfig honors ORACLE_DEFAULT_CHAIN_ID when it is a registered chain", () => {
  const config = loadPublicConfig({ ORACLE_DEFAULT_CHAIN_ID: "42161" });
  assert.equal(config.defaultChainId, 42161);
});

test("loadPublicConfig rejects ORACLE_DEFAULT_CHAIN_ID pointing at an unregistered chain", () => {
  assert.throws(
    () => loadPublicConfig({ ORACLE_DEFAULT_CHAIN_ID: "999" }),
    /not a registered chain/
  );
});

test("loadPublicConfig rejects a non-object env", () => {
  assert.throws(() => loadPublicConfig(null), RuntimeConfigError);
  assert.throws(() => loadPublicConfig("nope"), RuntimeConfigError);
});

// ---------------------------------------------------------------------------
// resolveChain: fail closed on unknown chain
// ---------------------------------------------------------------------------

test("resolveChain returns the registered entry for a known chainId", () => {
  const config = loadPublicConfig({});
  const base = resolveChain(config, 8453);
  assert.equal(base.name, "Base");
  assert.equal(base.entryPoint, ENTRYPOINT_V07);
});

test("resolveChain accepts a string chainId equivalently to a number", () => {
  const config = loadPublicConfig({});
  assert.deepEqual(resolveChain(config, "8453"), resolveChain(config, 8453));
});

test("resolveChain fails closed on an unknown chainId (never falls back)", () => {
  const config = loadPublicConfig({});
  assert.throws(() => resolveChain(config, 1), /unsupported chainId/);
  assert.throws(() => resolveChain(config, 999999), /unsupported chainId/);
});

// ---------------------------------------------------------------------------
// entryPoint == aa-adapter ENTRYPOINT_V07
// ---------------------------------------------------------------------------

test("every supported chain's entryPoint equals aa-adapter ENTRYPOINT_V07", () => {
  const config = loadPublicConfig({});
  for (const entry of Object.values(config.chains)) {
    assert.equal(entry.entryPoint, ENTRYPOINT_V07);
  }
});

// ---------------------------------------------------------------------------
// secret-shaped bundler/paymaster URL rejection
// ---------------------------------------------------------------------------

test("a bearer/key-shaped bundlerUrl is rejected (query-string api key)", () => {
  assert.throws(
    () => loadPublicConfig({ ORACLE_BUNDLER_URL_8453: "https://bundler.example/rpc?api_key=super-secret-123" }),
    RuntimeConfigError
  );
});

test("a bearer/key-shaped bundlerUrl is rejected (bearer token text)", () => {
  assert.throws(
    () => loadPublicConfig({ ORACLE_BUNDLER_URL_8453: "https://bundler.example/rpc?auth=Bearer abcdef123456" }),
    RuntimeConfigError
  );
});

test("a raw 32-byte-hex-shaped value in a paymasterUrl is rejected", () => {
  const fakeKey = "0x" + "ab".repeat(32);
  assert.throws(
    () => loadPublicConfig({ ORACLE_PAYMASTER_URL_8453: `https://paymaster.example/${fakeKey}` }),
    RuntimeConfigError
  );
});

test("a URL with embedded userinfo credentials is rejected", () => {
  assert.throws(
    () => loadPublicConfig({ ORACLE_BUNDLER_URL_8453: "https://user:hunter2@bundler.example/rpc" }),
    RuntimeConfigError
  );
});

test("a non-http(s) bundlerUrl scheme is rejected", () => {
  assert.throws(
    () => loadPublicConfig({ ORACLE_BUNDLER_URL_8453: "ftp://bundler.example/rpc" }),
    RuntimeConfigError
  );
});

test("a plain public bundlerUrl with no secret shape loads fine", () => {
  const config = loadPublicConfig({
    ORACLE_BUNDLER_URL_8453: "https://bundler.example/rpc?chain=base",
  });
  assert.equal(config.chains["8453"].bundlerUrl, "https://bundler.example/rpc?chain=base");
});

// ---------------------------------------------------------------------------
// redactedConfig: safe-to-log view, secret-free
// ---------------------------------------------------------------------------

test("redactedConfig strips query string and userinfo from bundler/paymaster URLs", () => {
  const config = loadPublicConfig({
    ORACLE_BUNDLER_URL_8453: "https://bundler.example/rpc?chain=base&id=42",
    ORACLE_PAYMASTER_URL_8453: "https://paymaster.example/rpc?tier=gold",
  });
  const redacted = redactedConfig(config);
  assert.equal(redacted.chains["8453"].bundlerUrl, "https://bundler.example/rpc");
  assert.equal(redacted.chains["8453"].paymasterUrl, "https://paymaster.example/rpc");
});

test("redactedConfig preserves non-secret fields (name, entryPoint, host, port, defaultChainId)", () => {
  const config = loadPublicConfig({ ORACLE_PUBLIC_HOST: "localhost", ORACLE_PUBLIC_PORT: "8888" });
  const redacted = redactedConfig(config);
  assert.equal(redacted.chains["8453"].name, "Base");
  assert.equal(redacted.chains["8453"].entryPoint, ENTRYPOINT_V07);
  assert.equal(redacted.publicHost, "localhost");
  assert.equal(redacted.publicPort, 8888);
  assert.equal(redacted.defaultChainId, DEFAULT_CHAIN_ID);
});

test("redactedConfig output has no secret-shaped values anywhere", () => {
  const config = loadPublicConfig({
    ORACLE_BUNDLER_URL_8453: "https://bundler.example/rpc?chain=base",
    ORACLE_PAYMASTER_URL_42161: "https://paymaster.example/arb",
  });
  const redacted = redactedConfig(config);
  const serialized = JSON.stringify(redacted);
  assert.doesNotMatch(serialized, /bearer/i);
  assert.doesNotMatch(serialized, /secret/i);
  assert.doesNotMatch(serialized, /api[_-]?key/i);
  assert.doesNotMatch(serialized, /0x[0-9a-fA-F]{64}/);
  assert.doesNotMatch(serialized, /:\/\/[^/]+:[^/]+@/); // no userinfo
  assert.doesNotMatch(serialized, /\?/); // no query strings survive
});

test("redactedConfig rejects a non-config input", () => {
  assert.throws(() => redactedConfig(null), RuntimeConfigError);
  assert.throws(() => redactedConfig({}), RuntimeConfigError);
});
