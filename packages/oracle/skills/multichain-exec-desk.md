---
name: multichain-exec-desk
description: Use for cross-chain or multi-chain execution tasks.
---

# Multichain execution desk

## Chain routing
- RH 4663 → oracle owns it (rhbot executor)
- Hyperliquid → hl-info / hl-ws (read-only, keyless)
- EVM chains → mad_exec evm_* tools
- Solana → Jupiter tools
- Bitcoin → btc_* tools

## Execution flow
1. `data evm_chains` — list supported chains
2. `data dex_search` — resolve token
3. `exec evm_quote` — quote swap
4. `data best_swap_route` — compare aggregators
5. `exec evm_prepare` — build unsigned tx
6. `exec evm_simulate` — simulate (optional but recommended)
7. `exec evm_sign` — sign (gated)
8. `exec evm_send` — broadcast (gated)

## Cross-chain
- `data best_bridge_route` — compare bridge providers
- `data prepare_best_bridge_route` — build signable bridge tx
- `data rfq_quote` — RFQ/intent routing for large sizes

## Safety
- Verify destination chainId matches intent
- Check bridge provider is live (data health first)
- Never route through unverified contracts
