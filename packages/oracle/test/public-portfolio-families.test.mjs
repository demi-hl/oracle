// The public portfolio handler must carry Solana and Bitcoin through to the
// provider. It previously hardcoded { evm: owner }, so a SOL/BTC wallet could
// never return a balance regardless of what the caller sent — the provider had
// supported both families the whole time.
//
// Verified live 2026-08-05 against the running plane:
//   evm: 11 chains ok · solana: 1 ok · bitcoin: 1 ok
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "..", "src/public-api/http.mjs"), "utf8");

test("portfolio forwards solana and bitcoin to the provider", () => {
  assert.match(SRC, /addresses: \{ evm: owner, solana, bitcoin \}/);
  assert.ok(
    !/addresses: \{ evm: owner \},[\s\S]{0,400}handlePortfolio/.test(SRC),
    "portfolio must not hardcode an EVM-only address set",
  );
});

test("non-EVM chains survive the response filter", () => {
  // The old `chain.family !== "evm"` filter dropped SOL/BTC after the provider
  // had already resolved them, which looked identical to "no balance".
  assert.match(SRC, /\["evm", "solana", "bitcoin"\]\.includes\(chain\.family\)/);
});

test("rows and chains carry the family discriminator", () => {
  // Without it the app cannot tell a Solana row from an EVM row: both have a
  // chainId and a symbol.
  const rowsBlock = SRC.slice(SRC.indexOf("rows.push({"));
  assert.match(rowsBlock, /family: chain\.family/);
  const chainsBlock = SRC.slice(SRC.indexOf("chains.push({"));
  assert.match(chainsBlock, /family: chain\.family/);
});

test("a malformed side-address does not deny the EVM read", () => {
  // Returning null (rather than throwing) is deliberate: a typo'd BTC address
  // must not cost the caller their EVM balances.
  assert.match(SRC, /function optionalSolanaAddress\(value\) \{[\s\S]{0,220}return PUBLIC_SOL_RE\.test\(v\) \? v : null;/);
  assert.match(SRC, /function optionalBitcoinAddress\(value\) \{[\s\S]{0,220}return PUBLIC_BTC_RE\.test\(v\) \? v : null;/);
});

test("a request with no usable address is still refused", () => {
  // Accepting sol/btc must not turn the handler into one that scans nothing.
  assert.match(SRC, /if \(!owner && !solana && !bitcoin\) \{/);
});
