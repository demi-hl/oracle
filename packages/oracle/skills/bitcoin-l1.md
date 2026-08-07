---
name: bitcoin-l1
description: Use for Bitcoin L1, Ordinals, and Runes operations.
---

# Bitcoin L1

## Read
- `data btc_balance <addr>` — balance in sats
- `data btc_utxos <addr>` — UTXO set
- `data btc_fees` — current fee rates (sats/vB)
- `data btc_tx <txid>` — transaction lookup

## Ordinals
- `data btc_inscriptions <addr>` — inscriptions held
- `data btc_inscription_info <id>` — inscription metadata
- `data satflow_floors <collection>` — floor prices
- `data satflow_floor_listings <collection>` — active listings

## Runes
- `data btc_rune_balance <addr>` — rune balances
- `exec bitcoin_runes_prepare_transfer` — prepare transfer

## Prepare
- `exec bitcoin_prepare <from> <to> <amountSats>` — payment intent
- `exec bitcoin_inscribe_prepare` — inscription commit/reveal
- `exec bitcoin_satflow_prepare_purchase` — buy ordinals/rune

## Key rules
- 1 BTC = 100,000,000 sats
- Never consume inscribed/rare-sat UTXOs as fee inputs
- PSBT review before sign — user must approve
- Payment and ordinals addresses should be distinct when wallet separates them
