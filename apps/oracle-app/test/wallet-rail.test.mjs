// The wallet rail is the app's onboarding surface, so its custody posture and
// its entry-first design are both load-bearing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const RAIL = readFileSync(join(APP, "components/shell/WalletRail.tsx"), "utf8");
const SHELL = readFileSync(join(APP, "components/shell/AppShell.tsx"), "utf8");
const RESOLVE_ROUTE = readFileSync(join(APP, "app/api/oracle/resolve/route.ts"), "utf8");

test("connect asks only for a public address", () => {
  // eth_requestAccounts returns addresses; the key stays in the extension.
  assert.match(RAIL, /eth_requestAccounts/);
  for (const banned of ["eth_sign", "personal_sign", "eth_sendTransaction", "privateKey", "mnemonic"]) {
    assert.ok(!RAIL.includes(banned), `the rail must not reference ${banned}`);
  }
});

test("the book is entry-first, not connect-gated", () => {
  // A cold wallet cannot be connected and BTC/SOL wallets do not speak the EVM
  // connector protocol, so typed entry is the only way the book can hold the
  // wallets a user actually operates. If ADD ever disappears, the rail can no
  // longer represent a cold or non-EVM wallet at all.
  assert.match(RAIL, /"ADD"/);
  assert.match(RAIL, /id="wallet-add"/);
  assert.match(RAIL, /familyOf/);
  assert.match(RAIL, /bitcoin/);
  assert.match(RAIL, /solana/);
});

test("all three address families are recognized", () => {
  assert.match(RAIL, /const EVM_RE = /);
  assert.match(RAIL, /const SOL_RE = /);
  assert.match(RAIL, /const BTC_RE = /);
});

test("the active EVM wallet is mirrored to the key existing panes read", () => {
  // Portfolio, Approvals, NFTs and Swap all read oracle-portfolio-evm. If the
  // book stops mirroring, adding a wallet silently does nothing to those panes.
  assert.match(RAIL, /LEGACY_EVM_KEY = "oracle-portfolio-evm"/);
  assert.match(RAIL, /setItem\(LEGACY_EVM_KEY, activeEvm\.address\)/);
});

test("the rail docks in the layout instead of covering content", () => {
  // As a flex sibling of <main> it takes width; as an overlay it would hide
  // whichever pane the user is reading.
  assert.match(SHELL, /<WalletRail \/>/);
  assert.match(SHELL, /min-w-0 flex-1 overflow-y-auto/);
});

test("the collapsed state is remembered", () => {
  assert.match(RAIL, /COLLAPSE_KEY/);
  assert.match(RAIL, /aria-label="Open wallets"/);
});

test("resolution failure is reported, not silently swallowed", () => {
  // "No such name" and "lookup broke" must not look identical to the caller.
  assert.match(RESOLVE_ROUTE, /status: 503/);
  assert.match(RESOLVE_ROUTE, /address: null, name: q, source: null/);
});

test("the resolve route cannot sign", () => {
  for (const banned of ["eth_sendTransaction", "personal_sign", "privateKey", "signer"]) {
    assert.ok(!RESOLVE_ROUTE.includes(banned), `resolve route must not reference ${banned}`);
  }
});
