# Architecture

Three planes. The boundary between them is enforced by a test, not a convention.

```
                    user's wallet
                         ^
                         | signs (only the user can)
                         |
   +---------------------+---------------------+
   |            unsigned artifacts             |
   |                                           |
   |  PUBLIC (this repo)                       |
   |                                           |
   |  data plane      read / quote             |
   |  policy plane    allowlists, guards,      |
   |                  attestations, grants     |
   |  control plane   grant lifecycle,         |
   |                  session keys, AA, router |
   +-------------------------------------------+
                         |
                         x  no import may cross
                         |
   +-------------------------------------------+
   |  OWNER-LOCAL (private infrastructure)     |
   |  separately installed by the owner        |
   |  key-vault / hl-exec / oracle-vault       |
   +-------------------------------------------+
```

## Why three planes

The design assumption is that **the model can be wrong or adversarially steered**.
Everything follows from treating it as an untrusted proposer.

If the model is untrusted, then authorization cannot come from the model. It comes
from an owner signature over a bounded grant. And if authorization is separate from
proposal, then the code that proposes must be unable to reach the code that signs —
otherwise the separation is aspirational.

That is why the boundary is a test (`test/custody-boundary.test.mjs`) rather than a
paragraph in a README. It walks the import graph from every shipped entrypoint and
fails on:

- any public module importing signer or key material
- a dangling local import that reaches a signer from a shipped entrypoint
- a secret-shaped literal anywhere
- a packed npm artifact that still contains signer/vault modules

## Data plane

`src/data/` — 42 provider modules covering 219 unique protocols/venues, each
declaring an honest tier. One module can cover many protocols: the Jupiter
module alone routes 98 Solana venues.

| Tier | Meaning |
|---|---|
| `read-only` | data only; no execution claim |
| `quote-only` | can price a route; no reviewed transaction builder |
| `prepare` | returns a policy-bound unsigned transaction |
| `intent` | returns typed data to sign (CoW orders, GMX orders) |

The tier is load-bearing. "We support protocol X" is ambiguous and has caused real
confusion; the tier is not. **API coverage ≠ execution support.**

`src/data/catalog.mjs` is the registry; `dataHealth()` probes liveness. Note the
distinction in health output: a promise that resolved with `{ok: false}` is
*degraded*, not healthy — and an HTTP 200 serving an explorer error page is not a
successful read.

## Policy plane

The moat. Holds no keys; constrains what a signer may be asked to do.

- **Destination allowlist** (`src/venues.mjs`) — per chain, fail-closed. An empty
  allowlist refuses everything. It never means "allow anything."
- **Auto-slippage** (`src/auto-slippage.mjs`) — a guard computed from live depth and
  volatility per leg, recomputed before each broadcast. A caller-supplied tolerance
  is a *maximum*, not the selected value. Hard ceiling 100 bps; over that, block and
  requote rather than widen.
- **Attestations** (`route-`, `vault-`, `gmx-attestation.mjs`) — dynamic execution
  targets require an attestation minted inside the trusted boundary. Model-authored
  JSON is not authorization.
- **Approval guard** — exact-amount approvals, never unlimited by default, with
  allowance read back after the approve lands.

Guards are re-checked at **sign and broadcast** time. A stale minimum is not a
minimum.

## Control plane

`src/public-control/` — grant schema and rendering, session-key model, ERC-4337
adapter, bundler client, grant indexer.

`src/router/` — model routing with a custody firewall. `risk-classifier.mjs` scores
an action's risk; `proposal.mjs` refuses to construct a proposal containing
dangerous fields (private keys, mnemonics, bearer tokens) at any nesting depth. The
router can propose, simulate, explain, and draft. It cannot authorize.

## Scanner framework

`src/scanner/` — makes a chain data rather than an integration.

- `contract.mjs` — 10 capabilities, a validator, a registry, coverage matrix
- `evm-scanner.mjs` — one generic implementation for any EVM JSON-RPC chain
- `chains.config.mjs` — the 11 built-ins as config, plus `registerCustomChain()`

Unimplemented capabilities are **absent, not faked**: calling one throws a message
naming what *is* supported. A caller can never mistake `undefined` for a negative
result.

Evidence labels (`LIVE` / `CACHED` / `STALE` / `UNKNOWN` / `UNAVAILABLE`) and risk
verdicts (`PASS` / `CAUTION` / `FAIL` / `UNKNOWN`) exist to stop the collapse that
causes losses: **`UNKNOWN` is not `PASS`**, and "we could not check" is a different
fact from "there is nothing there."

## Agent mesh

`profiles/` + `skills/` — seven installable Hermes lanes plus a template.

A lane is narrow on purpose: smaller context is cheaper and more accurate, per-lane
memory doesn't cross-contaminate, and a grant scoped to one lane can't be spent by
another.

Every lane ships DISARMED, and every grant action a lane may request is read,
simulate, or prepare. No lane may request broadcast or signing — enforced in
`test/profiles.test.mjs`, so widening custody cannot pass review quietly.

No lane pins a model. `profile.json` carries a capability *class*
(`strong-reasoner`, `fast-tool-caller`), so the installer never writes a vendor into
a user's config.

## What is not in the public package

House custody, an always-on exec server, and capability minting are not shipped.
Owner-local signer modules (`key-vault`, `hl-exec`, `oracle-vault`) live only in
separately installed private infrastructure on the owner's machine. They are not
published on npm or available to holder installs. This prepare package has
nothing to steal: it never takes a key and never broadcasts.
