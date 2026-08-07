// Capability posture: key-present = armed, user-initiated = runs,
// autonomous = opt-in. These tests pin the RULE, not the current flag names.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  capabilityStatus,
  assertCapability,
  autonomousTradingEnabled,
  posture,
} from "../src/capability-posture.mjs";

const WITH_BTC = { BTC_WIF_FILE: "/keys/btc.wif" };
const NO_KEYS = {};

test("a present key ARMS the capability — no second feature flag", () => {
  const s = capabilityStatus("btc:execute", { env: WITH_BTC, userInitiated: true });
  assert.equal(s.armed, true);
  assert.equal(s.allowed, true, "supplying the key IS the authorization");
});

test("no key means not armed, and the error names the missing credential", () => {
  const s = capabilityStatus("btc:execute", { env: NO_KEYS, userInitiated: true });
  assert.equal(s.armed, false);
  assert.equal(s.allowed, false);
  assert.match(s.reason, /BTC_WIF_FILE/);
});

test("armed is NOT the same as running: nothing executes unasked", () => {
  const s = capabilityStatus("btc:execute", { env: WITH_BTC, userInitiated: false });
  assert.equal(s.armed, true, "the key is there, so the capability is armed");
  assert.equal(s.allowed, false, "but nothing runs until the user asks");
  assert.match(s.reason, /until you ask/);
});

test("autonomous trading is OFF even with every key present", () => {
  const s = capabilityStatus("btc:execute", { env: WITH_BTC, autonomous: true });
  assert.equal(s.armed, true);
  assert.equal(s.allowed, false, "a key must never authorize unattended trading");
  assert.match(s.reason, /ORACLE_AUTONOMOUS_TRADING/);
});

test("autonomous trading runs only when explicitly enabled", () => {
  const env = { ...WITH_BTC, ORACLE_AUTONOMOUS_TRADING: "1" };
  assert.equal(autonomousTradingEnabled(env), true);
  assert.equal(capabilityStatus("btc:execute", { env, autonomous: true }).allowed, true);
});

test("only the exact string '1' enables autonomous trading", () => {
  for (const v of ["", "0", "true", "yes", "TRUE", " ", "01"]) {
    assert.equal(autonomousTradingEnabled({ ORACLE_AUTONOMOUS_TRADING: v }), false, `must not enable on ${JSON.stringify(v)}`);
  }
});

test("NFT buy needs no extra credential — the wallet is the credential", () => {
  const s = capabilityStatus("nft:buy", { env: NO_KEYS, userInitiated: true });
  assert.equal(s.allowed, true, "buying a named NFT must not require a feature flag");
});

test("assertCapability throws with the reason attached", () => {
  assert.throws(
    () => assertCapability("btc:execute", { env: NO_KEYS, userInitiated: true }),
    (err) => err.status?.armed === false && /BTC_WIF_FILE/.test(err.message)
  );
});

test("posture reports the model and the autonomous state honestly", () => {
  const off = posture(WITH_BTC);
  assert.equal(off.autonomousTrading, "off");
  assert.ok(off.armed.includes("btc:execute"));
  const on = posture({ ...WITH_BTC, ORACLE_AUTONOMOUS_TRADING: "1" });
  assert.equal(on.autonomousTrading, "ENABLED");
});
