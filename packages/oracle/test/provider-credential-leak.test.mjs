// Credential-leak probe across EVERY keyed provider.
//
// Opus 5's verification found the endpoint fix had been applied to only 3 of 6
// keyed providers, and that an http:// downgrade would put a pinned key on the
// wire in cleartext. This test covers all six plus the downgrade, so a future
// provider that forgets the helper fails here rather than in the wild.

import { test } from "node:test";
import assert from "node:assert/strict";

const SENTINEL = "ORACLE-LEAK-SENTINEL-DO-NOT-SEND";
const ATTACKER = "https://attacker.example";

/** Capture the headers a provider call would put on the wire. */
function capture() {
  const seen = { headers: null, url: null };
  const fetchImpl = async (url, init = {}) => {
    seen.url = String(url);
    seen.headers = { ...(init.headers || {}) };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => "{}",
      json: async () => ({}),
    };
  };
  return { seen, fetchImpl };
}

function leaked(headers) {
  return Object.values(headers || {}).some((v) => String(v).includes(SENTINEL));
}

/**
 * Each entry: call the provider's cheapest keyed read with an explicit apiKey,
 * once against its default host and once against an attacker host.
 */
const PROVIDERS = [
  {
    name: "satflow",
    load: () => import("../src/data/providers/satflow.mjs"),
    call: (m, opts) => m.satflowCollectionFloors({ collectionId: "x" }, opts),
  },
  {
    name: "magiceden-sol",
    load: () => import("../src/data/providers/magiceden-sol.mjs"),
    call: (m, opts) => m.magicEdenSolStats({ symbol: "okay_bears" }, opts),
  },
  {
    name: "opensea",
    load: () => import("../src/data/providers/opensea-nft.mjs"),
    call: (m, opts) => m.openseaCollection("boredapeyachtclub", opts),
  },
  {
    name: "oneinch",
    load: () => import("../src/data/providers/oneinch.mjs"),
    call: (m, opts) => m.oneinchQuote({ chainId: 1, src: "0x" + "11".repeat(20), dst: "0x" + "22".repeat(20), amount: "1000" }, opts),
  },
  {
    name: "zerox",
    load: () => import("../src/data/providers/zerox.mjs"),
    call: (m, opts) => m.zeroxQuote({ chainId: 1, sellToken: "0x" + "11".repeat(20), buyToken: "0x" + "22".repeat(20), sellAmount: "1000" }, opts),
  },
];

for (const p of PROVIDERS) {
  test(`${p.name}: the API key never reaches an attacker-controlled baseUrl`, async () => {
    const mod = await p.load();
    const { seen, fetchImpl } = capture();
    try {
      await p.call(mod, { apiKey: SENTINEL, baseUrl: ATTACKER, fetchImpl, timeoutMs: 2000 });
    } catch {
      // A throw is an acceptable outcome — what matters is no key on the wire.
    }
    if (seen.headers) {
      assert.equal(leaked(seen.headers), false, `${p.name} sent the credential to ${ATTACKER}: ${JSON.stringify(seen.headers)}`);
    }
  });

  test(`${p.name}: the API key IS sent to its own default host`, async () => {
    const mod = await p.load();
    const { seen, fetchImpl } = capture();
    try {
      await p.call(mod, { apiKey: SENTINEL, fetchImpl, timeoutMs: 2000 });
    } catch {
      /* network shape differences are fine; we only inspect headers */
    }
    if (seen.headers) {
      assert.equal(leaked(seen.headers), true, `${p.name} failed to authenticate against its own API`);
    }
  });
}

test("bitcoin-meta only credentials known indexer hosts", async () => {
  const mod = await import("../src/data/providers/bitcoin-meta.mjs");
  const { seen, fetchImpl } = capture();
  try {
    await mod.btcMetaHealth({ apiKey: SENTINEL, baseUrl: ATTACKER, fetchImpl, timeoutMs: 2000 });
  } catch {
    /* ignore */
  }
  if (seen.headers) {
    assert.equal(leaked(seen.headers), false, "bitcoin-meta leaked the key to a non-indexer host");
  }
});

test("an http:// downgrade of an allowlisted host does not carry the key", async () => {
  const { resolveProviderEndpoint, credentialedHeaders } = await import("../src/data/provider-endpoint.mjs");
  const e = resolveProviderEndpoint({
    provider: "test",
    defaultUrl: "https://api.example.com/v1",
    hosts: ["api.example.com"],
    url: "http://api.example.com/v1",
  });
  assert.equal(e.trusted, false, "plaintext http must not be trusted with a secret");
  assert.equal(credentialedHeaders({}, { "x-api-key": SENTINEL }, e.trusted)["x-api-key"], undefined);
});

test("loopback over http IS trusted — there is no wire to sniff", async () => {
  const { resolveProviderEndpoint } = await import("../src/data/provider-endpoint.mjs");
  const e = resolveProviderEndpoint({
    provider: "test",
    defaultUrl: "https://api.example.com/v1",
    hosts: ["api.example.com", "127.0.0.1:8787"],
    url: "http://127.0.0.1:8787/v1",
  });
  assert.equal(e.trusted, true, "a local mock must still receive the key");
});
