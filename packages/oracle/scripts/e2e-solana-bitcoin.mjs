// Oracle end-to-end LIVE lane probe: Solana + Bitcoin.
// Read/quote/prepare/simulate only. No signing. No broadcast. No keys required.
//
// Run: node scripts/e2e-solana-bitcoin.mjs
// Exit 0 = every mandatory lane answered live. Optional keyed lanes are reported, not failed.

import { data as desk } from "../src/data/desk-data.mjs";
import { jupiterQuote, jupiterPrepareSwap, SOL_MINT, USDC_MINT } from "../src/data/providers/jupiter.mjs";
import { solanaSimulateTransaction } from "../src/data/providers/solana-rpc.mjs";
import { magicEdenSolStats, magicEdenSolListings, magicEdenSolPrepareBuy } from "../src/data/providers/magiceden-sol.mjs";

const PROBE_WALLET = process.env.ORACLE_E2E_SOL_PUBKEY || "DtM6A1ivwvFeT14f7ggTAGvpUTZA5LeutV3rLe8wR6U3";
const PROBE_BTC = process.env.ORACLE_E2E_BTC_ADDRESS || "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

const results = [];
function record(lane, status, detail) {
  results.push({ lane, status, detail });
  const tag = status === "ok" ? "OK  " : status === "keyed" ? "KEY " : "FAIL";
  console.log(`${tag} ${lane} :: ${detail}`);
}

async function run(lane, fn, { optional = false } = {}) {
  try {
    const detail = await fn();
    record(lane, "ok", detail);
    return true;
  } catch (error) {
    const message = String(error?.message || error).slice(0, 140);
    record(lane, optional ? "keyed" : "fail", message);
    return optional;
  }
}

console.log("== SOLANA ==");

await run("solana.rpc.health", async () => {
  const health = await desk.solana.health();
  if (!health?.ok) throw new Error(`rpc unhealthy ${JSON.stringify(health).slice(0, 80)}`);
  return `cluster ok slot lane live`;
});

await run("solana.rpc.balance", async () => {
  const bal = await desk.solana.balance(PROBE_WALLET);
  return `lamports=${bal?.lamports ?? bal?.value ?? "n/a"}`;
});

await run("solana.rpc.tokenAccounts", async () => {
  const accounts = await desk.solana.tokenAccounts({ owner: PROBE_WALLET });
  return `accounts=${accounts?.accounts?.length ?? 0}`;
});

let jupQuote = null;
await run("solana.jupiter.quote(SOL->USDC)", async () => {
  jupQuote = await jupiterQuote({ inputMint: SOL_MINT, outputMint: USDC_MINT, amount: "10000000", slippageBps: 50 });
  const g = jupQuote.solanaGuard;
  if (jupQuote.executionReady !== false) throw new Error("quote must not be executionReady");
  if (g.slippageBps > 100) throw new Error("slippage cap breached");
  return `out=${jupQuote.quote.outAmount} bps=${g.slippageBps} expires=${g.expiresAtMs - g.quotedAtMs}ms execReady=false`;
});

await run("solana.jupiter.slippageCap", async () => {
  try {
    await jupiterQuote({ inputMint: SOL_MINT, outputMint: USDC_MINT, amount: "10000000", slippageBps: 500 });
  } catch (error) {
    return `rejected 500bps: ${String(error.message).slice(0, 60)}`;
  }
  throw new Error("500 bps was NOT rejected");
});

let jupPrepared = null;
await run("solana.jupiter.prepareSwap", async () => {
  jupPrepared = await jupiterPrepareSwap({
    quoteResponse: jupQuote.quote,
    userPublicKey: PROBE_WALLET,
  });
  if (jupPrepared.signingReady !== false || jupPrepared.broadcastReady !== false) throw new Error("prepare leaked signing/broadcast readiness");
  if (!jupPrepared.requiresUserSignature) throw new Error("prepare must require user signature");
  return `tx=${jupPrepared.swapTransaction.length}b64 requiresUserSig=true signingReady=false broadcastReady=false`;
});

await run("solana.rpc.simulate(preparedSwap)", async () => {
  const sim = await solanaSimulateTransaction({ transaction: jupPrepared.swapTransaction, sigVerify: false });
  const err = sim?.err ?? sim?.value?.err ?? sim?.raw?.value?.err ?? null;
  const units = sim?.unitsConsumed ?? sim?.value?.unitsConsumed ?? sim?.raw?.value?.unitsConsumed ?? null;
  return `err=${JSON.stringify(err)} unitsConsumed=${units}`;
});

await run("solana.nft.magiceden.stats", async () => {
  const stats = await magicEdenSolStats({ symbol: "mad_lads" });
  if (!(stats.floorPriceSol > 0)) throw new Error("no floor");
  return `floor=${stats.floorPriceSol} SOL listed=${stats.listedCount}`;
});

let meListing = null;
await run("solana.nft.magiceden.listings", async () => {
  const out = await magicEdenSolListings({ symbol: "mad_lads", limit: 1 });
  meListing = out.listings[0];
  if (!meListing?.tokenMint) throw new Error("no listing");
  return `mint=${meListing.tokenMint.slice(0, 8)}.. price=${meListing.priceSol} SOL seller=${meListing.seller.slice(0, 6)}..`;
});

await run(
  "solana.nft.magiceden.prepareBuy",
  async () => {
    const prep = await magicEdenSolPrepareBuy({
      buyer: PROBE_WALLET,
      seller: meListing.seller,
      auctionHouse: meListing.auctionHouse,
      tokenMint: meListing.tokenMint,
      tokenATA: meListing.tokenATA,
      priceSol: meListing.priceSol,
    });
    if (prep.broadcastReady !== false) throw new Error("prepare leaked broadcast readiness");
    return `tx prepared bytes=${String(prep.transaction || "").length} requiresUserSig=${prep.requiresUserSignature}`;
  },
  { optional: true }
);

console.log("== BITCOIN ==");

await run("bitcoin.esplora.health", async () => {
  const h = await desk.bitcoin.health();
  if (!h?.ok) throw new Error("esplora unhealthy");
  return `ok tip lane live`;
});

await run("bitcoin.esplora.tipHeight", async () => {
  const t = await desk.bitcoin.tipHeight();
  const height = t?.height ?? t?.tipHeight ?? t;
  if (!Number(height)) throw new Error("no tip height");
  return `tip=${height}`;
});

await run("bitcoin.esplora.fees", async () => {
  const f = await desk.bitcoin.fees();
  const fast = f?.fastestFee ?? f?.fees?.fastestFee ?? f?.["1"] ?? null;
  return `fastest=${JSON.stringify(fast)}`;
});

await run("bitcoin.esplora.address", async () => {
  const a = await desk.bitcoin.address(PROBE_BTC);
  const funded = a?.chainStats?.fundedTxoSum ?? a?.balanceSats ?? a?.raw?.chain_stats?.funded_txo_sum ?? null;
  return `fundedSats=${funded}`;
});

await run("bitcoin.esplora.utxos", async () => {
  const u = await desk.bitcoin.utxos(PROBE_BTC);
  const n = u?.utxos?.length ?? u?.length ?? 0;
  return `utxos=${n}`;
});

await run("bitcoin.meta.health", async () => {
  const h = await desk.bitcoin.metaHealth();
  return `ok=${h?.ok} tier=${h?.tier ?? h?.mode ?? "keyless"}`;
});

await run(
  "bitcoin.meta.inscriptionInfo",
  async () => {
    const info = await desk.bitcoin.inscriptions(PROBE_BTC);
    return `inscriptions=${info?.inscriptions?.length ?? "unknown"}`;
  },
  { optional: true }
);

await run(
  "bitcoin.satflow.health",
  async () => {
    const h = await desk.bitcoin.satflowHealth();
    if (!h?.ok) throw new Error(`satflow ${JSON.stringify(h).slice(0, 90)}`);
    return `ok`;
  },
  { optional: true }
);

const failed = results.filter((r) => r.status === "fail");
const keyed = results.filter((r) => r.status === "keyed");
console.log(`\nlanes=${results.length} ok=${results.length - failed.length - keyed.length} keyed=${keyed.length} failed=${failed.length}`);
if (failed.length) {
  console.log(`FAILED: ${failed.map((f) => f.lane).join(", ")}`);
  process.exit(1);
}
console.log("E2E OK: every mandatory Solana + Bitcoin lane answered live, prepare-only posture held.");
