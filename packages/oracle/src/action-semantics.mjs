export const ACTION_MODES = Object.freeze({
  ALERT_ONLY: "alert_only",
  EXECUTE: "execute",
});

const ALERT_VERBS = new Set(["watch", "watch this", "ping", "ping me", "alert", "notify"]);
const ACTIVE_LEGACY_WATCH_STATUSES = new Set(["watching", "armed"]);

export function actionModeForVerb(verb) {
  if (typeof verb !== "string" || !verb.trim()) {
    throw new TypeError("explicit action verb required");
  }
  const normalized = verb.trim().toLowerCase().replace(/\s+/g, " ");
  if (ALERT_VERBS.has(normalized)) return ACTION_MODES.ALERT_ONLY;
  if (normalized === "arm") return ACTION_MODES.EXECUTE;
  throw new TypeError(`unsupported action verb: ${normalized}`);
}

export function createActionRecord(input = {}) {
  const { verb, ...fields } = input;
  return {
    ...fields,
    active: true,
    actionMode: actionModeForVerb(verb),
  };
}

export function assertActionRecord(record) {
  if (!record || typeof record !== "object" || typeof record.active !== "boolean") {
    throw new TypeError("active must be boolean");
  }
  if (!Object.values(ACTION_MODES).includes(record.actionMode)) {
    throw new TypeError("actionMode must be alert_only or execute");
  }
  return record;
}

export function isActiveAlert(record) {
  return record?.active === true && record?.actionMode === ACTION_MODES.ALERT_ONLY;
}

export function isActiveExecution(record) {
  return record?.active === true && record?.actionMode === ACTION_MODES.EXECUTE;
}

export function migrateLegacyWatchRecord(record = {}) {
  if (
    record.actionMode !== undefined &&
    record.actionMode !== ACTION_MODES.ALERT_ONLY
  ) {
    throw new TypeError("non-alert record cannot enter alert-only watch migration");
  }
  const active =
    typeof record.active === "boolean"
      ? record.active
      : ACTIVE_LEGACY_WATCH_STATUSES.has(String(record.status || "").toLowerCase());
  return {
    ...record,
    active,
    actionMode: ACTION_MODES.ALERT_ONLY,
  };
}
