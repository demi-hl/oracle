# Contributing to Oracle

Thanks for looking. Oracle is a control plane for money movement, so the review
bar is about safety and honesty more than style.

## Before you start

Run the suite:

```bash
npm install
npm test
```

391 tests, all green. If they aren't green on a clean checkout, that's a bug —
please report it.

## The one rule that matters

**The public plane may never reach a private key or a house signer.**

Oracle ships the data plane, the policy plane, and the control plane. It does not
ship the executor. A PR that imports signer or keystore code into public modules
will fail `test/custody-boundary.test.mjs`, and the fix is not to edit the
forbidden list.

If your feature seems to need a key, restructure it: build an unsigned
transaction or a typed-data intent and hand it back to the caller to sign.

## What we want

- **Real bugs, fixed at the class level.** Reproduce it, point at the line, fix
  every sibling call path — not just the one that was reported.
- **New chains and providers.** This is the most useful contribution. See below.
- **Honest capability tiers.** If a provider can only quote, mark it
  `quote-only`. Do not mark it `prepare` because a prepare function exists but
  was never validated against a live route.
- **Tests that assert invariants**, not snapshots. `assert` that a minimum output
  is enforced; don't freeze today's provider list into an equality check.
- **Guards recomputed before signing.** A quote-time check that isn't re-verified
  at broadcast is decoration.

## What gets rejected

- A signer, private key, or house-custody path in the public tree.
- A destination allowlist that defaults to permissive, or an empty allowlist read
  as "allow all."
- Slippage widened past the 100 bps cap to make a trade go through. Block,
  requote, or split instead.
- A claim of execution support with no live prepare/simulate evidence.
- Secrets in code, tests, fixtures, or docs — including a real wallet address as
  a default `from` for quotes. Use `src/data/quote-placeholder.mjs`.
- "It worked when I ran it" with no test.

## Adding a provider

1. Create `src/data/providers/<name>.mjs`.
2. Export a `health()` plus the ops you actually implement.
3. Register it in `src/data/catalog.mjs` with truthful `chainIds`, `auth`, `ops`,
   and `execution` tier.
4. Add a test with a mocked transport. Do not require a live network for CI.
5. If it needs a key, the health check must report
   `{ ok: false, configured: false }` rather than throwing.

## Adding a chain

1. Add an entry to `CHAINS` in `src/chains.mjs` with its `rpcEnv` names.
2. Verify every router/venue address on-chain (`eth_getCode` must return real
   bytecode) before adding it to `src/venues.mjs`.
3. Comment each venue addition with how you verified it and when.
4. An unverified chain stays fail-closed. That is a safe state, not a gap.

Never allowlist a router you found only in a blog post or a model's answer. The
destination allowlist is the highest-leverage control in the system.

## Commits and PRs

Conventional prefixes: `fix:`, `feat:`, `refactor:`, `docs:`, `test:`, `chore:`.

In the PR body, state:

- what broke or what's new
- how you verified it (paste the real command output)
- whether anything touches the custody boundary

Small, reviewable PRs get merged. A 3000-line PR mixing a refactor with a policy
change will sit.

## Style

- ES modules, Node 20+, no build step.
- No new runtime dependency without a reason in the PR description.
- Comments explain *why*, not *what*. If a line encodes a hard-won fact — a
  provider's unit quirk, a revert cause — say so, and say how it was learned.

## License

Contributions are accepted under the repository's then-current outbound license in [LICENSE](LICENSE). Current source is BUSL-1.1; npm releases `0.1.0` through `0.11.0` remain Apache-2.0.
