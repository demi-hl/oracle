import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openseaAccountNfts,
  openseaAccountPnl,
  openseaPrepareList,
} from "../src/data/providers/opensea-nft.mjs";
import { magicEdenSolPrepareList } from "../src/data/providers/magiceden-sol.mjs";
import * as nftPortfolio from "../src/data/providers/nft-portfolio.mjs";
import { nftGallery } from "../src/data/providers/nft-gallery.mjs";
import { dataCall, dataCatalog } from "../src/data/desk-data.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVM = "0x000000000000000000000000000000000000dEaD";
const CONTRACT = "0x000000000000000000000000000000000000bEEF";
const SOLANA = "11111111111111111111111111111111";
const SOLANA_B = "Vote111111111111111111111111111111111111111";
const BITCOIN = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pngResponse(bytes = Buffer.from("89504e470d0a1a0a", "hex")) {
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "content-length": String(bytes.length),
    },
  });
}

test("OpenSea account inventory paginates and preserves unknown valuation as null", async () => {
  const requests = [];
  const result = await openseaAccountNfts(
    { chain: "ethereum", address: EVM, pageSize: 1, maxPages: 2 },
    {
      apiKey: "test-opensea-key",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), headers: init.headers });
        const next = new URL(String(url)).searchParams.get("next");
        if (!next) {
          return jsonResponse({
            nfts: [{
              identifier: "1",
              contract: CONTRACT,
              collection: "demo",
              name: "A & B <script>",
              display_image_url: "https://i.seadn.io/demo.png",
              estimated_value_usd: null,
              is_disabled: false,
              is_nsfw: false,
              opensea_url: "https://opensea.io/assets/ethereum/demo/1",
              token_standard: "erc721",
              traits: [],
              updated_at: "2026-01-01T00:00:00Z",
            }],
            next: "page-two",
          });
        }
        return jsonResponse({
          nfts: [{
            identifier: "2",
            contract: CONTRACT,
            collection: "demo",
            name: "Flagged",
            estimated_value_usd: 7,
            is_disabled: true,
            is_nsfw: false,
            opensea_url: "https://opensea.io/assets/ethereum/demo/2",
            token_standard: "erc721",
            traits: [],
            updated_at: "2026-01-01T00:00:00Z",
          }],
        });
      },
    },
  );

  assert.equal(result.complete, true);
  assert.equal(result.pages, 2);
  assert.equal(result.nfts.length, 2);
  assert.equal(result.nfts[0].estimatedValueUsd, null);
  assert.equal(result.nfts[1].spam, true);
  assert.equal(requests[0].headers["x-api-key"], "test-opensea-key");
  assert.equal(new URL(requests[1].url).searchParams.get("next"), "page-two");
});

test("OpenSea account PnL is labeled provider-indexed and not per-item cost basis", async () => {
  const result = await openseaAccountPnl(
    { address: EVM },
    {
      apiKey: "test-opensea-key",
      fetchImpl: async () => jsonResponse({
        realized_pnl_usd: "10.00",
        unrealized_pnl_usd: "-2.00",
        total_pnl_usd: "8.00",
        net_invested_usd: "20.00",
        current_value_usd: "18.00",
        return_percentage: "40.00",
      }),
    },
  );
  assert.equal(result.totalPnlUsd, "8.00");
  assert.equal(result.itemLevelPnlAvailable, false);
  assert.match(result.scope, /not per-item/i);
});

test("OpenSea listing preparation requires explicit review and returns only wallet actions", async () => {
  const endTime = new Date(Date.now() + 86_400_000).toISOString();
  await assert.rejects(
    () => openseaPrepareList({
      seller: EVM,
      chain: "ethereum",
      contract: CONTRACT,
      tokenId: "1",
      priceAmount: "1",
      endTime,
    }, { apiKey: "test-opensea-key", fetchImpl: async () => jsonResponse({ steps: [] }) }),
    /userConfirmed=true/,
  );

  let outbound;
  const result = await openseaPrepareList(
    {
      userConfirmed: true,
      seller: EVM,
      marketplace: "opensea",
      chain: "ethereum",
      contract: CONTRACT,
      tokenId: "1",
      quantity: 1,
      priceAmount: "1.25",
      currency: "0x0000000000000000000000000000000000000000",
      endTime,
      useCreatorFee: true,
    },
    {
      apiKey: "test-opensea-key",
      fetchImpl: async (url, init) => {
        outbound = { url: String(url), init, body: JSON.parse(init.body) };
        return jsonResponse({
          steps: [
            { action: "setApprovalForAll", transaction: { to: CONTRACT, data: "0x1234" } },
            { action: "createListings", typedData: { domain: {}, types: {}, value: {} } },
          ],
        });
      },
    },
  );

  assert.match(outbound.url, /\/api\/v2\/listings\/actions$/);
  assert.equal(outbound.body.items[0].price.amount, "1.25");
  assert.equal(outbound.body.items[0].end_time, endTime);
  assert.equal(result.oraclePrepared, true);
  assert.equal(result.requiresSeparateApproval, true);
  assert.equal(result.signingReady, false);
  assert.equal(result.broadcastReady, false);
  assert.equal(result.steps.length, 2);
  assert.ok(!JSON.stringify(result).match(/private.?key|mnemonic/i));
});

test("Magic Eden listing binds exact confirmation plus explicit future expiry and rejects pre-signed payloads", async () => {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const listing = {
    seller: SOLANA,
    tokenMint: SOLANA_B,
    tokenATA: SOLANA_B,
    auctionHouse: SOLANA_B,
    priceSol: "1.5",
    expiry,
  };
  await assert.rejects(
    () => magicEdenSolPrepareList(
      listing,
      { apiKey: "test-opensea-key", fetchImpl: async () => jsonResponse({ v0: { tx: { data: [1, 2, 3] } } }) },
    ),
    /confirm/i,
  );
  await assert.rejects(
    () => magicEdenSolPrepareList(
      { ...listing, userConfirmed: true, confirmation: "wrong" },
      { apiKey: "test-opensea-key", fetchImpl: async () => jsonResponse({ v0: { tx: { data: [1, 2, 3] } } }) },
    ),
    /confirmation/i,
  );
  await assert.rejects(
    () => magicEdenSolPrepareList(
      { ...listing, expiry: 0, userConfirmed: true, confirmation: "list 11111111111111111111111111111111 on magiceden-sol for 1.5 SOL until 0" },
      { apiKey: "test-opensea-key", fetchImpl: async () => jsonResponse({ v0: { tx: { data: [1, 2, 3] } } }) },
    ),
    /expiry.*future/i,
  );

  let requested;
  const confirmation = `list ${listing.tokenMint} on magiceden-sol for ${listing.priceSol} SOL until ${expiry}`;
  const result = await magicEdenSolPrepareList(
    { ...listing, userConfirmed: true, confirmation },
    {
      apiKey: "test-opensea-key",
      fetchImpl: async (url) => {
        requested = new URL(String(url));
        return jsonResponse({ v0: { tx: { data: [1, 2, 3] } } });
      },
    },
  );
  assert.equal(requested.searchParams.get("expiry"), String(expiry));
  assert.equal(result.expiry, expiry);
  assert.equal(result.confirmation, confirmation);
  assert.equal(result.oraclePrepared, true);

  await assert.rejects(
    () => magicEdenSolPrepareList(
      { ...listing, userConfirmed: true, confirmation },
      {
        apiKey: "test-opensea-key",
        fetchImpl: async () => jsonResponse({ txSigned: "malicious" }),
      },
    ),
    /pre-signed/i,
  );
});

test("NFT inventory normalizes holdings, hides flagged media, and computes only grounded cost-basis PnL", async () => {
  const result = await nftPortfolio.nftInventory(
    {
      addresses: { evm: EVM },
      chains: ["ethereum"],
      includePnl: true,
      costBasis: {
        [`ethereum:${CONTRACT}:1`.toLowerCase()]: { costUsd: 4, feesUsd: 1, acquiredAt: "2026-01-01T00:00:00Z" },
      },
    },
    {
      env: {},
      opensea: {
        apiKey: "test-opensea-key",
        fetchImpl: async (url) => {
          if (String(url).includes("/account/") && String(url).endsWith("/pnl")) {
            return jsonResponse({
              realized_pnl_usd: "10",
              unrealized_pnl_usd: "2",
              total_pnl_usd: "12",
              net_invested_usd: "8",
              current_value_usd: "10",
              return_percentage: "150",
            });
          }
          return jsonResponse({ nfts: [
            {
              identifier: "1",
              contract: CONTRACT,
              collection: "demo",
              name: "Visible",
              display_image_url: "https://i.seadn.io/demo.png",
              estimated_value_usd: 8,
              is_disabled: false,
              is_nsfw: false,
              opensea_url: "https://opensea.io/assets/ethereum/demo/1",
              token_standard: "erc721",
              traits: [],
              updated_at: "2026-01-01T00:00:00Z",
            },
            {
              identifier: "2",
              contract: CONTRACT,
              collection: "demo",
              name: "Flagged",
              estimated_value_usd: 100,
              is_disabled: true,
              is_nsfw: false,
              opensea_url: "https://opensea.io/assets/ethereum/demo/2",
              token_standard: "erc721",
              traits: [],
              updated_at: "2026-01-01T00:00:00Z",
            },
          ] });
        },
      },
    },
  );

  assert.equal(result.readOnly, true);
  assert.equal(result.inventory.count, 2);
  assert.equal(result.inventory.visibleCount, 1);
  assert.equal(result.inventory.flaggedCount, 1);
  assert.equal(result.valuation.estimatedCurrentValueUsd, 8);
  assert.equal(result.pnl.nftItemPnl.knownUnrealizedUsd, 3);
  assert.equal(result.pnl.nftItemPnl.knownItems, 1);
  assert.equal(result.pnl.providerAccountPnl[0].totalPnlUsd, "12");
  assert.match(result.pnl.nftItemPnl.warning, /Transfers/);
});

test("truncated Bitcoin NFT inventory cannot claim complete valuation", async () => {
  const result = await nftPortfolio.nftInventory(
    {
      addresses: { bitcoin: BITCOIN },
      chains: ["bitcoin"],
      bitcoinLimit: 1,
      includePnl: false,
    },
    {
      env: {},
      satflow: {
        apiKey: "test-key",
        fetchImpl: async () => jsonResponse([
          { id: "inscription-a", estimated_value_usd: 25 },
        ]),
      },
    },
  );

  assert.equal(result.coverage[0].status, "partial");
  assert.equal(result.coverage[0].complete, false);
  assert.equal(result.valuation.valuedItems, 1);
  assert.equal(result.valuation.complete, false);
});

test("missing NFT estimates stay unvalued instead of becoming zero-valued observations", async () => {
  const result = await nftPortfolio.nftInventory(
    { addresses: { evm: EVM }, chains: ["ethereum"], includePnl: false },
    {
      env: {},
      opensea: {
        apiKey: "test-...ey",
        fetchImpl: async () => jsonResponse({ nfts: [{ contract: CONTRACT, identifier: "9", name: "Unpriced" }] }),
      },
    },
  );
  assert.equal(result.inventory.visibleCount, 1);
  assert.equal(result.valuation.valuedItems, 0);
  assert.equal(result.valuation.unvaluedItems, 1);
  assert.equal(result.valuation.complete, false);
});

test("NFT gallery embeds only allowlisted raster bytes and uses placeholders for unsafe hosts", async () => {
  const result = await nftGallery(
    {
      pageSize: 2,
      items: [
        { assetKey: "ethereum:demo:1", chain: "ethereum", name: "A & B <script>", imageUrl: "https://i.seadn.io/demo.png" },
        { assetKey: "ethereum:demo:2", chain: "ethereum", name: "Unsafe", imageUrl: "https://127.0.0.1/secret.png" },
      ],
    },
    { fetchImpl: async () => pngResponse() },
  );

  const svg = Buffer.from(result.dataBase64, "base64").toString("utf8");
  assert.equal(result.mimeType, "image/svg+xml");
  assert.equal(result.renderedItems, 1);
  assert.equal(result.placeholders.length, 1);
  assert.match(svg, /A &amp; B &lt;script&gt;/);
  assert.ok(!svg.includes("https://127.0.0.1"));
  assert.ok(!svg.includes("<script"));
  assert.ok(!svg.includes("<foreignObject"));
  assert.ok(!svg.includes("href=\"https://"));
});

test("unified NFT listing preparation supports EVM, Solana, and Bitcoin but never signs or broadcasts", async () => {
  assert.equal(typeof nftPortfolio.nftPrepareList, "function");
  const endTime = new Date(Date.now() + 86_400_000).toISOString();

  const evm = await nftPortfolio.nftPrepareList(
    {
      marketplace: "opensea",
      chain: "ethereum",
      userConfirmed: true,
      seller: EVM,
      contract: CONTRACT,
      tokenId: "1",
      priceAmount: "1",
      currency: "0x0000000000000000000000000000000000000000",
      endTime,
    },
    {
      opensea: {
        apiKey: "test-opensea-key",
        fetchImpl: async () => jsonResponse({ steps: [{ action: "createListings", typedData: {} }] }),
      },
    },
  );
  assert.equal(evm.marketplace, "opensea");
  assert.equal(evm.oraclePrepared, true);
  assert.equal(evm.signingReady, false);
  assert.equal(evm.broadcastReady, false);

  await assert.rejects(
    () => nftPortfolio.nftPrepareList({ marketplace: "unknown", userConfirmed: true }),
    /unsupported NFT marketplace/i,
  );
});

test("NFT portfolio provider is catalogued and routes inventory, gallery, PnL, and prepare-list operations", async () => {
  const provider = dataCatalog().find((row) => row.id === "nft-portfolio");
  assert.ok(provider);
  assert.deepEqual(provider.ops, ["health", "inventory", "gallery", "pnl", "prepareList"]);
  assert.equal(provider.execution, "prepare");

  const result = await dataCall(
    "nft-portfolio",
    "inventory",
    { addresses: { evm: EVM }, chains: ["ethereum"], includePnl: false },
    {
      env: {},
      opensea: { apiKey: "test-opensea-key", fetchImpl: async () => jsonResponse({ nfts: [] }) },
    },
  );
  assert.equal(result.operation, "inventory");
  assert.equal(result.inventory.count, 0);
});

test("Oracle MCP advertises NFT inventory, gallery, PnL, and prepare-list tools", async () => {
  const proc = spawn(process.execPath, [path.join(ROOT, "bin/oracle-data-mcp.mjs")], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  proc.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) if (line.trim()) lines.push(line.trim());
  });
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  proc.kill();
  const parsed = lines.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const names = parsed.find((row) => row.id === 2)?.result?.tools?.map((tool) => tool.name) || [];
  assert.ok(names.includes("nft_inventory"));
  assert.ok(names.includes("nft_gallery"));
  assert.ok(names.includes("nft_pnl"));
  assert.ok(names.includes("nft_prepare_list"));
  assert.ok(names.includes("portfolio_snapshot"));
  assert.ok(names.includes("portfolio_history"));
  assert.ok(names.includes("portfolio_value_graph"));
});
