---
name: oracle-multichain-token-launch
description: Use when planning, building, reviewing, or preparing a fungible token launch on EVM, Solana, Bitcoin Runes, Cosmos, Move, Hyperliquid, or another chain family. Fail closed on unsupported adapters; prepare and simulate only; the user signs each side effect.
---

# Multichain token launch

## Contract

Use this skill for fungible asset creation, initial distribution, public sale setup,
and liquidity bootstrap preparation.

"Every chain" means route the request to a verified chain-family path. It does not
mean one bytecode artifact or one transaction encoder works everywhere. Never call
a chain launch-ready because its RPC responds.

Oracle researches, scaffolds, validates, simulates, and prepares unsigned actions.
The user signs deployment, mint, metadata, authority, liquidity, and verification
actions separately. Never broadcast from this skill.

When loaded by the `oracle` router, use this skill to classify the request, then
route chain research to the relevant specialist and build/prepare work to
`protocol-builder`. The router remains read and simulate only.

## Support status language

Use exactly one status before building:

| Status | Meaning |
|---|---|
| `TEMPLATE_READY` | Oracle ships a gated template and unsigned prepare path for this exact standard. |
| `ADAPTER_READY` | A chain-specific encoder exists and passed live simulation or testnet verification. |
| `GUIDED_BUILD` | Oracle can scaffold and test it, but no generic transaction adapter is shipped. |
| `RESEARCH_ONLY` | Oracle can verify chain mechanics and produce a launch plan, not a deployable bundle. |
| `UNSUPPORTED` | Required chain primitives or trustworthy tooling cannot be verified. Stop. |

Do not upgrade a status without evidence. A compiler pass alone is not
`ADAPTER_READY`. A mainnet-ready claim needs exact chain identity, final artifacts,
simulation, fee estimate, and source/program verification path.

## Current family matrix

| Family | Common standards | Default status | Required path |
|---|---|---|---|
| EVM | ERC-20 | `TEMPLATE_READY` only for Oracle `safe-erc20`; custom tax, mint, proxy, or hook designs are `GUIDED_BUILD` | Foundry gate, chain-id proof, unsigned deploy, source verification |
| Solana | SPL Token, Token-2022 | `GUIDED_BUILD` | Select extensions explicitly, construct unsigned transactions, simulate, user wallet signs |
| Bitcoin | Runes | `RESEARCH_ONLY` until an etch adapter is present | Commit/reveal plan, UTXO and fee model, exact terms review |
| Cosmos | tokenfactory, CW20 | `RESEARCH_ONLY` by default | Resolve the chain's module or CosmWasm messages; EVM-enabled Cosmos chains use the EVM path only when verified |
| Sui | Coin, regulated coin primitives | `RESEARCH_ONLY` by default | Move package, treasury capability model, devnet/testnet publish first |
| Aptos | Coin, Fungible Asset | `RESEARCH_ONLY` by default | Move module/object model, upgrade policy, testnet publish first |
| Hyperliquid L1 | spot asset deployment | `RESEARCH_ONLY` | Verify current native deployment/auction process; HIP-3 is a market deployment, not a generic token contract |
| HyperEVM | ERC-20 | EVM status | Use the exact HyperEVM chain id and verified gas/DEX addresses |
| Other | chain-native | `UNSUPPORTED` until classified | Add and verify a dedicated adapter before preparing transactions |

This matrix is the minimum truth bar, not a marketing ceiling. If a verified adapter
lands later, update its status with tests and evidence.

## 1. Build the launch manifest

Do not write code until all required fields are known:

```yaml
asset:
  name: ""
  symbol: ""
  chain_family: ""
  chain_name: ""
  chain_id_or_genesis: ""
  network: mainnet|testnet|devnet|local
  standard: ""
  decimals: null
  max_supply: ""
  initial_supply: ""
  allocation:
    treasury: ""
    public: ""
    liquidity: ""
    team: ""
    community: ""
authorities:
  mint: none|wallet|multisig|timelock|program
  freeze: none|wallet|multisig|timelock|program
  pause: none|wallet|multisig|timelock
  upgrade: none|wallet|multisig|timelock
  metadata: immutable|wallet|multisig|timelock
mechanics:
  transfer_tax_bps: 0
  blacklist: false
  transfer_hook: none
  sale: none
  liquidity: none
verification:
  source: required
  simulation: required
  firm_audit: false
```

Reject ambiguous supply units. Record raw base units and human-readable units.
Percent allocations must total 100 percent before deploy preparation.

## 2. Verify the chain, standard, and tooling

1. Resolve the exact chain identity from a live RPC or official client.
2. Verify native gas asset, address format, finality model, fee fields, explorer,
   compiler/toolchain version, and source/program verification mechanism.
3. Verify the intended standard from official chain or standards documentation.
4. Prefer a boring official or widely reviewed implementation.
5. Record every external factory, router, program, module, and metadata endpoint.
6. Mark unverified addresses and deprecated tooling `UNSUPPORTED`, not best effort.

Chain names are not identities. `mainnet`, `testnet`, and forks must carry distinct
IDs and RPC evidence.

## 3. Force an authority decision

Before generating transactions, print a table for:

- mint or treasury capability
- freeze or deny-list capability
- pause capability
- upgrade authority
- metadata authority
- fee/tax setter
- transfer-hook owner
- sale contract owner
- liquidity position owner
- treasury and royalty recipients

For each authority, state who holds it at creation, whether it can change, the
transfer/revoke transaction, and what breaks if revoked.

Defaults:

- fixed supply when future minting is not a product requirement
- no transfer tax
- no blacklist
- no proxy upgradeability
- no hidden owner balance changes
- multisig or timelock for powers that must remain
- revoke only after verification and launch operations that need the authority

Never claim "renounced" until independent on-chain read-back proves it.

## 4. Family-specific build paths

### EVM

For a plain fixed-supply token, use Oracle's gated template:

```js
data.call("protocol-templates", "gate", { templateId: "safe-erc20" })
data.call("protocol-templates", "prepareDeploy", {
  templateId: "safe-erc20",
  chainId,
  args: [name, symbol, supply, initialHolder, initialOwner],
})
```

Required gates:

1. Verify chain id and RPC reality.
2. `forge test` passes.
3. Static analysis runs when available.
4. Constructor units and addresses decode back exactly.
5. Dry-run deployment succeeds on the target chain fork when archive state exists.
6. Unsigned deploy is stamped; source verification input is prepared separately.
7. Liquidity and ownership changes remain separate unsigned actions.

Any custom minting, tax, blacklist, transfer hook, proxy, permit, votes, vesting, or
cross-chain bridge logic leaves `safe-erc20` and becomes a custom `GUIDED_BUILD`.
Do not silently bolt features onto the reviewed template.

### Solana

Choose standard SPL Token unless a specific Token-2022 extension is required.
For Token-2022, enumerate every selected extension and its authority, including
transfer fees, permanent delegate, transfer hook, default account state, metadata
pointer, interest bearing, confidential transfer, and non-transferable behavior.

Prepare distinct unsigned transactions for:

1. create mint account and initialize mint
2. create metadata when used
3. create distribution token accounts
4. mint initial supply
5. transfer or revoke mint authority
6. transfer or revoke freeze authority
7. create sale or liquidity positions, only if separately approved

Simulate each transaction against the intended cluster. A blockhash-expired result
must be rebuilt, never manually edited.

### Bitcoin Runes

A Rune launch is an etching, not a smart-contract deployment. Collect and print:

- rune name and spacers
- divisibility and symbol
- premine
- mint amount and cap
- start and end heights or offsets
- turbo flag
- commit UTXO, reveal destination, fee rate, and expected total fees

Prepare commit/reveal artifacts only through a verified adapter. Protect the commit
UTXO from accidental spend, account for the reveal window and reorg risk, and never
promise an indexer ticker reservation before the etching confirms. Without an
adapter, status stays `RESEARCH_ONLY`.

### Cosmos

First determine whether the target uses a native tokenfactory module, CosmWasm
CW20, or an EVM runtime. These are different launch paths.

- tokenfactory: verify denom creation, mint, burn, admin-change, and metadata message
  types from that chain's running version
- CW20: compile and test the exact contract artifact, instantiate message, minter
  model, marketing info, and migration admin
- EVM runtime: use the EVM path only after proving chain id and JSON-RPC behavior

Never transplant Osmosis, Injective, Sei, or another chain's message type by name.

### Sui and Aptos

Sui and Aptos need separate Move packages and authority models. Do not share source
because both languages are called Move.

- Sui: identify one-time witness, treasury capability, metadata/display objects,
  deny-list or regulated-coin powers, package upgrade policy, and object ownership
- Aptos: choose Coin or Fungible Asset, define mint/burn/freeze capability objects,
  metadata object, store model, and module upgrade policy

Publish and exercise the full lifecycle on devnet/testnet first. Mainnet remains
`RESEARCH_ONLY` until the exact package and publish transaction pass review.

### Hyperliquid

Do not conflate HIP-3 builder-deployed perp markets, HIP-1 or native spot assets,
HyperEVM ERC-20s, and HIP-4 outcomes. Route HyperEVM assets to EVM. For Hyperliquid
L1 native assets, verify current official deployment, auction, genesis allocation,
and deployer requirements before naming a prepare path. Without a dedicated native
adapter, status is `RESEARCH_ONLY`.

## 5. Distribution, sale, and liquidity are separate actions

Token creation does not authorize a sale or pool. For each follow-on action, show:

- destination contract/program/module
- token and quote amounts
- opening price and implied fully diluted value
- slippage and deadline
- LP ownership, lock, burn, or withdrawal rights
- treasury recipient
- vesting terms and clawback/admin powers
- simulation and fee estimate

Verify DEX factories and routers on the exact chain. A canonical address on Ethereum
is not canonical on a sibling EVM chain.

Never auto-create liquidity after deployment. Never auto-revoke authority before
metadata, distribution, or verification actions that need it are complete.

## 6. Required artifacts

A completed prepare run returns:

1. `launch-manifest.yaml` with exact units and chain identity
2. authority and mutability table
3. source/package hash and dependency lock
4. test and static-analysis results
5. target-chain simulation or an explicit reason it is unavailable
6. fee and balance estimate
7. ordered unsigned transaction bundle with hashes
8. source/program verification payload
9. separate liquidity/distribution bundle when requested
10. a final user approval checklist, one side effect per line

Do not emit a signed payload, private key request, seed phrase request, or broadcast
command with signing enabled.

## Refusals

Refuse hidden minting, honeypots, selective sell blocks, fake renouncement, covert
taxes, wash liquidity, fake volume, stolen upgrade keys, undisclosed permanent
delegates, and misleading supply claims.

## Completion gate

A launch is only `PREPARED` when:

- chain and standard are exact
- support status is honest
- supply and allocation reconcile
- all authorities are disclosed
- tests pass
- simulation passes or the missing capability is explicit
- every destination and payload hash is recorded
- no signing or broadcast occurred

Anything less is `DRAFT`, `RESEARCH_ONLY`, or `UNSUPPORTED`.
