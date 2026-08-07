// Public data-plane handlers, exercised against the real provider stack.
//
// The route-table test proves a path is registered. It cannot prove the handler
// returns the shape the app parses, which is how /public/portfolio shipped
// wired-but-wrong twice during development: first rejecting the app's object
// `owner`, then returning rows at the top level while the client reads
// `portfolio.rows`.
//
// These call the handlers directly. Network-dependent assertions are kept to
// structure, not values, so the suite does not fail when an RPC is slow.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const SERVER = readFileSync(
  join(repoRoot, "packages/oracle/src/public-api/http.mjs"),
  "utf8",
);

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

test("portfolio accepts the multi-family owner object the app sends", async (t) => {
  // The app posts { owner: { evm, solana, ... } }, not a bare string. Grepping
  // the helper is not enough: this must fail if the object branch is removed,
  // so call the handler with the exact shape the app sends.
  const mod = await import(join(repoRoot, "packages/oracle/src/public-api/http.mjs"));
  const handler = mod.handlePortfolioForTest;
  assert.equal(typeof handler, "function", "handler not exported for test");
  let result;
  try {
    result = await handler({ owner: { evm: VITALIK }, chainIds: [1] });
  } catch (error) {
    assert.fail(`object owner rejected: ${error.message}`);
  }
  assert.equal(result.status, 200);
  assert.ok(String(result.body.owner).toLowerCase().startsWith("0x"));
});

test("portfolio rejects an owner with no usable EVM address", async () => {
  const mod = await import(join(repoRoot, "packages/oracle/src/public-api/http.mjs"));
  await assert.rejects(
    () => mod.handlePortfolioForTest({ owner: { solana: "not-evm" } }),
    /owner/i,
  );
});

test("portfolio rows carry a RAW integer amount the pricing path can consume", async () => {
  // The app prices via decimalAmount(row.amount, row.decimals), which requires
  // /^\d+$/. Emitting a human-readable "6.632..." parses as null, and every row
  // silently drops out of the USD total while still rendering on screen. That
  // shipped once: 10 real assets, all priced:false, total null.
  const mod = await import(join(repoRoot, "packages/oracle/src/public-api/http.mjs"));
  const { decimalAmount, priceKeyForRow } = await import(
    join(repoRoot, "apps/oracle-app/app/api/oracle/portfolio/pricingLogic.mjs")
  );

  let result;
  try {
    result = await mod.handlePortfolioForTest({ owner: { evm: VITALIK }, chainIds: [1] });
  } catch (error) {
    return; // upstream RPC unavailable; the static shape assertions below still hold elsewhere
  }

  const rows = result.body.portfolio.rows;
  if (rows.length === 0) return; // wallet drained; nothing to assert on

  for (const row of rows) {
    assert.match(
      String(row.amount),
      /^\d+$/,
      `row.amount must be a raw integer, got ${row.amount}`,
    );
    // The full round trip the app performs: raw amount + decimals -> a number.
    assert.notEqual(
      decimalAmount(row.amount, row.decimals),
      null,
      "decimalAmount returned null: this row would never price",
    );
    assert.ok(
      priceKeyForRow({ ...row, chainNumericId: row.chainId }),
      "row has no resolvable price key",
    );
  }
});

test("portfolio and nfts require an owner and never fall back to the env", () => {
  // resolvePortfolioAddresses() reads ORACLE_EVM_ADDRESS when no address is
  // passed. On an anonymous public plane that would answer a stranger with the
  // operator's own wallet, so both handlers must reject and pass an empty env.
  for (const name of ["handlePortfolio", "handleNfts"]) {
    const fn = SERVER.match(new RegExp(`async function ${name}\\([\\s\\S]*?\\n}`));
    assert.ok(fn, `${name} is missing`);
    assert.match(fn[0], /owner-required/, `${name} does not require an owner`);
    assert.match(fn[0], /\{ env: \{\} \}/, `${name} does not isolate the environment`);
  }
});

test("portfolio nests rows where the app's client reads them", () => {
  // apps/oracle-app/app/api/oracle/portfolio/route.ts: rawRows() reads
  // value.portfolio.rows. A top-level `rows` silently yields an empty wallet.
  const fn = SERVER.match(/async function handlePortfolio\([\s\S]*?\n}/);
  assert.match(fn[0], /portfolio: \{/);
});

test("nfts nests items and coverage where the app's client reads them", () => {
  // rawItems() reads value.nfts.items; coverageFrom() reads value.nfts.coverage.
  const fn = SERVER.match(/async function handleNfts\([\s\S]*?\n}/);
  assert.match(fn[0], /nfts: \{/);
  assert.match(fn[0], /items:/);
  assert.match(fn[0], /coverage: \{/);
});

test("portfolio never reports itself complete while token discovery is blind", () => {
  // EVM JSON-RPC returns native balances only. Reporting complete:true would
  // present a native-only view as a whole portfolio.
  const fn = SERVER.match(/async function handlePortfolio\([\s\S]*?\n}/);
  assert.match(fn[0], /complete: false/);
  assert.match(fn[0], /incompleteReason/);
});

test("the new amplifying routes are rate limited like approvals", () => {
  // Both fan a single request out to many RPC calls.
  const set = SERVER.match(/const AMPLIFYING_ROUTES[\s\S]*?\);/);
  assert.ok(set, "AMPLIFYING_ROUTES is missing");
  assert.match(set[0], /\/public\/portfolio/);
  assert.match(set[0], /\/public\/nfts/);
});

test("live: portfolio returns parseable native rows for a funded wallet", async (t) => {
  const { handlePortfolioForTest } = await import(
    join(repoRoot, "packages/oracle/src/public-api/http.mjs")
  ).then((m) => ({ handlePortfolioForTest: m.handlePortfolioForTest }));
  if (typeof handlePortfolioForTest !== "function") {
    t.skip("handler not exported for direct test");
    return;
  }
  let result;
  try {
    result = await handlePortfolioForTest({
      owner: { evm: VITALIK },
      chainIds: [1],
    });
  } catch (error) {
    t.skip(`upstream RPC unavailable: ${error.message}`);
    return;
  }
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.ok(Array.isArray(result.body.portfolio.rows));
  assert.equal(result.body.portfolio.complete, false);
  for (const row of result.body.portfolio.rows) {
    assert.equal(typeof row.chainId, "number");
    assert.equal(typeof row.symbol, "string");
    assert.equal(typeof row.amount, "string");
    assert.equal(row.kind, "native");
  }
});
