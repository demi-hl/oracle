import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_MODES,
  actionModeForVerb,
  assertActionRecord,
  createActionRecord,
  isActiveAlert,
  isActiveExecution,
  migrateLegacyWatchRecord,
} from "../src/action-semantics.mjs";

test("watch and ping vocabulary is always alert-only", () => {
  for (const verb of ["watch", "watch this", "ping", "ping me", "alert", "notify"]) {
    assert.equal(actionModeForVerb(verb), ACTION_MODES.ALERT_ONLY, verb);
    const record = createActionRecord({ verb, actionMode: "execute", active: false });
    assert.equal(record.active, true);
    assert.equal(record.actionMode, "alert_only");
    assert.equal(isActiveAlert(record), true);
    assert.equal(isActiveExecution(record), false);
  }
});

test("arm means one explicitly executable action and is never converted to a watch", () => {
  const record = createActionRecord({ verb: "arm", actionMode: "alert_only", active: false });
  assert.equal(record.active, true);
  assert.equal(record.actionMode, ACTION_MODES.EXECUTE);
  assert.equal(isActiveAlert(record), false);
  assert.equal(isActiveExecution(record), true);
});

test("unknown or ambiguous action vocabulary fails closed", () => {
  for (const verb of ["", "trade", "watch and arm", "ping then execute", null]) {
    assert.throws(() => actionModeForVerb(verb), /explicit action verb required|unsupported action verb/);
  }
});

test("current action records require explicit active and actionMode fields", () => {
  assert.throws(() => assertActionRecord({ status: "armed" }), /active must be boolean/);
  assert.throws(
    () => assertActionRecord({ active: true, status: "armed" }),
    /actionMode must be alert_only or execute/,
  );
  assert.doesNotThrow(() => assertActionRecord({ active: true, actionMode: "alert_only" }));
  assert.doesNotThrow(() => assertActionRecord({ active: false, actionMode: "execute" }));
});

test("legacy watch rows migrate to alert_only and never infer execution from status=armed", () => {
  for (const status of ["watching", "armed"]) {
    const migrated = migrateLegacyWatchRecord({ id: "cashcat", status });
    assert.equal(migrated.active, true);
    assert.equal(migrated.actionMode, ACTION_MODES.ALERT_ONLY);
    assert.equal(isActiveExecution(migrated), false);
  }
  const fired = migrateLegacyWatchRecord({ id: "cashcat", status: "fired" });
  assert.equal(fired.active, false);
  assert.equal(fired.actionMode, ACTION_MODES.ALERT_ONLY);
});

test("watch migration refuses to downgrade an explicit non-alert record", () => {
  for (const actionMode of ["execute", "unknown"]) {
    assert.throws(
      () => migrateLegacyWatchRecord({ active: true, actionMode }),
      /non-alert record cannot enter alert-only watch migration/,
    );
  }
});
