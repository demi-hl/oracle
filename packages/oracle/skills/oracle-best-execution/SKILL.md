---
name: oracle-best-execution
description: Use whenever swapping or bridging. The rule that the highest quote is not the cheapest trade, and how to compare routes honestly.
---

# Best execution

The biggest `amountOut` is not the best route. Rank on **net received after gas and
fees**, every time.

## Get the comparison

```
best_swap_route   { chainId, tokenIn, tokenOut, amountIn, decimalsIn, decimalsOut }
best_bridge_route { fromChainId, toChainId, tokenIn, tokenOut, amountIn }
```

Or at a shell:

```bash
oracle-route swap   base <tokenIn> <tokenOut> [amountIn]
oracle-route bridge arbitrum base [token] [amountIn]
```

## Read the result properly

Report the winner **and** the runners-up. A user who sees only the winner cannot tell
whether it won by 0.01% or 3%, and that difference decides whether the route is worth
any extra risk.

Three fields carry most of the meaning:

- **`rankedOn`** — `net-of-cost` means gas was accounted for. `gross` means it was
  **not**, and the ordering may be wrong.
- **`costAccounted`** (per route) — `false` means that route's gas is unknown. It is
  ranked on gross, which **flatters it**. Say so.
- **`improvementBps`** — `null` means no honest spread exists, usually because the
  top two routes measure cost differently. Do not invent one.

## What to say

Good: *"ParaSwap nets 1903.88 USDC after $0.01 gas. CoW is 0.01% behind but gasless,
so on a larger size it likely wins. LI.FI quotes competitively but $4.78 of gas puts
it 0.5% down."*

Bad: *"Best route: LI.FI, 1899 USDC."* — that is the gross number, and it lost.

## Preparing the winner

`prepare_best_route` compares, then builds the signable artifact for the winner:

```
prepare_best_route { chainId, tokenIn, tokenOut, amountIn, taker }
```

`taker` must be the **real wallet that will sign**. Quoting is anonymous; preparing
is not. Placeholder and burn addresses are rejected.

**Check `artifactKind` before telling the user what to do.** They are not
interchangeable:

- `unsigned-transaction` (LI.FI, ParaSwap, 0x) — sign and **broadcast** it.
- `typed-data-order` (CoW) — sign the data and **submit it to the CoW API**. There is
  nothing to broadcast. Signing authorizes a solver to settle on your behalf.

**Approval comes first, and the spender is not always the destination.** For CoW the
approval goes to the *vault relayer*, not the settlement contract — approving the
wrong one produces an order that silently never fills. Read `requiresApproval.spender`
rather than assuming it equals `destination`.

Some venues refuse to build calldata until the approval already exists on-chain
(ParaSwap does). That surfaces as `failureKind: "approval-required-first"`, which is
a real ordering constraint, not a bug: approve, then prepare again.

If the winner has no prepare path, the result names an `alternative`. Say that the
winner could not be prepared and what you used instead — do not silently substitute.

**Read `driftBps`.** Prepare re-quotes, so this is how far the route moved since the
comparison. A large negative number means the ranking may no longer hold.

## Preparing a bridge

`prepare_best_bridge_route` — same idea, different hazards.

**`transactions` is always a list.** Some routes need an approval *and* a deposit,
signed in order. Tell the user how many and that order matters: signing only the
first leaves funds approved but not bridged.

**Two chains are in play.** Every transaction executes on `fromChainId`; the value
lands on `toChainId`. Report both. A prepared artifact whose transaction chain does
not match the origin is refused outright (`failureKind: "chain-mismatch"`).

**Bridging is not atomic — say so unprompted.** The origin transaction confirming does
**not** mean funds arrived. Give the `durationSeconds` estimate and tell the user not
to re-send while pending. This is the single most common bridging panic, and silence
here causes double-sends.

**Across quotes but cannot be prepared** in this build. It often wins on gross because
its gas is unreported, so expect `failureKind: "no-prepare-path"` with an
`alternative`. Say the winner could not be prepared and name what you used instead.

## Rules

**One answer is not a comparison.** If only one source responded, say the route is
unbenchmarked. `sourcesAnswered` vs `sourcesTried` tells you.

**Never present an unknown cost as zero.** A route missing gas data is not free; it
is unmeasured. Those are different claims and only one of them is true.

**Duration is a cost on bridges.** A route saving $2 that takes 30 minutes is not
strictly better than one costing $2 more that lands in 20 seconds. Surface both and
let the user choose — do not silently pick for them.

**Quotes decay.** Every number here is from a past block. Re-quote immediately before
preparing, and never carry a minOut computed from a stale quote into a signature.

**A comparison is not an execution.** Ranking a route does not prepare, sign, or send
it. Preparing is a separate step, and signing belongs to the user.

## When sources fail

Aggregators go down, rate-limit, and get sunset (Odos sunset its public API in
July 2026). Individual failures are expected and appear in `failed[]`. Two things
follow:

1. Fewer sources means a weaker comparison. Report `sourcesAnswered`, do not hide it.
2. A failing source is **not** a bad price. Never rank it last — it did not answer.
