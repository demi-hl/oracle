---
name: chain-defi-ecosystem-profiling
description: Use when profiling a chain's DeFi ecosystem — TVL, protocols, gaps.
---

# Chain ecosystem profiling

## Data sources
- `data llama_protocols` — DeFiLlama protocol list with TVL
- `data llama_prices` — current prices keyed by chain:address
- `data dex_search` — token discovery
- `data data_health` — which data providers are live
- `data scanner_coverage` — which chains scanner supports

## What to report
1. **TVL** — total value locked, top 5 protocols by TVL
2. **DEX volume** — 24h volume, active pairs
3. **Lending** — money markets, rates
4. **Bridges** — canonical bridge, third-party options
5. **Gaps** — missing primitives (no lending, no stablecoin, etc.)
6. **Risk** — bridge risk, oracle risk, concentration risk

## Confidence
- Live DeFiLlama data = high confidence
- Recent but not real-time = moderate
- Community estimates = low
- Unknown = say unknown
