# Adding a chain

Oracle treats a chain as **configuration**. You do not write an integration.

## The short version

```js
import { registerCustomChain } from "@oracle-agent/oracle/scanner";

registerCustomChain({
  key: "mychain",
  chainId: 7777,
  name: "My Chain",
  rpcEnv: ["MYCHAIN_RPC_URL"],
  nativeCurrency: { symbol: "MYC", decimals: 18 },
});
```

That chain now has block reads, native and ERC-20 balances, on-chain token
resolution, log scanning, and structural risk checks. No code was written.

```bash
export MYCHAIN_RPC_URL=https://rpc.mychain.example
oracle-scan head mychain
```

## Config fields

| Field | Required | Notes |
|---|---|---|
| `key` | yes | lowercase slug, used on the CLI |
| `chainId` | yes | positive integer |
| `name` | yes | display name |
| `rpcEnv` | yes | env var names, `UPPER_SNAKE`. Never a literal URL |
| `nativeCurrency` | no | `{ symbol, decimals }` |
| `explorer` | no | base URL |
| `dexscreenerSlug` | no | enables pool discovery — see below |
| `venues` | no | verified routers/quoters — required for routing value |

**RPC URLs live in the environment, never in config.** A repo carrying an endpoint
is both a leak and a rate-limit problem for whoever else uses that key.

## Why `dexscreenerSlug` matters

Pool discovery goes through market data rather than walking a factory. A factory
walk finds pools that *exist*; a trader needs pools with *liquidity*.

The slug is DexScreener's own chain identifier — not the chain id, and not always
the obvious name. If you don't know it, **leave it out**. Pool discovery then
reports `UNAVAILABLE`, which is honest. A wrong slug silently returns another
chain's pools, which is worse than no answer.

## Adding venues (routing value)

A chain with no verified venue is **fail-closed**: read and research work, routing
value does not. That is a safe default, not a gap.

To enable routing you must record *provenance*:

```js
venues: [
  {
    kind: "router",
    address: "0x...",
    verified: {
      method: "eth_getCode + protocol /chains API",
      source: "https://li.quest/v1/chains",
      date: "2026-07-30",
    },
  },
]
```

Validation **refuses** a venue without `verified`. This is not bureaucracy: the
destination allowlist is the highest-leverage control in the system, and
allowlisting a spoofed router makes every other guard irrelevant.

### How to actually verify

1. **Bytecode exists** — `eth_getCode` must return real code. `0x` means nothing is
   deployed at that address on that chain.
2. **The protocol's own API or docs** names that address, for that chain, today.
   Query the source (e.g. LI.FI's `/v1/chains` returns each chain's official
   `diamondAddress`) rather than trusting a blog post or a model's recollection.
3. **Constructor-bound addresses match** — read `factory()`, `WETH9()` back off the
   deployed contract and confirm they're what you expect.
4. **Per chain, separately.** An address verified on Arbitrum is not verified on
   Ethereum, even when the canonical deployment shares an address across chains.

Record how and when. The audit trail has to outlive your session.

## Capabilities

Ten capabilities exist. The generic EVM scanner provides seven out of the box:

| Capability | Generic? | Why |
|---|---|---|
| `blockNumber` | yes | standard RPC |
| `nativeBalance` | yes | standard RPC |
| `tokenBalance` | yes | ERC-20 is ERC-20 |
| `resolveToken` | yes | reads metadata off the contract |
| `resolvePools` | yes* | needs `dexscreenerSlug` |
| `scanBlocks` | yes | chunked `eth_getLogs` |
| `scoreRisk` | yes | structural checks |
| `quote` | venue | needs a verified router |
| `sellSimulation` | venue | needs a verified router |
| `prepareUnsignedTx` | venue | needs a verified router |

Calling an unimplemented capability **throws**, naming what is supported. It never
returns `undefined` that a caller could mistake for "no result."

## Enabling quote / sell / prepare

Add a verified router plus two fields:

```js
{
  key: "base",
  chainId: 8453,
  // ...
  venueKind: "uniswap-v2",
  wrappedNative: "0x4200000000000000000000000000000000000006",
  venues: [{ kind: "router", address: "0x...", verified: { /* ... */ } }],
}
```

`src/scanner/chains.config.mjs` ships **Base** wired this way as the reference. It
gets all 10 capabilities; every other built-in stays at 7 and fail-closed until
someone verifies a venue for it.

What you get:

- **`quote`** — live exact-input pricing via `getAmountsOut`
- **`sellSimulation`** — a state-free round trip (buy then sell back) that catches
  the honeypot signature: buy leg quotes fine, sell leg fails. This is the single
  most valuable check on a low-cap venue, because most losses are not bad entries
  but tokens that cannot be exited
- **`prepareUnsignedTx`** — an **unsigned** swap with a `minOut` computed from the
  live quote, a deadline, and an explicit `approve` step listed separately so
  "approved" and "swapped" are never collapsed into one claim

`scoreRisk` also upgrades automatically: with a router it reports real sellability
instead of `UNKNOWN`.

### The slippage ceiling is hard

A supplied `slippageBps` is a **maximum**, capped at 100 bps. Above that,
`prepareUnsignedTx` throws rather than widening:

```
slippageBps 250 exceeds the 100 bps ceiling. Block and requote or split
the order -- do not widen the guard to force a fill.
```

A cap that yields under pressure is decoration.

### V3 / V4 / custom quoters

Two adapters ship:

| `venueKind` | Requires | Prices via |
|---|---|---|
| `uniswap-v2` | `router` | `getAmountsOut` on the router |
| `uniswap-v3` | `quoter` **and** `router` | `quoteExactInputSingle` on QuoterV2 |

V3 is **not** V2 with different addresses: it has no `getAmountsOut`, prices through
a separate Quoter contract, and needs an explicit fee tier per hop. Encoding a V3
swap with V2 assumptions yields a transaction that reverts, or worse routes through
the wrong pool. That is why they are sibling adapters.

The V3 adapter searches all four fee tiers (100 / 500 / 3000 / 10000) and keeps the
best. This is necessary, not a nicety — liquidity concentrates in one tier and which
tier varies by pair and chain. On Arbitrum WETH→USDC the 500 tier returns ~2.4% more
than the 100 tier; defaulting to 0.3% because it is the common choice silently
misprices stable and exotic pairs alike.

A V3 chain needs **both** a quoter and a router. A router alone stays fail-closed:
it could encode a swap, but with no priced expectation to guard against — exactly
the state that produces an unbounded fill.

**V4 and custom-quoter venues still need their own adapter.** Some forks require an
off-chain signed quote you cannot produce locally. Write a sibling module rather
than bending an existing one; silently mis-encoding a swap is far worse than
declaring the capability unsupported.

### Verifying a venue: run the prober

`scripts/verify-v3-venues.mjs` probes candidate addresses on every chain and prints
a pass/fail with the live price it got:

```bash
node scripts/verify-v3-venues.mjs
```

**Codesize is not verification.** The canonical mainnet QuoterV2 address returns
2109 bytes of bytecode on Base — it is *some* contract, just not a working quoter
for that chain. A codesize check waves it through; the functional probe caught it
and pointed at Base's real quoter (8273 bytes, prices WETH→USDC correctly).

The rule: **a contract that correctly prices a pair you can sanity-check IS the
thing you think it is.** Anything less is a guess with an address attached.

## Honest evidence

Every finding carries a label. Respect the distinction:

- `LIVE` — read this call
- `CACHED` — recent, within stated TTL
- `STALE` — older than TTL; usable only with the caveat stated
- `UNKNOWN` — we tried and could not determine it
- `UNAVAILABLE` — this chain/provider cannot answer at all

`UNKNOWN` and `UNAVAILABLE` are different facts. Collapsing them is how people end
up sizing against stale reserves.

Risk verdicts are coarse on purpose — `PASS` / `CAUTION` / `FAIL` / `UNKNOWN`. A
score like "risk 62/100" invites trading a number nobody understands.

**`UNKNOWN` is not `PASS`.** The generic scanner returns `UNKNOWN` for sellability
because it cannot prove exitability without a verified router. A token is not
tradeable until a round-trip sell simulation succeeds.

## Contributing a chain upstream

Append to `CHAIN_CONFIGS` in `src/scanner/chains.config.mjs` and open a PR. Tests
already assert every built-in config validates and that none embeds an RPC URL, so
CI will catch a malformed entry.

If you add venues, put the verification method and date in the PR body.
