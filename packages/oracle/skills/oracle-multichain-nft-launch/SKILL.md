---
name: oracle-multichain-nft-launch
description: Use when planning, building, reviewing, or preparing an NFT collection launch across EVM, Solana, Bitcoin Ordinals, Cosmos, Move, HyperEVM, or another chain family. Fail closed on unsupported adapters; preserve metadata provenance; prepare only; the user signs every side effect.
---

# Multichain NFT collection launch

## Contract

Use this skill for collection contracts or programs, metadata and media manifests,
allowlists, public mints, royalties, reveals, editions, inscriptions, and collection
verification.

"Every chain" means classify the chain family and use a verified native standard.
There is no universal NFT transaction. An ERC-721, a Metaplex collection, a Bitcoin
parent inscription, a CW721 contract, and a Move object are different products.

Oracle researches, scaffolds, tests, simulates, and prepares unsigned actions. The
user signs collection creation, mint, metadata, authority, treasury, marketplace,
and reveal actions separately. Never broadcast from this skill.

When loaded by the `oracle` router, use this skill to classify the request, then
route chain research to the relevant specialist and build/prepare work to
`protocol-builder`. The router remains read and simulate only.

If the launch uses randomized packs or loot mechanics, load
`oracle-nft-gacha-launch` as an additional safety layer.

## Support status language

Use exactly one status before building:

| Status | Meaning |
|---|---|
| `TEMPLATE_READY` | Oracle ships a gated collection template and prepare adapter for the exact standard. |
| `ADAPTER_READY` | A chain-specific creation/mint encoder exists and passed simulation or testnet verification. |
| `GUIDED_BUILD` | Oracle can scaffold and test the project, but no generic transaction adapter is shipped. |
| `RESEARCH_ONLY` | Oracle can verify standards and produce a launch plan, not a deployable bundle. |
| `UNSUPPORTED` | Required primitives or trustworthy tooling cannot be verified. Stop. |

Do not call marketplace read or mint-bot support a collection-deployment adapter.
Buying an NFT, minting from an existing contract, and creating a collection are
three separate capabilities.

## Current family matrix

| Family | Collection primitive | Default status | Required path |
|---|---|---|---|
| EVM | ERC-721, ERC-1155, ERC-2981 | `GUIDED_BUILD` until a gated Oracle collection template ships | Foundry tests, metadata/reveal tests, fork simulation, unsigned deploy |
| Solana | Metaplex Core, Token Metadata collection, Candy Machine/drop programs | `GUIDED_BUILD` | Select one standard, validate authorities, simulate ordered unsigned transactions |
| Bitcoin | Ordinals parent/child inscriptions and indexer collection manifests | `GUIDED_BUILD` for content and commit/reveal planning; adapter evidence required for `ADAPTER_READY` | Provenance manifest, parent link, UTXO/fee/reveal safety |
| Cosmos | CW721 or chain-native NFT module | `RESEARCH_ONLY` by default | Verify chain-specific instantiate/execute messages and migration admin |
| Sui | object-based collection and kiosk ecosystem | `RESEARCH_ONLY` by default | Move package, object capabilities, display metadata, testnet publish |
| Aptos | Digital Asset standard or chain-native collection objects | `RESEARCH_ONLY` by default | Collection/mint refs, mutation permissions, testnet publish |
| HyperEVM | ERC-721 or ERC-1155 | EVM status | Exact HyperEVM chain id and verified RPC/toolchain |
| Hyperliquid L1 | no generic NFT contract path assumed | `UNSUPPORTED` unless an official native primitive is verified | Route to HyperEVM when the product is EVM-native |
| Other | chain-native | `UNSUPPORTED` until classified | Add and verify a dedicated adapter before preparing transactions |

## 1. Build the collection manifest

Do not generate contract or metadata artifacts until this manifest is complete:

```yaml
collection:
  name: ""
  symbol: ""
  chain_family: ""
  chain_name: ""
  chain_id_or_genesis: ""
  network: mainnet|testnet|devnet|local
  standard: ""
  supply: 0
  edition_size: 1
  onchain_media: false
  license: ""
  content_rating: ""
mint:
  price: ""
  currency: ""
  treasury: ""
  per_wallet: 0
  allowlist_root: none
  allowlist_start: null
  public_start: null
  public_end: null
  reveal: immediate|delayed|commit-reveal|vrf
metadata:
  base_uri: ""
  storage: ipfs|arweave|onchain|other
  mutable: false
  provenance_root: ""
  placeholder_uri: none
royalties:
  bps: 0
  recipients: []
authorities:
  owner: ""
  mint: ""
  metadata_update: none
  freeze: none
  pause: none
  withdraw: ""
  upgrade: none
```

Validate supply against generated metadata count. Record raw payment units and
human-readable units. Royalty splits must reconcile exactly.

## 2. Set rights, metadata, and provenance first

1. State who owns the media and which license collectors receive.
2. Hash every final media and metadata file.
3. Validate token IDs or asset indexes are unique and contiguous when required.
4. Pin or upload content only after the user approves that side effect.
5. Build a deterministic provenance root over the final ordered assets.
6. Separate placeholder metadata from final metadata.
7. State whether metadata can change, who can change it, and how that authority is
   transferred or revoked.
8. Never promise immutable media when the JSON points to mutable HTTP storage.

Metadata upload, contract deployment, first mint, reveal, marketplace verification,
and authority revocation are separate actions.

## 3. Force an authority and economics review

Before preparing transactions, print a table for:

- contract, package, or program upgrade authority
- collection owner
- mint authority
- freeze or transfer-restriction authority
- metadata update authority
- reveal authority
- pause authority
- treasury withdrawal authority
- royalty recipient and royalty update authority
- allowlist root setter
- supply increase or edition authority

For each, state initial holder, mutability, transfer/revoke action, and operational
consequence of revocation.

Also disclose:

- total supply and reserved supply
- mint phases and wallet caps
- mint price and payment token
- treasury destination
- creator/team allocation
- royalties and whether marketplaces can ignore them
- upgradeability
- delayed reveal and randomness assumptions
- estimated deploy, storage, mint, and reveal costs

Never market royalties as guaranteed income. Many marketplaces treat them as
optional.

## 4. Family-specific build paths

### EVM

Choose ERC-721 for unique items and ERC-1155 for editions or mixed fungibility.
Add ERC-2981 only as a royalty signal, not enforcement.

Prefer reviewed OpenZeppelin bases and minimal immutable deployment. If a proxy is
required, show proxy admin, implementation upgrade authority, and timelock.

Required Foundry coverage:

- maximum supply and reserved supply cannot be exceeded
- per-wallet and per-phase caps
- exact payment and refund behavior
- treasury withdrawal and reentrancy resistance
- allowlist proof validation and replay boundaries
- reveal ordering and provenance
- metadata freeze or update permissions
- royalty values and recipients
- pause behavior
- owner cannot mint hidden supply
- ERC-721 or ERC-1155 interface conformance

Run `forge test`, static analysis when available, fork or RPC simulation, and dry-run
deploy. Prepare contract verification separately. Initial mint, public mint opening,
base URI change, reveal, and ownership transfer are separate unsigned actions.

### Solana

Choose one product shape before code:

- Metaplex Core for a modern asset/collection model
- Token Metadata collection for compatibility with legacy NFT tooling
- Candy Machine or another audited drop program for staged public mints

Do not mix models casually. Print all collection, update, freeze/delegate, mint,
rule-set, and candy-machine authorities.

Prepare ordered unsigned transactions for:

1. create the collection asset or collection mint
2. create and verify collection metadata
3. create drop/mint configuration when used
4. fund storage/rent accounts
5. mint or reserve initial assets
6. verify items into the collection
7. transfer or revoke update/mint authorities

Simulate against the intended cluster. Validate account owners, rent, compute units,
address lookup tables, and transaction size. Rebuild expired blockhashes rather than
editing signed data.

### Bitcoin Ordinals

A Bitcoin collection is normally an indexer-recognized group of inscriptions, not a
collection smart contract. Build:

- canonical collection metadata and provenance manifest
- parent inscription plan
- child inscription relationships when supported
- exact content type and content hash for every item
- deterministic inscription order
- commit and reveal PSBT plan
- postage, fee rate, reveal destinations, and recovery addresses

Protect commit UTXOs from accidental spends. Account for fee changes, reorgs,
inscription ordering, and cursed/unbound outcomes. Do not promise stable inscription
numbers before confirmation. Collection listing with an indexer or marketplace is a
separate side effect after confirmed inscription IDs exist.

### Cosmos

First identify the target's actual NFT primitive. CW721, a chain-native NFT module,
and an EVM runtime are not interchangeable.

For CW721, verify the exact code artifact, checksum, instantiate message, minter,
metadata extension schema, royalty extension if any, migration admin, and chain gas
model. For a native module, verify current protobuf messages and authority behavior
from the running chain version. Use the EVM path only for a proven EVM runtime.

### Sui

Model collection, item objects, treasury or publisher capabilities, display
metadata, transfer policy, royalties/kiosk behavior, package upgrade policy, and
shared versus owned objects. Test package publish, collection creation, mint,
transfer, and authority transfer on testnet before any mainnet prepare.

### Aptos

Use the current Digital Asset or chain-native collection standard verified against
the target network. Define collection mutability, token mutability, mint refs,
burn/transfer refs, royalty data, supply caps, and module upgrade policy. Publish and
exercise the lifecycle on testnet first.

### Hyperliquid

HyperEVM NFT launches use the EVM path. Do not assume Hyperliquid L1 has a generic
NFT collection primitive because HyperCore supports spot, perps, staking, or outcome
markets. Without a verified official L1 standard and adapter, mark it `UNSUPPORTED`.

## 5. Mint phases and randomness

For allowlists:

- bind proofs to chain, contract/program, phase, wallet, allowance, price, and expiry
- publish the snapshot method and Merkle root
- prevent proof reuse across phases or contracts
- test wallet caps across allowlist and public phases together

For delayed reveal or randomized assignment:

- commit the final provenance before mint
- do not use timestamp, recent block hash, predictable block fields, or validator
  discretion as sole randomness
- use a verified randomness source or a deterministic disclosed assignment
- show who can trigger reveal and whether they can reroll
- publish gacha odds when rarity is randomized

Load `oracle-nft-gacha-launch` for packs, loot boxes, or paid random outcomes.

## 6. Marketplace and launch-page setup

Marketplace listing is not deployment. Only prepare it after contract/program or
inscription identifiers are final.

Before a mint page can claim ready:

- wallet and network switching work
- contract/program and payment destinations are exact
- total and per-wallet cost include gas/fees
- sold-out and phase transitions read chain state
- failed/rejected transactions surface clearly
- mint count cannot exceed the approved cap
- metadata preview comes from the pinned manifest
- no private key or seed phrase is requested

Never fabricate floor price, bids, volume, rarity, or sold count.

## 7. Required artifacts

A completed prepare run returns:

1. `collection-manifest.yaml`
2. ordered metadata/media checksums and provenance root
3. rights/license statement
4. authority and mutability table
5. source/package hash and dependency lock
6. test and static-analysis results
7. target-chain simulation or an explicit missing-capability note
8. fee, rent, postage, and treasury estimate as applicable
9. ordered unsigned transaction or PSBT bundle with payload hashes
10. source/program verification payload
11. separate metadata upload, marketplace, reveal, and authority-revoke actions
12. final user approval checklist, one side effect per line

Do not emit signed transactions, private keys, seed phrases, keystore passwords, or
broadcast commands with signing enabled.

## Refusals

Refuse stolen media, hidden supply, owner-only rerolls, fake randomness, metadata
rugs, undisclosed upgrades, wash trading, fake floor/volume, deceptive rarity,
royalty claims presented as guaranteed, and wallet-draining mint pages.

## Completion gate

A collection is only `PREPARED` when:

- chain and standard are exact
- support status is honest
- supply matches metadata
- rights and storage are explicit
- all authorities and mutable fields are disclosed
- tests pass
- simulation passes or the missing capability is explicit
- every destination and payload hash is recorded
- no signing, upload, marketplace listing, or broadcast occurred without separate
  user approval

Anything less is `DRAFT`, `RESEARCH_ONLY`, or `UNSUPPORTED`.
