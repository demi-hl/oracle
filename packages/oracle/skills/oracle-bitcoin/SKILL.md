---
name: oracle-bitcoin
description: Use for Bitcoin L1, Ordinals/runes research, and inscription PSBT preparation. User-wallet signing only.
---

# Bitcoin L1 / Ordinals

Bitcoin is a separate signing plane. Do not route it through EVM grants, EVM
signers, or EVM calldata policy.

## What this skill owns

- Bitcoin L1 reads through Esplora: tip height, fee rates, address state, UTXOs,
  transactions.
- Ordinals/runes reads through the Bitcoin metaprotocol data providers.
- Satflow marketplace research and unsigned PSBT intents for ordinals/runes market
  actions when a Satflow key is configured.
- Inscription planning and **PSBT preparation** for user-wallet signing.

## Inscription flow

Default path is self-custodial:

1. Collect the inscription content, MIME type, destination address, change address,
   and fee preference.
2. Check Bitcoin health, fee rates, and the inscription body-size cap.
3. Estimate commit/reveal cost and UTXO needs before preparing.
4. Prepare commit/reveal PSBTs or unsigned artifacts.
5. User signs in Xverse, UniSat, Leather, OKX, Phantom, Magic Eden wallet, or a
   compatible injected Bitcoin wallet.
6. Broadcast only after explicit user confirmation.
7. Report commit txid, reveal txid, inscription id when known, and mempool/receipt
   status.

## Hard rules

- Never request or print a seed, WIF, xprv, or wallet export.
- Operator WIF/local signing is not part of the public default. If a deployment
  has it, it must be separately armed and still explicit-confirm gated.
- Inscribe is Bitcoin L1 commit/reveal. Satflow is marketplace inventory/listing,
  not the inscription path.
- Fee facts are live facts. Re-read fees immediately before prepare.
- If content exceeds the current cap, refuse and offer compression/splitting.
- Never claim an inscription landed without a real reveal txid or inscription id.

## Review checklist

- Content hash and byte length shown before signing.
- MIME type shown in plain language.
- Destination and change addresses displayed and user-confirmed.
- Fee rate, estimated vbytes, and worst-case spend shown.
- Commit/reveal sequence explained as non-atomic.
- Mempool status checked after broadcast.
