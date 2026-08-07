---
name: balance
description: Use when the user says balance, holdings, portfolio, wallet balance, or invokes /balance. Call the deterministic read-only multichain portfolio tool and report coverage honestly.
---

# Balance

Use `portfolio_snapshot` for every fresh balance request. It runs the deterministic
multichain balance and NFT inventory reads once, then records one compact local
observation so the user can build history without a separate tracker.

Use `portfolio_history` for balance-history requests and `portfolio_value_graph`
for charts. Use `portfolio_balance` only when the user explicitly asks for a
non-recorded read or when local history storage is unavailable.

This skill is read-only. Public addresses are identifiers, not signing rights.
Never request a private key, seed phrase, wallet export, session key, or signature.

## Trigger

Run this workflow when the user:

- invokes `/balance`;
- says `balance` by itself;
- asks for holdings, wallet balance, portfolio, net assets, or assets across chains;
- supplies one or more public wallet addresses and asks what they hold.

## Address routing

Parse only public addresses supplied with the request:

- `0x...` maps to `addresses.evm` and `addresses.hyperliquid` unless the user
  explicitly assigns different addresses;
- a Solana base58 public key maps to `addresses.solana`;
- a Bitcoin `bc1`, `1`, or `3` address maps to `addresses.bitcoin`;
- explicit labels such as `evm:`, `solana:`, `bitcoin:`, and `hyperliquid:` win.

If no addresses are in the request, call `portfolio_snapshot` with an empty object.
The tool uses configured public-address defaults:

- `ORACLE_EVM_ADDRESS`, with legacy fallback `ORACLE_DEFAULT_ADDRESS`;
- `ORACLE_SOLANA_ADDRESS`;
- `ORACLE_BITCOIN_ADDRESS`;
- `ORACLE_HYPERLIQUID_ADDRESS`, with EVM fallback.

If every family returns `not-configured`, ask only for the missing public addresses.
Do not call a zero address a user wallet and do not report missing families as zero.

## Mandatory call

Call `portfolio_snapshot`:

```json
{
  "addresses": {
    "evm": "optional public address",
    "solana": "optional public key",
    "bitcoin": "optional public address",
    "hyperliquid": "optional public address"
  },
  "includeTokens": true,
  "includeCollectibles": true,
  "includePrices": true,
  "includeNfts": true
}
```

Omit address fields the user did not supply. Omit `evmChainIds` unless the user
asks for a subset. The default queries every configured EVM chain. Read fungible
and chain details from `result.balance`, NFT holdings from `result.nfts`, and the
combined historical observation from `result.snapshot`.

Never call a chain write, prepare, sign, send, submit, execute, or broadcast tool
while answering a balance request. The compact profile-local history append made
by `portfolio_snapshot` is allowed and contains no keys or executable payloads.

## Coverage contract

The current aggregator covers:

- native balances on every configured EVM chain;
- Solana SOL plus SPL Token and Token-2022 accounts;
- Bitcoin BTC plus Runes and inscriptions when an address indexer is configured;
- Hyperliquid HyperCore spot balances and perp account state;
- OpenSea-supported EVM/Solana NFT inventory and Bitcoin inscriptions where the
  configured providers expose owner data;
- profile-local snapshots and an SVG known-value history graph.

It must explicitly report unsupported or unavailable surfaces:

- EVM token and NFT enumeration is unavailable without an address indexer;
- Solana token accounts are unverified until metadata confirms symbol and spam
  status;
- a Solana amount of one with zero decimals is only a collectible candidate;
- Bitcoin Runes and inscriptions require an address-indexed provider;
- Cosmos requires a chain-specific bech32 address and LCD/RPC adapter;
- Sui and Aptos remain unsupported until their balance adapters are installed;
- any provider failure is `unavailable`, never a zero balance;
- NFT prices are provider estimates, not executable bids.

## History and graph

For “balance history”, “portfolio history”, or a date range, call
`portfolio_history` with the same public addresses and the requested `since`,
`until`, and `limit`. Keep `null` values unavailable. Do not interpolate them.

For “graph”, “chart”, or “show me performance”, call `portfolio_value_graph`.
State the returned `summary.changeUsd`, `summary.changePct`, point count, and
whether any plotted snapshots were incomplete. The image plots known priced
value, not guaranteed liquidation value or net worth.

## Response format

Start with:

```text
Balance, <queriedAt>
Known priced value: $<knownUsd>  (not a complete total)
Coverage: <ok>/<requestedSurfaces> surfaces live
```

If `valuation.complete` is true, you may remove the parenthetical. Do not rename
`knownUsd` to `total`, `net worth`, or `portfolio value` when coverage is partial.

Then show nonzero assets first, grouped by family:

```text
EVM
Ethereum: 0.42 ETH  $...
Base: 18.1 ETH  $...

Solana
SOL: ...
SPL: <mint>  <amount>  unverified

Bitcoin
BTC: ...
Runes: ...
Inscriptions: ...

Hyperliquid
Spot: ...
Perps account value: $...
Positions: ...
```

Collapse successful zero-native EVM chains into one line:

```text
Zero native: Polygon, Optimism, Arbitrum
```

End with concise exceptions:

```text
Unavailable: <failed providers or unconfigured addresses>
Unpriced: <nonzero assets without a price>
Warnings: <spam, stale, unknown-not-empty, or incomplete discovery warnings>
```

Do not dump raw RPC payloads unless the user asks. Keep exact public addresses in
the response only when the user supplied multiple addresses and disambiguation is
necessary.

## Truth rules

- `0` means a provider successfully returned zero.
- `unavailable` means the provider failed or the adapter is absent.
- `not-configured` means the public address is missing.
- `unknownNotEmpty` means the provider cannot tell whether assets exist. Never
  convert it to an empty portfolio.
- Every USD figure must carry a price source and query timestamp in the tool
  result.
- Do not sum Stable Mainnet native USDT0 with its mirrored ERC-20 representation.
- Do not price unverified or spam tokens by symbol alone.
- Do not hide failed chains to make the summary look complete.
