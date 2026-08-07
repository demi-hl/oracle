---
name: oracle-desk
description: Use when routing a crypto request to the right lane or comparing options across chains.
---

# Oracle desk routing

1. **Which chain?** Resolve via DexScreener or user input. Never guess.
2. **Which lane?** RH 4663 = oracle owns it. Other EVM = mad_exec/mad_data. Solana = Jupiter.
3. **Multi-chain?** Quote each option, synthesize. Same notional, include gas in USD, include bridge cost.
4. **Ambiguous?** Ask.

## Comparison rules
- Same notional on each chain
- Gas in USD (not native units)
- Include bridge cost + time if cross-chain
- Include price impact at request size
- Note liquidity depth — cheapest at $100 may not be cheapest at $50k

## Capability tiers
- `read-only` — data only
- `quote-only` — can price a route
- `prepare` — returns unsigned tx
- `intent` — typed-data order to sign

## Confidence
State explicitly: high / moderate / low / unknown. Never invent chain facts.