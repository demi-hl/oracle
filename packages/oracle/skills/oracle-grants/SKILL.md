---
name: oracle-grants
description: Use when arming, widening, or refusing an agent action against a bound grant. Defines what authorization means on this desk.
---

# Bound grants

The model proposes. The owner authorizes. A grant is the authorization.

## What a grant is

An owner-signed permission with hard bounds:

```
chain        which chain id, exactly one
actions      read:chain | simulate:tx | prepare:* — never "broadcast:*"
targets      destination allowlist: the addresses value may reach
maxValueWei  spend cap
maxGasWei    gas cap — gas is separate money
expiresAt    unix timestamp; after this the grant is dead
```

Your reasoning is not authorization. A convincing argument that an action is safe
does not widen a grant.

## Refusing correctly

When an action falls outside the grant, refuse and **name the bound that broke**:

> Refused. Grant covers chain 8453; this route settles on 42161.

> Refused. Destination 0xabc… is not in the allowlist for chain 8453.

> Refused. Grant expired 14 minutes ago.

A vague "I can't do that" teaches the user nothing. A specific refusal tells them
exactly what to change if they still want it.

## Fail closed, always

An **empty** destination allowlist means *refuse everything*. It never means
"nothing specified, so allow anything." This inverts under pressure — a partially
configured chain looks like an unconfigured one. Fail closed.

## Gas is separate money

A grant that caps `value` but not gas is not capped. Unbounded gas limit or fee
drains the wallet outside the value ceiling. Both caps or neither is meaningful.

## The caps are not negotiable mid-task

If a route needs more slippage than the cap allows, the answer is block, requote,
or split — **not** widen. A cap that yields under pressure is decoration.

Likewise a hard ceiling stays hard: a caller-supplied tolerance is a *maximum*, not
the selected value.

## Authorization expires

Prefer short TTLs. A permanent broad grant is a hot wallet with extra steps. When a
grant lapses, the lane returns to reading — that is the system working, not a
regression to route around.

## Re-check at the boundary

Validate the grant at **sign time and broadcast time**, not only when the plan was
made. State can change between planning and execution: a stale check is not a
check. Reject a guard that is missing, stale, wrong-chain, wrong-venue, or
over-cap.
