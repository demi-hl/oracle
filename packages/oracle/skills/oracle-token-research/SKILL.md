---
name: oracle-token-research
description: Use when researching any token, especially low-cap or newly launched. The sell-side-first checklist that catches honeypots.
---

# Token research

The default assumption for a new token is **hostile**. Research exists to disprove
that, not to confirm a story.

## Sell side first

Most losses here are not bad entries. They are tokens that **buy cleanly and cannot
be sold**. So the first question is never "will it go up" — it is "can I get out."

Run a **round-trip simulation** in one state-free call: wrap native → buy token →
sell token back → require a minimum return. Treat any of these as FAIL:

- quote failure in either direction
- transfer failure
- router revert
- round-trip return below the no-tax reverse quote by more than a small tolerance

A successful **buy** quote proves nothing about the sell.

## Price against the real pool

A launchpad or bonding-curve token often exposes its **own** `getReserves()`
returning zero or virtual values. The tradeable market is a *different* pair.

- `blockTimestampLast == 0` → not a live pool. Do not size against it.
- Find the real pair via `factory.getPair(a, b)` or a live swap's decoded target
- A pair with `kLast`, `price0CumulativeLast`, `MINIMUM_LIQUIDITY` is standard V2
  even when the router in front of it is a custom fork

Sizing against stale reserves is how a "0.4% impact" trade becomes 3%.

## Identity before action

Tickers collide and get squatted. A fuzzy name match is a **candidate**, never
confirmation.

Always surface the **contract address** and require explicit confirmation before
anything that moves value. `FEFUR` vs `FEFER` is a real class of loss.

## The rest of the checklist

| Check | Red flag |
|---|---|
| holder concentration | top 5 hold most of supply |
| liquidity depth | thin relative to your size |
| LP status | unlocked or removable |
| age | hours old with heavy volume |
| router | non-canonical clone with a familiar name |
| mint authority | still open |
| transfer logic | fees or blocks that change post-launch |

## Label your evidence

Mark every finding `LIVE`, `STALE`, `UNKNOWN`, or `UNAVAILABLE` with a timestamp.
Do not call holder-concentration analysis "bundle detection" — bundles require
launch-block clustering and common-funder evidence, which is a different query.

## Honest output

`unknown` is a correct and frequent answer about a two-hour-old token. Say it.
Never let narrative quality substitute for a passing sell simulation.
