---
name: oracle-chain-graphs-telegram-cards
description: Render per-chain market graphs and Telegram cards for Oracle alerts, including meme launches, HL HIP-3/HIP-4, and Polymarket.
---

# Oracle chain graphs + Telegram cards

Use when Oracle needs visual alerts: per-chain scanner cards, meme-token launch
cards, route-comparison charts, Hyperliquid HIP-3/HIP-4 cards, or Polymarket
cards.

## Surfaces

- Per-chain token charts: price, volume, liquidity, market cap, age, and venue.
- Launch/sniper cards: token, chain, pool, route readiness, sellability, smart-wallet
  overlap, risk status, and prepared-ticket status.
- Hyperliquid HIP-3 builder-dex cards: dex, market, mark/oracle, funding, OI,
  depth, liquidation/risk notes when account context is provided.
- Hyperliquid HIP-4 outcome-market cards: event/outcome, bid/ask, depth, edge,
  held-position context when API keys/account reads are configured.
- Polymarket cards: event, market, Yes/No prices, volume, BBO, resolution-risk
  notes, and prepared order intent only when user auth/API keys are configured.

## Data rules

- Public/keyless reads are allowed where the venue supports them.
- API-key surfaces activate only when the user self-hosts and provides their own
  keys. Never ship DEMI keys or assume hosted secrets.
- A graph is evidence, not authorization. It can trigger a prepared ticket; it
  must not bypass quote freshness, sell-sim, grant caps, or wallet signing.
- Every card states chain/venue and confidence. Unknown data stays `UNKNOWN`.

## Telegram card rules

- Send text card and graph as separate messages when the card is long.
- Avoid markdown traps: no unescaped underscore labels, avoid repeated `$` spans.
- Keep full contracts/mints visible; never truncate the only identifier.
- Chart rendering must soft-fail: card still sends if the image fails.
- No buy/sell buttons unless the recipient has a valid local grant/session.

## Graph schema

A graph payload should include:

- `chainId` / `cluster` / venue
- token/market id
- time window and candle interval
- price/volume/liquidity series or order-book snapshots
- source/provider and fetched timestamp
- warnings for stale, sparse, or degraded data

## HIP-3 / HIP-4 / Polymarket notes

- HIP-3 builder perps require Hyperliquid `perpDexs` and `metaAndAssetCtxs` with
  `dex` selected; core `meta` does not include all builder-dex markets.
- HIP-4 outcome markets require the configured Hyperliquid/API-key path for user
  account/order actions. Keyless cards can still show public market data.
- Polymarket public reads work keyless; trading/order placement needs the user's
  CLOB auth/API setup and stays prepared/user-signed.
