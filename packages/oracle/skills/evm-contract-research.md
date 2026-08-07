---
name: evm-contract-research
description: Use when researching or verifying EVM contracts, routers, factories, or tokens.
---

# EVM contract research

## Verification
1. `data dex_search <symbol>` → find token home chain + address
2. `data dex_token <address>` → live pairs, volume, liquidity, age
3. `data rpc_balance <address>` → native balance on chain
4. `exec evm_erc20_allowance <owner> <spender>` → check approvals
5. Use block explorer for source code verification

## Red flags
- No verified contract on explorer
- Created < 24h ago
- Liquidity < $10k
- Single LP holding > 50%
- Buy/sell tax > 5%
- Honeypot (can buy, can't sell)
- Proxy with unverified implementation

## Trusted routers (verify on-chain, don't assume)
- Uniswap V2 Router: 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D (Ethereum)
- Uniswap V3 Router: 0xE592427A0AEce92De3Edee1F18E0157C05861564
- UniversalRouter: 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD
