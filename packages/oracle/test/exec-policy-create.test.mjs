import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enforceTxPolicy } from "../src/exec-policy.mjs";
import { venuesFor } from "../src/venues.mjs";

const UNKNOWN = "0x000000000000000000000000000000000000dead";
const VENUE_1 = [...venuesFor(1)][0];

function reset() {
  delete process.env.MAD_ALLOW_CREATE;
  delete process.env.ORACLE_ALLOW_CREATE;
  delete process.env.MAD_DEST_ALLOWLIST;
  delete process.env.ORACLE_DEST_ALLOWLIST;
  delete process.env.ORACLE_POLICY_STATE;
  delete process.env.ORACLE_MAX_DAILY_VALUE_WEI;
  delete process.env.ORACLE_MAX_TX_VALUE_WEI;
  delete process.env.ORACLE_VALUE_CAPS_ENABLED;
  process.env.MAD_VALUE_CAPS_ENABLED = "1";
}
afterEach(reset);
reset();

test("baseline: unknown destination is still blocked", () => {
  assert.throws(
    () => enforceTxPolicy({ chainId: 1, to: UNKNOWN, value: "1000" }, "sign"),
    /not allowlisted/
  );
});

test("baseline: an allowlisted venue under the cap still passes", () => {
  assert.equal(
    enforceTxPolicy({ chainId: 1, to: VENUE_1, value: "10000000000000000" }, "sign"),
    true
  );
});

test("broadcast phase variants still hit the daily ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "oracle-policy-phase-"));
  process.env.ORACLE_POLICY_STATE = join(dir, "daily.json");
  process.env.ORACLE_MAX_DAILY_VALUE_WEI = "1";
  try {
    assert.throws(
      () => enforceTxPolicy({ chainId: 1, to: VENUE_1, value: "2" }, "Broadcast"),
      /daily native spend|daily.*cap/i
    );
    assert.throws(
      () => enforceTxPolicy({ chainId: 1, to: VENUE_1, value: "0" }, "settle"),
      /unknown phase/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract creation is blocked by default", () => {
  // This is the bypass: no `to` means there is no destination to check, so the
  // allowlist never applied. Deploy must be opt-in.
  for (const shape of [
    { chainId: 1, value: "0", data: "0x6080604052" },
    { chainId: 1, to: null, value: "0", data: "0x6080604052" },
    { chainId: 1, to: "", value: "0", data: "0x6080604052" },
    { chainId: 1, to: "   ", value: "0", data: "0x6080604052" },
  ]) {
    assert.throws(
      () => enforceTxPolicy(shape, "sign"),
      /contract creation .* is disabled/,
      `should block create shape ${JSON.stringify(shape)}`
    );
  }
});

test("creation stays blocked on every allowed chain", () => {
  for (const chainId of [1, 8453, 42161, 137, 10, 56, 43114, 999, 4663, 2741, 988]) {
    assert.throws(
      () => enforceTxPolicy({ chainId, value: "0", data: "0x6080" }, "sign"),
      /contract creation/,
      `chain ${chainId} must not allow bare CREATE`
    );
  }
});

test("creation is permitted when explicitly opted in", () => {
  process.env.MAD_ALLOW_CREATE = "1";
  assert.equal(enforceTxPolicy({ chainId: 1, value: "0", data: "0x6080" }, "sign"), true);
});

test("even when opted in, a deploy may not carry native value", () => {
  process.env.MAD_ALLOW_CREATE = "1";
  assert.throws(
    () => enforceTxPolicy({ chainId: 1, value: "10000000000000000", data: "0x6080" }, "sign"),
    /may not carry native value/
  );
});

test("gas caps still apply to an opted-in deploy", () => {
  process.env.MAD_ALLOW_CREATE = "1";
  assert.throws(
    () =>
      enforceTxPolicy(
        { chainId: 1, value: "0", data: "0x6080", gasLimit: "99000000" },
        "sign"
      ),
    /gasLimit .* exceeds cap/
  );
});

test("BUILD-verb factory deploys are unaffected (they have a `to`)", () => {
  // The BUILD verb deploys THROUGH a pinned factory, i.e. a normal call with a
  // destination — so tightening bare CREATE must not break it. Use a plain
  // value transfer to an allowlisted venue: a swap venue with calldata would
  // (correctly) demand a slippage guard, which is a different control.
  assert.equal(
    enforceTxPolicy({ chainId: 1, to: VENUE_1, value: "0" }, "sign"),
    true
  );
});
