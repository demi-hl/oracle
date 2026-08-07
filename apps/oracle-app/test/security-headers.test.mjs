// Permissions-Policy regression.
//
// The public app uses no camera, microphone, or geolocation, so all three are
// denied outright and the browser refuses at the platform level instead of
// falling back to a permission prompt that injected script could trigger.
//
// `microphone=()` was briefly relaxed to `(self)` to allow on-device dictation.
// The feature was dropped rather than ship the weaker header on a public
// surface, so any reintroduction of `(self)` or `*` fails here and forces that
// tradeoff to be argued again rather than slipping in with a feature.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");

function policyValue() {
  const match = config.match(/"camera=\(\)[^"]*"/);
  assert.ok(match, "Permissions-Policy header value not found in next.config.ts");
  return match[0].slice(1, -1);
}

test("camera, microphone, and geolocation are all fully denied", () => {
  const value = policyValue();
  assert.match(value, /camera=\(\)/);
  assert.match(value, /microphone=\(\)/);
  assert.match(value, /geolocation=\(\)/);
});

test("the microphone is not reopened to this origin or to embedded frames", () => {
  const value = policyValue();
  assert.doesNotMatch(value, /microphone=\(self\)/);
  assert.doesNotMatch(value, /microphone=\*/);
});

test("no dictation surface remains in the app", async () => {
  // The header is only half the guarantee: a reintroduced capture path would
  // make the denial the single point of failure.
  const { readdirSync } = await import("node:fs");
  const components = readdirSync(new URL("../components/oracle/", import.meta.url));
  assert.ok(
    !components.some((f) => /dictation/i.test(f)),
    "a dictation module is present while the microphone is denied",
  );
});
