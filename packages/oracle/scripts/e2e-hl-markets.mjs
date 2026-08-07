import { data as desk } from "../src/data/desk-data.mjs";

const board = await desk.call("hl-markets", "markets", {});
console.log(`markets: ${board.count} live perps`);
console.log(`total OI:  $${(board.totals.openInterestUsd / 1e9).toFixed(2)}B`);
console.log(`24h vol:   $${(board.totals.dayNtlVolumeUsd / 1e9).toFixed(2)}B`);

const btc = board.markets.find((m) => m.coin === "BTC");
console.log(`\nBTC  mark=$${btc.markPx}  24h=${btc.change24hPct?.toFixed(2)}%  OI=$${(btc.openInterestUsd / 1e6).toFixed(1)}M  fundingAPR=${btc.fundingRateAprPct?.toFixed(2)}%  maxLev=${btc.maxLeverage}x`);

const lb = await desk.call("hl-markets", "leaderboards", { limit: 3 });
console.log(`\ntop gainers:  ${lb.gainers.map((m) => `${m.coin} ${m.change24hPct.toFixed(1)}%`).join(", ")}`);
console.log(`top losers:   ${lb.losers.map((m) => `${m.coin} ${m.change24hPct.toFixed(1)}%`).join(", ")}`);
console.log(`by volume:    ${lb.byVolume.map((m) => `${m.coin} $${(m.dayNtlVolumeUsd / 1e6).toFixed(0)}M`).join(", ")}`);
console.log(`funding high: ${lb.fundingHighest.map((m) => `${m.coin} ${m.fundingRateAprPct.toFixed(1)}%`).join(", ")}`);

const hype = await desk.call("hl-markets", "coin", { coin: "HYPE", interval: "1h" });
console.log(`\nHYPE mark=$${hype.market.markPx}  spread=${hype.book.spreadBps?.toFixed(2)}bps  candles=${hype.candles.count}`);

const spot = await desk.call("hl-markets", "spot", {});
console.log(`spot: ${spot.tokenCount} tokens / ${spot.pairCount} pairs`);
