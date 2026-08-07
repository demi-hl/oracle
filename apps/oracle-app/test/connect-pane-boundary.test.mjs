import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(join(ROOT, "components/oracle/ConnectPane.tsx"), "utf8");

test("Agent Connect defaults to the loopback public plane", () => {
  assert.match(SOURCE, /http:\/\/127\.0\.0\.1:8799/);
  assert.doesNotMatch(SOURCE, /api\.oracle-agent\.dev/);
});

test("Agent Connect does not advertise private operator onboarding", () => {
  assert.doesNotMatch(SOURCE, /local operator install/i);
  assert.doesNotMatch(SOURCE, /execution\", \"local operator/i);
  assert.match(SOURCE, /Copy optional profile init/);
  assert.match(SOURCE, /User authorizes/);
  assert.match(SOURCE, /their wallet reviews the exact action/);
});
