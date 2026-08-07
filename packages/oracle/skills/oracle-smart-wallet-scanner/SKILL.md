---
name: oracle-smart-wallet-scanner
description: Use when finding, scoring, or monitoring smart wallets from on-chain behavior across tokens, NFTs, and venues.
---

# Smart-wallet scanner

Use this for on-chain wallet intelligence: early buyers, profitable exits, repeat
edge, copy-radar, cabal detection candidates, and wallet boards.

## Smart wallet definition

A wallet is not smart because it bought one winner. Require repeatable evidence:

- early across multiple unrelated assets
- profitable realized exits, not just mark-to-market bags
- enough trade count and not only one ticker
- entry before broad social consensus
- exits before liquidity drain or sell imbalance
- behavior survives fees, gas, and failed trades

## Scan pattern

1. Start from live events: pair creates, swaps, mint transfers, order fills,
   marketplace sales, bridge inflows.
2. Normalize wallet, chain, token/NFT, time, size, and realized PnL.
3. Cluster funding and common recipients separately; do not call it a bundle
   without launch-block clustering and common-funder evidence.
4. Score wallets by multi-asset repeatability and drawdown, not raw largest win.
5. Track holds vs exits. A smart buyer becoming a smart seller changes the signal.
6. Emit confidence and evidence window with every wallet label.

## Output standard

For each wallet surface:

- address and chain
- sample wins/losses
- realized PnL basis and limitations
- first-seen timing vs launch/volume
- current holdings/exit state if known
- confidence: high / moderate / low / unknown

## Hard rules

- Never expose a private operator wallet as a public smart-wallet seed.
- Never use one-token PnL as a primary smart label.
- Cabal candidates are seeds for deeper analysis, not proof of manipulation.
- If sell data is unavailable, label PnL `UNKNOWN`, not profitable.
