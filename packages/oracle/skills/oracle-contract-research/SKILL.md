---
name: oracle-contract-research
description: Use when verifying a contract, router, factory, or venue address before trusting it with value.
---

# Contract research

The destination allowlist is the highest-leverage control on this desk. Allowlisting
a spoofed router defeats every other protection. So verification is not a formality.

## Never trust a name

Explorer contract names are self-reported and clones reuse them. "UniswapV2Router02"
on an explorer means someone deployed a contract and called it that.

Verify instead:

1. **Bytecode exists** — `eth_getCode` must return real code. `0x` means nothing is
   deployed. A 2-byte result is an empty stub.
2. **The protocol's own API or docs** name that address, on that chain, today. For
   aggregators, query their API (e.g. LI.FI's `/chains` returns each chain's
   official `diamondAddress`) rather than trusting a blog post.
3. **Constructor-bound addresses match** — read `factory()`, `WETH9()`,
   `quoter()` back off the deployed contract and confirm they are what you expect.
4. **Per chain, separately.** An address verified on Arbitrum is not verified on
   Ethereum, even when the canonical deployment happens to share an address.

Record **how and when** you verified, in a comment next to the entry. The audit
trail has to outlive your session.

## Pools

- `blockTimestampLast == 0` on `getReserves()` → not a live pool
- a token's *own* reserves may be virtual or zero; the tradeable market is a
  different pair address
- confirm the advertised pool equals `factory.getPool(tokenA, tokenB, fee)`

## Forks are not the original

A fork may keep the pair interface while replacing the router entirely — for
instance requiring an off-chain signed quote you cannot produce. Decode a recent
real swap on the pool to find the router the market actually uses, and its selector.

A non-standard selector is a signal, not a curiosity.

## Approvals

Approve the **exact amount**. Never default to unlimited. After an approve lands,
read `allowance` back before firing the dependent transaction — an approve that
reverted silently turns the next call into a confusing failure.

## Fail closed

An unverified chain or venue stays blocked. That is a safe state, not a gap to route
around. Never allowlist an address you found only from a model's answer.
