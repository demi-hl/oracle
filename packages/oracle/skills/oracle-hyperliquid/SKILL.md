---
name: oracle-hyperliquid
description: Use for Hyperliquid perps and spot — funding, books, positions, liquidation distance via the public info API.
---

# Hyperliquid

Read through Oracle's data plane (`hl-info` provider, public `/info` endpoint). No
key required for reads.

## Ops worth knowing

| Need | Op |
|---|---|
| all mids | `allMids` |
| order book | `l2Book` |
| perp metadata + live ctx | `metaAndAssetCtxs` |
| spot metadata | `spotMeta` |
| account state | `clearinghouse` / `userState` |
| fills | `userFills` |
| open orders | `openOrders` / `frontendOpenOrders` |
| candles | `candleSnapshot` |

`metaAndAssetCtxs` is the efficient one: it returns funding, open interest, mark and
oracle price for every asset in a single call. Prefer it over per-asset loops.

## The three numbers that matter

**Liquidation distance.** In percent. Always state it for a leveraged position. A
"20x position" is really "a 5% adverse move ends this."

**Funding.** Annualize it. A position paying 40% annualized is losing steadily even
when directionally right. Funding flips sign — check the current rate, not the
average.

**Depth at your size.** The mid is a fiction for anything but the smallest clip.
Walk the `l2Book` to your notional and quote the real average fill.

## Mark vs oracle price

Liquidations reference the **oracle** price; PnL references the **mark**. They
diverge during volatility, which is exactly when it matters. Say which one you used.

## Spot and perps are different assets

The same ticker exists in both with different liquidity and no automatic
relationship. Never quote a perp book for a spot question.

## Hard rules

1. State liquidation distance for every leveraged position — not optional.
2. Annualize funding, always.
3. Quote fills from book depth, not the mid.
4. Never size to "max leverage" without naming the wipeout move.
5. You prepare; the user's wallet signs.
6. Receipts or it didn't happen.
