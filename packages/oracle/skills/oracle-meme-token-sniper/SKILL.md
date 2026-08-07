---
name: oracle-meme-token-sniper
description: Scan and prepare guarded meme-token launch/sniping trades across configured chains; fail-closed, user-signed, sell-sim first.
---

# Oracle meme-token sniper

Use when a user asks Oracle to find, monitor, or prepare buys for meme tokens,
new launches, liquidity adds, bonding curves, or "snipe" opportunities on any
supported chain.

## Scope

Oracle may scan every configured venue/chain for meme-token launch signals:

- EVM factory/pair/pool creation logs across configured chains.
- Liquidity additions, first swaps, tax/owner-risk changes, holder distribution.
- Solana SPL/token-launch feeds and Jupiter-route availability when configured.
- Chain-specific launchpads/bonding curves only after the venue is verified.
- Smart-wallet early-entry overlap and repeat deployer history.

Unsupported chain/venue means `UNAVAILABLE`, not fake coverage. A chain with no
verified executable route can still be analyzed, but cannot be prepared for buy.

## Required gate before any prepared buy

1. Resolve exact chain, token mint/contract, pool, quote asset, router/venue.
2. Verify token identity from live chain data, not only a ticker/social link.
3. Check deployer/owner controls, mint/freeze/blacklist/tax/proxy risks where
   the chain exposes them.
4. Confirm liquidity exists and is not only a fake/self pool.
5. Run sellability / reverse-route simulation when the chain/venue supports it.
6. Quote fresh, net of gas, and bind slippage/deadline to the prepared artifact.
7. Enforce user caps: per-trade spend, chain, venue, token, max fee, and TTL.
8. Return unsigned/user-signable transaction only. No model-authored calldata
   bypass, no raw user calldata, no backend custody by default.

## Autonomous mode

Autonomous meme sniping is allowed only as a capped local-user signer loop:

- separate burner/session key, never main wallet
- explicit user opt-in and scope
- max spend per token and per day
- denylist/allowlist support
- retry ceiling and kill switch
- first-run paper/shadow mode
- receipt/balance reconciliation after every fill

Default public posture is advisory/prepare-only. "Snipe" in UI copy means fast
scan + prepared ticket; it does not mean blind broadcast.

## Output contract

For every candidate, return:

- `chain`, `token`, `pool`, `venue`
- `signal`: launch/liquidity/smart-wallet/social/etc.
- `risk`: PASS/WARN/BLOCK/UNKNOWN with evidence
- `sellability`: PASS/FAIL/UNKNOWN/UNAVAILABLE
- `route`: quote source and freshness
- `prepared`: true only if a guarded unsigned artifact exists
- `whyBlocked` when not prepared

## Pitfalls

- Treating ticker match as identity.
- Buying before sell-sim/reverse-route proof.
- Using scanner membership as an execution allowlist.
- Calling a launchpool real when reserves are virtual/stale.
- Ignoring gas: on small meme trades, gas can dominate edge.
- Letting "every chain" become "every venue is executable". Coverage must be
  capability-labeled per chain.
