---
name: oracle-circuit-breaker
description: Use before any repeated, automated, or loop-driven trading action. Mandatory guardrails so a broken loop cannot drain a wallet.
---

# Circuit breakers

A loop that trades is a loop that can lose money at machine speed. Every automated
or repeated action needs these before it runs once.

## Mandatory guardrails

1. **Max iterations.** A hard count, not a "should converge" argument. Loops that
   cannot terminate on their own must be terminated by the harness.
2. **Consecutive-failure stop.** N failures in a row halts the loop. A loop that
   retries a failing action forever burns gas to no effect.
3. **Cumulative spend ceiling** across the whole run, not per action. Twenty
   trades at the per-trade cap can exceed the intended risk by 20x.
4. **Cooldown between actions.** Prevents a same-block hammer and gives state time
   to settle.
5. **Kill switch checked immediately before each action**, not once at start. A
   switch read at t=0 and acted on at t=60s is stale.
6. **Halt on unexpected state.** Balance moved when it shouldn't have? Stop and
   report. Do not "adapt."

## Mid-run failure stops the run

If a multi-part action fails partway — leg 2 of 3, slice 4 of 10 — **stop**. Do not
continue to the remaining legs. The failure may mean the market moved, the route
went stale, or an approval was consumed. Continuing turns one bad fill into
several.

Report: what completed (with hashes), what failed, and the current position.

## Slippage is a cap, not a target

A supplied tolerance is the **maximum acceptable**, not the value to use. Compute
the guard from live depth and volatility per leg, immediately before broadcast. If
the required guard exceeds the cap, **block** — requote or split. Never widen to
force a fill.

## Paper before live

A strategy earns real size by producing a scorecard first. Shadow it, measure the
markout, then size. "It looked right in backtest" is not a scorecard.

## The bright line

An automated loop may **prepare**. A human authorizes what moves value, or a
narrowly scoped, short-TTL, spend-capped grant does. There is no third option
where the loop decides it has permission.
