---
name: oracle-nft-gacha-launch
description: Use when designing or preparing NFT collections, mint pages, reveal mechanics, and gacha-style pack/loot drops.
---

# NFT and gacha launch builder

Use this when a user wants to launch an NFT collection, pack opening, loot box,
claim pass, or randomized reveal product.

## Product shape first

State the launch mechanics before code:

- asset standard: ERC-721, ERC-1155, Ordinals collection, SPL/NFT, or hybrid
- supply, per-wallet caps, allowlist/public phases, price, treasury, royalties
- reveal style: instant, delayed, commit-reveal, VRF-backed, or fully deterministic
- pack/gacha odds and whether duplicates are possible
- admin powers: owner, pauser, metadata updater, withdrawer, upgrader

## Safety rails

- User signs every deploy/mint/admin transaction; Oracle prepares and simulates.
- Randomness must be honest. Do not use miner/block timestamp as gacha randomness.
- Publish odds for gacha/loot mechanics and keep them deterministic/auditable.
- No hidden mint, owner reroll, metadata rug, or unbounded treasury withdrawal.
- Per-wallet caps and phase windows are enforced on-chain when material.
- Marketplaces are secondary: floor price is not a guaranteed bid.
- Public mint bots enforce gas-war limits across chains: total gas cap, optional
  per-unit fee cap, and optional priority-fee cap before returning unsigned
  mint calldata. Missing caps fail closed.

## Build checklist

1. Choose the boring audited base contract unless novelty is required.
2. Write the authority model in plain language.
3. Add tests for mint limits, payment/refund, reveal, withdraw, and admin changes.
4. Simulate deploy and first mint before returning unsigned transactions.
5. Produce metadata schema, asset pipeline, and provenance hash/manifest.
6. Prepare marketplace setup only after contract addresses and metadata are stable.

## Gacha-specific checks

- Show odds table and expected value in user terms.
- Cap max spend per wallet/session.
- Separate entertainment mechanics from investment claims.
- If jurisdictional gambling risk is plausible, flag it and keep the launch
  non-custodial/transparent rather than pretending it is just an NFT mint.
