---
name: hyperliquid
description: Use when working with Hyperliquid L1 — perps, spot, points, or HyperEVM.
---

# Hyperliquid

## Read plane (keyless)
- `data data_call hl-info allMids` — all perp mid prices
- `data data_call hl-info l2Book` — L2 orderbook depth
- `data data_call hl-info userState` — user positions + margin
- `data data_call hl-info userFills` — trade history
- `data data_call hl-info candleSnapshot` — OHLCV candles
- `data data_call hl-info spotMeta` — spot market metadata
- `data data_call hl-ws allMids` — fast WS snapshot

## HyperEVM (chain 999)
- RPC: https://rpc.hyperliquid.xyz/evm
- Explorer: https://www.hyperscan.com
- DEX search via `data dex_token` on chain 999
- Gas: paid in HyperEVM native token, ~0.1-0.5 USD typical

## Points
- Earned through perp trading volume
- No public API for points balance — uses userState for volume inference
- Wallet age + volume are primary signals
