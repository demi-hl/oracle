import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  portfolioHistory,
  portfolioSnapshot,
  portfolioValueGraph,
  resolvePortfolioHistoryFile,
} from "../src/data/providers/portfolio-history.mjs";
import { dataCall, dataCatalog } from "../src/data/desk-data.mjs";

const EVM = "0x000000000000000000000000000000000000dEaD";

function balanceFixture(address = EVM, knownUsd = 100) {
  return {
    provider: "portfolio",
    operation: "balances",
    readOnly: true,
    queriedAt: "2026-08-01T00:00:00.000Z",
    addresses: { evm: address, solana: null, bitcoin: null, hyperliquid: address },
    coverage: { requestedSurfaces: 2, ok: 2, unavailable: 0, notConfigured: 0, unsupported: 0 },
    valuation: {
      knownUsd,
      label: "known priced value, not a complete portfolio total",
      pricedItems: 2,
      unpricedNonzeroItems: 1,
      complete: false,
      priceSource: "DefiLlama",
      priceStatus: "ok",
      priceQueriedAt: "2026-08-01T00:00:00.000Z",
    },
    chains: [
      { family: "evm", chainId: 1, name: "Ethereum", status: "ok", native: { usdValue: knownUsd } },
      { family: "hyperliquid", name: "Hyperliquid HyperCore", status: "ok", spot: { balances: [] }, perps: { accountValueUsd: "0" } },
    ],
    unsupportedFamilies: [],
    warnings: [],
  };
}

function nftFixture(value = 25, valuedItems = 1) {
  return {
    provider: "nft-portfolio",
    operation: "inventory",
    coverage: [{ family: "evm", chain: "ethereum", status: "ok", count: valuedItems }],
    inventory: { count: valuedItems, visibleCount: valuedItems, flaggedCount: 0, items: [], visibleItems: [], flaggedItems: [] },
    valuation: {
      estimatedCurrentValueUsd: value,
      valuedItems,
      unvaluedItems: 0,
      complete: true,
      methodology: "provider estimate",
    },
    warnings: [],
  };
}

async function tempHome() {
  return mkdtemp(path.join(os.tmpdir(), "oracle-portfolio-history-"));
}

test("portfolio snapshot persists one profile-isolated observation with liquid and NFT values", async () => {
  const home = await tempHome();
  const opts = {
    env: { HERMES_HOME: home },
    now: () => new Date("2026-08-01T01:00:00.000Z"),
    portfolioBalanceImpl: async () => balanceFixture(),
    nftInventoryImpl: async () => nftFixture(),
  };
  const result = await portfolioSnapshot({ addresses: { evm: EVM } }, opts);

  assert.equal(result.operation, "snapshot");
  assert.equal(result.snapshot.valuation.liquidKnownUsd, 100);
  assert.equal(result.snapshot.valuation.nftEstimatedValueUsd, 25);
  assert.equal(result.snapshot.valuation.knownUsd, 125);
  assert.equal(result.snapshot.valuation.complete, false);
  assert.match(result.snapshot.valuation.label, /known priced value/i);
  assert.equal(result.balance.valuation.knownUsd, 100);
  assert.equal(result.nfts.valuation.estimatedCurrentValueUsd, 25);

  const file = resolvePortfolioHistoryFile(opts);
  assert.equal(file, path.join(home, "state", "oracle", "portfolio-history.jsonl"));
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), result.snapshot);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("portfolio history filters by portfolio id and preserves unavailable value as null", async () => {
  const home = await tempHome();
  const first = await portfolioSnapshot(
    { addresses: { evm: EVM }, includeNfts: false },
    {
      env: { HERMES_HOME: home },
      now: () => new Date("2026-08-01T01:00:00.000Z"),
      portfolioBalanceImpl: async () => balanceFixture(EVM, 100),
    },
  );
  await portfolioSnapshot(
    { addresses: { evm: "0x0000000000000000000000000000000000000001" }, includeNfts: false },
    {
      env: { HERMES_HOME: home },
      now: () => new Date("2026-08-01T02:00:00.000Z"),
      portfolioBalanceImpl: async () => ({
        ...balanceFixture("0x0000000000000000000000000000000000000001", 0),
        valuation: { ...balanceFixture().valuation, knownUsd: 0, pricedItems: 0, priceStatus: "unavailable" },
      }),
    },
  );

  const history = await portfolioHistory(
    { portfolioId: first.snapshot.portfolioId, order: "asc", limit: 10 },
    { env: { HERMES_HOME: home } },
  );
  assert.equal(history.snapshots.length, 1);
  assert.equal(history.snapshots[0].valuation.knownUsd, 100);

  const all = await portfolioHistory(
    { allPortfolios: true, order: "asc", limit: 10 },
    { env: { HERMES_HOME: home } },
  );
  assert.equal(all.snapshots.length, 2);
  assert.equal(all.snapshots[1].valuation.knownUsd, null);
  assert.equal(all.stats.unpricedSnapshots, 1);
});

test("portfolio value graph renders chronological known-value history and skips unavailable points", async () => {
  const home = await tempHome();
  const file = resolvePortfolioHistoryFile({ env: { HERMES_HOME: home } });
  const portfolioId = "portfolio_test</text><script>alert(1)</script><text>";
  const rows = [
    { schemaVersion: 1, id: "a", portfolioId, recordedAt: "2026-08-01T00:00:00.000Z", valuation: { knownUsd: 100, complete: false } },
    { schemaVersion: 1, id: "b", portfolioId, recordedAt: "2026-08-02T00:00:00.000Z", valuation: { knownUsd: null, complete: false } },
    { schemaVersion: 1, id: "c", portfolioId, recordedAt: "2026-08-03T00:00:00.000Z", valuation: { knownUsd: 150, complete: false } },
  ];
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600, flag: "w" }).catch(async (error) => {
    if (error.code !== "ENOENT") throw error;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
  });

  await assert.rejects(
    () => portfolioValueGraph(
      { limit: 100 },
      { env: { HERMES_HOME: home } },
    ),
    /requires one portfolioId or configured public-address portfolio/,
  );

  const graph = await portfolioValueGraph(
    { portfolioId, limit: 100 },
    { env: { HERMES_HOME: home } },
  );
  assert.equal(graph.operation, "valueGraph");
  assert.equal(graph.mimeType, "image/svg+xml");
  assert.equal(graph.summary.points, 2);
  assert.equal(graph.summary.startKnownUsd, 100);
  assert.equal(graph.summary.endKnownUsd, 150);
  assert.equal(graph.summary.changeUsd, 50);
  const svg = Buffer.from(graph.dataBase64, "base64").toString("utf8");
  assert.match(svg, /Oracle Portfolio Value/);
  assert.match(svg, /Known priced value/);
  assert.ok(!svg.includes("<script"));
  assert.ok(!svg.includes("<foreignObject"));
});

test("portfolio history operations are catalogued and route through the data facade", async () => {
  const provider = dataCatalog().find((row) => row.id === "portfolio");
  assert.deepEqual(provider.ops, ["health", "balances", "snapshot", "history", "valueGraph"]);

  const home = await tempHome();
  const opts = {
    env: { HERMES_HOME: home },
    portfolioBalanceImpl: async () => balanceFixture(),
    nftInventoryImpl: async () => nftFixture(),
  };
  const snapshot = await dataCall("portfolio", "snapshot", { addresses: { evm: EVM } }, opts);
  assert.equal(snapshot.operation, "snapshot");
  const history = await dataCall("portfolio", "history", { portfolioId: snapshot.snapshot.portfolioId }, opts);
  assert.equal(history.snapshots.length, 1);
  const graph = await dataCall("portfolio", "valueGraph", { portfolioId: snapshot.snapshot.portfolioId }, opts);
  assert.equal(graph.mimeType, "image/svg+xml");
});
