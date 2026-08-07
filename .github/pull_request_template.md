## What and why

<!-- What changed, and what problem it solves. Link an issue if there is one. -->

## Verification

<!--
Paste REAL output. "Tests pass" is not verification; the output is.
At minimum: npm test. For a provider or chain, a live read.
-->

```
$ npm test

```

## Custody boundary

<!-- Delete the line that does not apply. -->

- [ ] This change does **not** touch the custody boundary.
- [ ] This change touches the custody boundary, and here is why it is still safe:

Reminder of the invariant: public modules may not reach wallet key material or a
house signer. `test/custody-boundary.test.mjs` enforces it by walking the real
import graph. If it fails, the fix is almost never to edit the forbidden list — it
is to restructure so the module hands back an *unsigned* artifact.

## Checklist

- [ ] `npm test` green on a clean checkout
- [ ] No secret, private key, mnemonic, API key, or RPC URL added (including in
      tests and fixtures — use `src/data/quote-placeholder.mjs` for a default
      quote address, never a real wallet)
- [ ] Capability tiers are honest: a provider that can only quote is marked
      `quote-only`, not `prepare`
- [ ] Any new venue address records how and when it was verified
- [ ] New guards are re-checked at sign/broadcast time, not only at quote time
- [ ] Tests assert invariants rather than freezing today's values
