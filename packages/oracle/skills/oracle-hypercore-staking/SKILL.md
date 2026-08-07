---
name: oracle-hypercore-staking
description: Stake, delegate, undelegate, and unstake HYPE on Hyperliquid HyperCore. Prepare-only, user wallet signs.
---

# HyperCore HYPE staking

Use when someone asks Oracle to stake HYPE, delegate to a validator, undelegate,
or unstake back to spot on Hyperliquid.

## The four moves, in order

HyperCore keeps staking in two buckets. Know which one holds the HYPE before
preparing anything.

| Move | Action | From -> To | Timing |
|---|---|---|---|
| Stake | `cDeposit` | spot -> staking balance | instant |
| Delegate | `tokenDelegate` isUndelegate=false | staking balance -> validator | 1 day validator lockup |
| Undelegate | `tokenDelegate` isUndelegate=true | validator -> staking balance | instant after lockup |
| Unstake | `cWithdraw` | staking balance -> spot | 7 day queue |

Staking balance earns nothing until it is delegated. "Unstake" almost always
means two steps: undelegate first, then withdraw.

## Flow

1. `desk.hl.staking.preflight(user)` - read delegated, undelegated, and pending
   withdrawal balances plus the queue and lockup constants.
2. `desk.hl.staking.validators()` - pick a validator. Reject jailed ones and
   surface commission before recommending.
3. Prepare exactly one move:
   - `desk.hl.staking.prepareStake({ amountHype, maxHype })`
   - `desk.hl.staking.prepareDelegate({ validator, amountHype, isUndelegate })`
   - `desk.hl.staking.prepareUnstake({ amountHype })`
4. Hand back the EIP-712 typed data. The user's wallet signs and submits.

## Rules

- Amounts are decimal HYPE strings at 8 decimals. `hypeToWei("1.5")` is
  `150000000`. More than 8 decimals is rejected, not rounded.
- `maxHype` is a hard cap checked before anything is built. No cap, no size
  discipline on an agent path.
- Never claim a stake happened. These functions return `broadcastReady: false`
  and `requiresUserSignature: true`. There is no submit function in the module
  on purpose.
- Warn about the 7 day unstaking queue every time you prepare a `cWithdraw`.
  The HYPE is illiquid for the whole queue.
- Warn about the 1 day validator lockup before a delegate.
- Check `undelegated` balance before preparing a withdraw. Withdrawing more than
  the undelegated bucket fails on chain, and the failure costs the user a round
  trip.

## Verification

`npm run e2e:hypercore-staking` hits live validator/delegator reads and asserts
every prepare path stays unsigned with caps enforced.
