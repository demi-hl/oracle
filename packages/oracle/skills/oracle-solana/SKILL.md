---
name: oracle-solana
description: Use for Solana research and swap preparation — Jupiter routes, SPL accounts, simulation, blockhash expiry.
---

# Solana

Read and prepare through Oracle's data plane (`solana-rpc`, `jupiter`). No key
required. Signing happens in the user's wallet; Oracle returns unsigned
transactions.

## Ops

| Need | Op |
|---|---|
| SOL balance | `getBalance` |
| SPL accounts | `tokenAccounts` |
| fresh blockhash | `latestBlockhash` |
| dry run | `simulate` |
| route price | `jupiter.quote` |
| unsigned swap tx | `jupiter.prepare` |

## Blockhash expiry is the trap

A Solana transaction carries a recent blockhash and dies in roughly 60–90 seconds.

Consequences that catch people:

- a transaction prepared two minutes ago is **dead** — re-prepare, don't retry
- do not prepare, go do other tool work, then hand it over
- if the user takes a while to approve, prepare again

An expired transaction fails with a confusing error that looks like a routing bug.
It isn't.

## Simulate every time

`simulateTransaction` is cheap and tells you the actual failure before the user
signs. There is no reason to skip it. Check:

- does it succeed at all
- compute units consumed (near the limit → it will fail under load)
- logs for the real revert reason

## Account creation costs rent

Swapping into a token the wallet has never held requires creating an associated
token account, which costs SOL rent. Budget it, and say so — a wallet with exactly
enough SOL for the swap will fail on the account creation.

## Decimals are not standard

Nine is common, six is common, others exist. Read the mint. Assuming decimals is how
an amount ends up 1000x off.

## Hard rules

1. **Simulate before returning any transaction for signature.**
2. **Never relay a caller-supplied RPC** — a hostile endpoint can lie about
   simulation.
3. **Return unsigned only.** Never a fully-signed transaction.
4. **Solana authority is separate from EVM authority.** No EVM key satisfies a
   Solana grant.
5. Name the **mint address**, not just the ticker.
6. Receipts or it didn't happen — confirmed signature or it failed.
