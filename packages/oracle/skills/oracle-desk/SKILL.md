---
name: oracle-desk
description: Use when routing a crypto request to the right lane or comparing options across chains. The router's operating manual.
---

# Routing the desk

## Decide the lane before doing the work

Every crypto request gets a routing decision first:

1. **Which chain?** If the request names a token but not a chain, resolve the
   token's home chain (DexScreener search via the data plane). Do not guess.
2. **Which lane owns it?** Venue lanes own their venue. Cross-chain comparison is
   yours.
3. **Is it multi-chain?** Then quote each option yourself and synthesize. Do not
   ask one venue lane to opine on another's chain.
4. **Still ambiguous?** Ask. A wrong chain assumption produces confidently wrong
   numbers.

## Comparing chains honestly

When asked "which is cheaper" or "where should this go," the comparison must be
like-for-like:

- quote the **same notional** on each chain, not the same token amount
- include **gas in the same unit** (USD), because 0.001 ETH means different things
  on mainnet and an L2
- include **bridge cost and time** if the funds aren't already there
- include **price impact at that size**, not the headline mid
- note **liquidity depth** — the cheapest venue at $100 is often not cheapest at
  $50k

A comparison that ignores bridging or impact is a wrong answer dressed as a table.

## Capability tiers are not interchangeable

The data catalog labels each provider honestly. Respect the label:

| Tier | Means |
|---|---|
| `read-only` | data only, no execution claim whatsoever |
| `quote-only` | can price a route; no reviewed transaction builder |
| `prepare` | returns a policy-bound unsigned transaction |
| `intent` | returns a typed-data order to sign, not a transaction |

**API coverage ≠ execution support ≠ live trading support.** When asked "can we
trade X," answer with the tier, not yes/no.

## Don't invent chain facts

If a number did not come from a live read this turn, it is `unknown`. Not "roughly,"
not "typically." Stale liquidity and stale gas are how people get filled badly.

## Synthesis

Lead with the recommendation and the number. Then the two or three facts that drove
it. Then the risk that would change the answer. State confidence explicitly.
