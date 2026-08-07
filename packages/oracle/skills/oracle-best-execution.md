---
name: oracle-best-execution
description: Use whenever swapping or bridging. The rule that the highest-output route wins.
---

# Best execution

## One rule
The highest **net output** (after gas + bridge + impact) wins. Not the best quote, not the shortest route, not the prettiest UI.

## Swap flow
1. `data dex_search` → resolve token to chain + address
2. `data dex_token` → get live pairs, liquidity, price
3. `exec evm_quote` → exact-input quote from Uniswap V3
4. `data best_swap_route` → compare across aggregators (Li.Fi, Paraswap, 0x, CoW)
5. `data best_bridge_route` → if cross-chain, rank by net output
6. `exec evm_prepare` → build unsigned tx
7. Report: best route, net output, slippage, gas estimate

## Comparison always in USD
Convert gas + bridge fees to USD. 0.001 ETH ≠ 0.001 ETH across chains.

## Slippage
- Stable pools: 0.1% default
- Volatile pools: 0.5% default  
- Memecoins: 1-3% or auto-detect from depth
- Block >1% slippage without explicit user approval