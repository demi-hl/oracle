// Oracle Console — static asset tests (Slice I).
//
// Proves: the three public frontend files exist, the Oracle palette hex values
// are present, no emoji or em/en dash characters appear anywhere in copy,
// app.js references the two BFF routes and window.ethereum, and no file
// carries a hardcoded raw 32-byte hex secret shape or a Bearer token string.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const INDEX_PATH = path.join(ROOT, "public/oracle-console/index.html");
const APP_PATH = path.join(ROOT, "public/oracle-console/app.js");
const STYLES_PATH = path.join(ROOT, "public/oracle-console/styles.css");

const PALETTE = Object.freeze({
  obsidian: "#0A0E0D",
  mint: "#50D2C1",
  offWhite: "#F2F5F3",
  coolGrey: "#b0d4d5",
});

// Em dash and en dash. No hyphen-minus (U+002D) here, that is allowed.
const DASH_RE = /[\u2013\u2014]/;

// Broad emoji / pictographic ranges plus the variation selector and regional
// indicators, matching how these characters actually show up in copy.
const EMOJI_RE =
  /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\uFE0F]/u;

const RAW_HEX_SECRET_RE = /0x[0-9a-fA-F]{64}/;
const BEARER_TOKEN_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/;

function readText(p) {
  return readFileSync(p, "utf8");
}

test("required public frontend files exist", () => {
  assert.equal(existsSync(INDEX_PATH), true, "index.html must exist");
  assert.equal(existsSync(APP_PATH), true, "app.js must exist");
  assert.equal(existsSync(STYLES_PATH), true, "styles.css must exist");
});

test("palette hex values are present and no other brand colors are introduced", () => {
  const css = readText(STYLES_PATH);
  for (const hex of Object.values(PALETTE)) {
    assert.ok(css.includes(hex), `styles.css must reference ${hex}`);
  }
});

test("no emoji characters in any public copy file", () => {
  for (const p of [INDEX_PATH, APP_PATH, STYLES_PATH]) {
    const text = readText(p);
    assert.equal(EMOJI_RE.test(text), false, `${p} must not contain emoji`);
  }
});

test("no em dash or en dash characters in any public copy file", () => {
  for (const p of [INDEX_PATH, APP_PATH, STYLES_PATH]) {
    const text = readText(p);
    assert.equal(DASH_RE.test(text), false, `${p} must not contain an em dash or en dash`);
  }
});

test("app.js references the connect assemble BFF route and window.ethereum", () => {
  const js = readText(APP_PATH);
  assert.ok(js.includes("/public/connect/assemble"), "app.js must reference POST /public/connect/assemble");
  assert.ok(js.includes("window.ethereum"), "app.js must feature-detect window.ethereum");
});

test("app.js references the grants active BFF route", () => {
  const js = readText(APP_PATH);
  assert.ok(js.includes("/public/grants/active"), "app.js must reference POST /public/grants/active");
});

test("no hardcoded raw 32-byte hex secret or Bearer token string in any public file", () => {
  for (const p of [INDEX_PATH, APP_PATH, STYLES_PATH]) {
    const text = readText(p);
    assert.equal(RAW_HEX_SECRET_RE.test(text), false, `${p} must not contain a 0x + 64 hex secret shape`);
    assert.equal(BEARER_TOKEN_RE.test(text), false, `${p} must not contain a Bearer token string`);
  }
});

test("index.html contains honest preview copy and structural elements", () => {
  const html = readText(INDEX_PATH);
  assert.ok(/Preview agent permissions/.test(html), "must have a permission preview CTA");
  assert.ok(/Connect/.test(html) && /Review/.test(html) && /Preview/.test(html), "must show Connect, Review, Preview sequence");
  assert.ok(/Clear preview/.test(html), "must have a Clear preview affordance");
  assert.equal(/\bEnforced\b|\bRevoke\b/.test(html), false, "must not claim local preview state is enforced or revoked");
  assert.ok(/does not authorize an agent/i.test(html), "must say the preview is not authorization");
  assert.ok(/chain/i.test(html), "permission panel must render chain");
  assert.ok(/actions/i.test(html), "permission panel must render actions");
  assert.ok(/targets/i.test(html), "permission panel must render targets");
  assert.ok(/max value/i.test(html), "permission panel must render max value");
  assert.ok(/expiry/i.test(html), "permission panel must render expiry");
  assert.ok(/styles\.css/.test(html), "must link styles.css");
  assert.ok(/app\.js/.test(html), "must load app.js");
});

test("preview does not request a wallet signature", () => {
  const js = readText(APP_PATH);
  assert.equal(js.includes("personal_sign"), false);
  assert.equal(js.includes("Agent connected and enforced"), false);
});

test("app.js does not import any private executor stack module", () => {
  const js = readText(APP_PATH);
  const forbidden = [
    "exec-server",
    "local-signer-server",
    "get-signer",
    "keystore",
    "exec-policy",
    "local-signer/",
    "adapters/",
    "mint-capability",
  ];
  for (const token of forbidden) {
    assert.equal(js.includes(token), false, `app.js must not reference ${token}`);
  }
});
