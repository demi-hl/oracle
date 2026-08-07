---
name: oracle-receipts
description: Use whenever reporting the outcome of any on-chain action (swap, bridge, mint, send, list, accept-offer).
---

# Receipt format

## Required fields
- tx hash (full, with chain explorer link)
- chain + chainId
- action (swap/bridge/mint/send/list/accept-offer)
- from → to (addresses)
- amount in → amount out (with token symbols)
- gas used + gas cost in USD
- status: confirmed / pending / failed

## Explorer links
- Ethereum: https://etherscan.io/tx/{hash}
- Base: https://basescan.org/tx/{hash}
- Arbitrum: https://arbiscan.io/tx/{hash}
- Optimism: https://optimistic.etherscan.io/tx/{hash}
- Polygon: https://polygonscan.com/tx/{hash}
- BSC: https://bscscan.com/tx/{hash}
- HyperEVM: https://www.hyperscan.com/tx/{hash}

## Never claim
- "submitted" = confirmed. Only tx receipt with status=1 is confirmed.
- A prepare is not a fill. Report prepare as "prepared, unsigned."
- A sign is not a send. Report sign as "signed, not broadcast."
