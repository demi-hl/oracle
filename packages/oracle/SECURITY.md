# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a live exploit.**

Email **security@demi.la** with:

- what the issue is
- how to reproduce it
- the impact you believe it has
- whether funds are at risk right now

You'll get an acknowledgement within 72 hours. If funds are actively at risk,
say so in the subject line and we'll treat it as urgent.

Please give us a reasonable window to ship a fix before public disclosure. We
will credit you unless you'd rather stay anonymous.

## Scope

In scope:

- custody-boundary escapes (public code reaching a signer or key material)
- destination-allowlist bypasses
- slippage/minimum-output guard bypasses
- grant forgery, replay, or scope escalation
- route/vault/order attestation forgery
- secret leakage through an API response or log
- fee-waiver misclassification or cross-user data access in an official hosted service
- Buzz capability forgery or audit-chain tampering

Out of scope:

- third-party provider outages and their rate limits
- economic risk inherent to a protocol you chose to trade
- issues that require the operator's own machine to already be compromised
- deployment hardening for an operator's separate private execution service

## Threat model

Oracle assumes the language model can be wrong or adversarially steered. The
model is treated as an untrusted proposer.

Consequences of that assumption, which are the invariants worth attacking:

1. **The public package never holds a key.** Signing happens in the user's
   wallet. Source-only operator modules are excluded from public entrypoints and
   the npm artifact.
2. **Model output is not authorization.** A grant is authorization, and a grant
   is signed by the owner, scoped, and expiring.
3. **Destinations are allowlisted per chain and fail closed.** An empty allowlist
   refuses everything. It never means "allow anything."
4. **Model-authored metadata is not trusted for routing.** Dynamic execution
   targets require an attestation minted inside the trusted boundary.
5. **Guards are recomputed at sign and broadcast time**, not just at quote time,
   because a stale minimum is not a minimum.
6. **The shipped public HTTP server is unauthenticated.** It is loopback-only and
   rate limited. A hosted service needs ordinary authentication and per-user isolation.

If you find a path where model-authored text becomes an authorized on-chain
action without an owner signature and a policy check, that is the bug we most
want to hear about.

## Enforcement in CI

`test/custody-boundary.test.mjs` walks the public import graph, and
`test/public-release-hardening.test.mjs` inspects the packed npm artifact. The
build fails if either public surface reaches wallet key material or a house
signer. The secret scanner also checks current files and Git history. CI runs
the boundary suite on every push and pull request.

A security claim that isn't enforced by a test is just a comment.

## Hosted and operator boundaries

These are not public-package custody holes. They are operator constraints that
still apply after the public boundary hardening:

1. **Owner-local signer modules live in private operator infrastructure.** The
   operator package is not published on npm and is not part of public or holder
   onboarding. Those modules and credentials must not be restored into this
   prepare-only package or its npm artifact. CI fails if a pack of *this* repo
   includes signer or vault paths.
2. **Prepare helpers that validate executable routes require an attestation
   secret** (`requireSigned`) so they cannot be used as a softer pre-broadcast
   gate than `enforceTxPolicy`.
3. **Live grants have a hard 24-hour ceiling.** Public grant validation with an
   explicit reference time and provider-neutral session grants reject a longer
   TTL. Deployments should choose a shorter lifetime whenever possible.
4. **Execution tool routing fails closed.** Sign, send, submit, and broadcast
   operations are owner-only. Unknown operations inside a signer/executor
   namespace also require owner send/execute intent; a new tool name does not
   silently become guest-accessible.
5. **Daily spend ledger locks are never reclaimed automatically.** An existing
   lock refuses broadcast, even when it appears stale. After verifying that no
   holder is active, an operator must remove a stale lock out of band. This
   sacrifices unattended recovery to avoid a stale-reclaimer ABA race that can
   defeat aggregate spend accounting.
6. **Action records are not chain proof.** `normalizeActionReceipt()` records
   caller-supplied public facts; `recordAudit()` is a process-local, best-effort
   file helper. Neither authorizes execution or proves settlement. Report
   success only after independently verifying the successful chain receipt,
   expected destination/events, and expected balance delta.
7. **Repository-host controls are not the custody boundary.** Dependabot alerts
   may be enabled independently, while branch protection, CodeQL, and hosted
   secret scanning depend on repository visibility and account tier. Verify the
   live settings; do not infer them from this document. The local CI boundary,
   packed-artifact, and secret-scan gates remain mandatory.
8. **Locals Only is fee policy, not admission.** Oracle access is public. The NFT
   only waives Oracle's integrator fee; hosted user isolation remains a separate
   deployment responsibility.
