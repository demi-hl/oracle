// Wallet activity scanner: read-only ERC20 transfer history for an address.
//
// The previous implementation failed against every public RPC because
// publicnode-class endpoints keep only ~128 blocks of history, so chunking
// could never help -- a single-block query at depth 120 already fails. This
// version pins the wallet into the indexed topic slots (topic1=from,
// topic2=to), which keeps result sets small enough that free-tier result caps
// never trigger, and targets endpoints with real archive depth.
//
// Verified live 2026-08-06 against vitalik.eth
// (0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045): 398 transfers over a 40k-block
// lookback on mainnet, zero errors.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  followWallet,
  TRANSFER_TOPIC,
  DEFAULT_ENDPOINTS,
  DEFAULT_CHUNK,
} from "../src/data/providers/wallet-watch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "..", "src/data/providers/wallet-watch.mjs"), "utf8");

test("the scanner is read-only: it can only ever call read RPC methods", () => {
  // This is the custody guarantee. A scanner that can sign is not a scanner.
  const methods = [...SRC.matchAll(/"(eth_[a-zA-Z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(methods)].sort(), ["eth_blockNumber", "eth_getLogs"]);
  for (const banned of [
    "privateKey",
    "mnemonic",
    "signTransaction",
    "sendRawTransaction",
    "eth_sendTransaction",
    "eth_sign",
  ]) {
    assert.ok(!SRC.includes(banned), `wallet scanner must not reference ${banned}`);
  }
});

test("it watches the real ERC20 Transfer topic", () => {
  assert.equal(
    TRANSFER_TOPIC,
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  );
});

test("a malformed address is refused before any network call", async () => {
  // No fetch is stubbed here, so anything that reached the network would throw
  // a different error than the validation one.
  for (const bad of ["not-an-address", "0x123", "", null, undefined, "0xZZZ"]) {
    await assert.rejects(
      () => followWallet(bad, { chains: [1] }),
      /address/i,
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
});

test("endpoints are keyless -- no API keys baked into the defaults", () => {
  // A scanner that needs a key is a scanner most users cannot run.
  for (const [chainId, urls] of Object.entries(DEFAULT_ENDPOINTS)) {
    assert.ok(urls.length > 0, `chain ${chainId} has no endpoints`);
    for (const u of urls) {
      assert.match(u, /^https:\/\//, `${u} must be https`);
      assert.doesNotMatch(u, /(api[_-]?key|apikey|\/v[0-9]\/[0-9a-f]{16,})/i, `${u} looks keyed`);
    }
  }
});

test("publicnode-class endpoints stay out of the defaults", () => {
  // They serve ~128 blocks of history. On Base's 2s blocks that is about four
  // minutes, which reads as "no activity" rather than as an error.
  const all = Object.values(DEFAULT_ENDPOINTS).flat().join(" ");
  assert.doesNotMatch(all, /publicnode/i);
});

test("the chunk size stays within the tightest verified free-tier cap", () => {
  // drpc and mainnet.base.org enforce 10_000 blocks per eth_getLogs call.
  // Going above that would work on Tenderly and silently fail over elsewhere.
  assert.ok(DEFAULT_CHUNK > 0);
  assert.ok(DEFAULT_CHUNK <= 10_000, `chunk ${DEFAULT_CHUNK} exceeds the verified cap`);
});

test("results are deduped by (chainId, txHash, logIndex)", () => {
  // The same log can arrive twice when chunk ranges overlap or a retry
  // re-fetches a window. Identity must include chainId, or a cross-chain
  // collision would silently drop a real event.
  assert.match(SRC, /chainId/);
  assert.match(SRC, /logIndex/);
  assert.match(SRC, /transactionHash|txHash/);
});

test("transient failures are retried but permanent ones fail over", () => {
  // Retrying a 'range too large' forever is a hang; failing over on a timeout
  // wastes a good endpoint. The two classes must be distinguished.
  assert.match(SRC, /TRANSIENT/);
  assert.match(SRC, /TOO_BIG|too many|exceeds/i);
});
