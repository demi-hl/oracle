---
name: oracle-receipts
description: Use whenever reporting the outcome of any on-chain action. Enforces that a claim of success carries a hash, a receipt, and a balance delta.
---

# Receipts or it didn't happen

The failure mode this prevents: an agent says "done, swapped 0.5 ETH for USDC" when
the transaction reverted, was never broadcast, or landed with a different output
than promised. The user then acts on a false balance.

## The rule

A money-moving action is **complete** only when you can show:

1. **transaction hash** — the real one, from the broadcast response
2. **receipt status** — `1`. A receipt with status `0` is a *failed* transaction
   that still consumed gas; that is not success
3. **balance delta** — the output token balance actually changed, read back after
   the receipt
4. **the log** proving the intended event fired (`Swap`, `Transfer` to the right
   recipient, `OrderFilled`)

Missing any of the four → report what you have and call it incomplete.

## Language discipline

| Don't say | Say |
|---|---|
| "swapped" (before receipt) | "prepared" / "broadcast, awaiting receipt" |
| "done" | "receipt 1, balance +NNN USDC, hash 0x..." |
| "it should have gone through" | "unknown — no receipt yet" |
| "approved and swapped" | name each transaction separately |

**Preparing is not signing. Signing is not broadcasting. Broadcasting is not
confirmation.** Four distinct states; never collapse them in a report.

## Multi-step actions

An ERC-20 swap is at minimum two transactions: `approve` then the swap. Report each
separately with its own hash. If the approve landed and the swap reverted, the
honest report is "allowance set, swap failed" — not "swap failed" (the user now has
a live allowance they should know about).

For a raw-pair or multi-leg route: funding a pool is **not** a buy. Until the swap
call itself has a receipt, the tokens are sitting somewhere they can be taken.

## When it fails

Say what failed, the revert reason if you have it, and what you tried. Never
substitute a plausible-looking result for one you could not obtain. A reported
blocker is useful; an invented success is a loss.
