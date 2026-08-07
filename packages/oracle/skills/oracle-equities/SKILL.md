---
name: oracle-equities
description: Use when comparing on-chain equity venues (HIP-3, Arcus, RH Uniswap, Solana xStocks, TON). Cross-chain best execution for tokenized equities, prepare-only.
---

# Crossbook (on-chain equities best execution)

On-chain equities are not one venue. HIP-3 builder DEXes discover price, Arcus/RH list spot and perps on Robinhood Chain 4663, Solana xStocks and TON ston.fi list tokenized spots. Rank **net of known costs**, never the loudest mid.

## Get the comparison

MCP (data plane, in-process, no desk required):

```
equity_venues
equity_quote { ticker, sizeUsd?, horizonHours? }
equity_prepare { ticker, recipient, sizeUsd? }
```

CLI:

```bash
oracle equities venues
oracle equities quote NVDA --size 1000
oracle equities quote SPY --size 500 --json
oracle equities prepare NVDA --recipient 0xYourWallet
```

Library:

```js
import { bestEquityRoute, equityVenues, prepareEquityRoute } from "@oracle-agent/oracle/equities";
```

## Read the result properly

- **`rankedOn`** — `net-of-cost` only when fees/gas/impact are known. Usually `gross` today because HIP-3 fees/gas and DexScreener floats are unmeasured. Say so.
- **`costAccounted`** per route — `false` means that route is flattered by missing costs.
- **`improvementBps`** — `null` when no honest same-class costed pair exists. Do not invent one.
- **`bestPreparable`** is independent of `winner`. A quote-only HIP-3 or Solana mid can win discovery without being actionable here.
- **`excluded[]`** is not `failed[]`. Dormant HIP-3 dexs and crossed Arcus books land in excluded with reasons.
- **`darkWindow`** — outside NYSE core hours, marks are not real price discovery. Surface it.

## Tiers

| Venue | Tier | Can prepare? |
| --- | --- | --- |
| hyperliquid_hip3 | quote-only | no |
| arcus_perp / arcus_spot | quote-only | no |
| solana_xstocks | quote-only | no |
| ton_stonfi | quote-only | no |
| rh_uniswap | prepare | yes, unsigned only |

v1 only prepares RH Uniswap on chain 4663. Everything else is discovery and carry comparison.

## Rules

- Never present a quote-only winner as something the user can sign here.
- Never treat unknown gas/fees as zero.
- Horizon mode compares spot vs perp with funding carry held constant and labeled as an estimate.
- Prepare requires the real wallet as `recipient`. Placeholders are rejected by the RH prepare path when applicable.
- A comparison is not an execution. Preparing is separate. Signing is the user's wallet.
