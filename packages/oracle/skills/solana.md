---
name: solana
description: Use for Solana reads and swap preparation.
---

# Solana

## Read
- `data solana_balance <pubkey>` — SOL balance
- `data solana_token_accounts <pubkey>` — SPL token accounts
- `data dex_search <symbol>` → resolve to Solana token

## Swap
- `data jupiter_quote` — get best swap route (≤100 bps slippage)
- `data jupiter_prepare` — build unsigned swap tx
- `data solana_simulate` — simulate before signing

## Key facts
- No EVM — separate address format, separate tools
- Jupiter is the primary aggregator
- Never sign a Solana tx without simulating first
- Read/prepare only on this plane — signing uses operator package
