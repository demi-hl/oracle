import { data as desk } from "../src/data/desk-data.mjs";

const info = await desk.call("hl-perps", "assetInfo", { coin: "BTC" });
console.log(`BTC assetId=${info.assetId} szDecimals=${info.szDecimals} maxLev=${info.maxLeverage}x mark=$${info.markPx}`);

// 1. LIMIT BUY
const lim = await desk.call("hl-perps", "prepareOrder", {
  coin: "BTC", side: "buy", type: "limit", price: "60000.123456789", size: "0.0123456", tif: "Gtc",
});
console.log(`\nLIMIT BUY  px=${lim.price} sz=${lim.size} notional=$${lim.notionalUsd?.toFixed(2)} tif=${JSON.stringify(lim.action.orders[0].t)}`);
console.log(`  signingReady=${lim.signingReady} broadcastReady=${lim.broadcastReady} requiresUserSig=${lim.requiresUserSignature}`);

// 2. MARKET BUY with slippage cap
const mkt = await desk.call("hl-perps", "prepareOrder", {
  coin: "ETH", side: "buy", type: "market", size: "0.5", maxSlippageBps: 50,
});
console.log(`\nMARKET BUY ETH  aggressive px=${mkt.price} sz=${mkt.size} tif=${mkt.action.orders[0].t.limit.tif}`);

// 3. slippage cap enforced
try {
  await desk.call("hl-perps", "prepareOrder", { coin: "ETH", side: "buy", type: "market", size: "1", maxSlippageBps: 500 });
  console.log("  !! 500bps ACCEPTED — cap broken");
} catch (e) { console.log(`  500bps rejected: ${e.message.slice(0, 60)}`); }

// 4. LEVERAGE
const lev = await desk.call("hl-perps", "prepareLeverage", { coin: "BTC", leverage: 25, marginMode: "isolated" });
console.log(`\nLEVERAGE  ${lev.leverage}x ${lev.marginMode}  isCross=${lev.action.isCross}`);
console.log(`  warning: ${lev.liquidationWarning}`);

try {
  await desk.call("hl-perps", "prepareLeverage", { coin: "BTC", leverage: 999 });
  console.log("  !! 999x ACCEPTED — cap broken");
} catch (e) { console.log(`  999x rejected: ${e.message.slice(0, 70)}`); }

// 5. BRACKET: entry + TP + SL
const br = await desk.call("hl-perps", "prepareBracket", {
  coin: "BTC", side: "buy", type: "limit", price: "60000", size: "0.01",
  takeProfitPx: "72000", stopLossPx: "57000",
});
console.log(`\nBRACKET  legs=${br.legs} entry=${br.entry.price} tp=${br.takeProfitPx} sl=${br.stopLossPx} grouping=${br.action.grouping}`);
console.log(`  tp reduceOnly=${br.action.orders[1].r} trigger=${JSON.stringify(br.action.orders[1].t.trigger)}`);
console.log(`  sl reduceOnly=${br.action.orders[2].r} trigger=${JSON.stringify(br.action.orders[2].t.trigger)}`);

// 6. CANCEL
const c = await desk.call("hl-perps", "prepareCancel", { coin: "BTC", orderId: 12345 });
console.log(`\nCANCEL  oid=${c.orderId} action=${JSON.stringify(c.action)}`);

console.log("\nNo submit function exists in hl-perps — every result is user-signed.");
