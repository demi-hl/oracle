---
name: oracle-polymarket
description: Use for Polymarket prediction markets — event pricing, books, and resolution risk via the public CLOB and Gamma APIs.
---

# Polymarket

Read through Oracle's data plane (`poly-public` provider: CLOB + Gamma REST, no
key). Settles on Polygon (137).

## Ops

| Need | Op |
|---|---|
| market list | `markets` |
| events | `events` |
| order book | `book` |
| midpoint | `midpoint` |
| spread | `spread` |
| last price | `price` |

## A price is not a probability

0.62 means the last trader transacted there — net of fees, liquidity constraints,
and whoever is hedging an off-platform position. Before treating it as a forecast:

- **depth** — 0.62 on $40 of size carries no information
- **spread** — wide means nobody defends an opinion
- **time to resolution** — a 3-day market and a 3-month market at the same price
  are not saying the same thing
- **fee drag** — round-trip costs eat thin edges

## Resolution text is the real risk

The most expensive mistake here is not mispricing probability. It is being *right*
about the world and *wrong* about the resolution criteria.

Read the rules before discussing edge. Flag:

- ambiguous wording that could settle against the consensus reading
- who resolves it and on what source
- what happens on an edge case, a delay, or a cancelled event
- whether the market can resolve early

If the rules could plausibly settle the "obviously right" side as a loss, that is
the headline, not a footnote.

## Correlated markets

Related markets often disagree. A set of outcome prices summing well past 1.00 is
either a fee/liquidity artifact or a genuine inconsistency. Check the sum before
calling something mispriced.

## Hard rules

1. Read the resolution criteria before discussing edge.
2. Never present a market price as your own forecast without saying which you mean.
3. Quote depth alongside price.
4. You prepare; the user's wallet signs.
5. Receipts or it didn't happen.
