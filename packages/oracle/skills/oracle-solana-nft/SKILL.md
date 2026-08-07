---
name: oracle-solana-nft
description: Research Solana NFT collections and prepare unsigned Magic Eden buy, list, and mint transactions.
---

# Solana NFT lane (Magic Eden)

Use when someone asks Oracle to check a Solana NFT collection's floor, find
listings, buy an NFT, list one they hold, or mint from a launchpad drop.

## Tiers

| Op | Key needed | What it returns |
|---|---|---|
| `stats` | none | floor in SOL, listed count, 24h volume |
| `listings` | none | mint, seller, auctionHouse, tokenATA, price |
| `tokenListings` | none | listings for one specific mint |
| `prepareBuy` | `MAGICEDEN_API_KEY` | unsigned base64 transaction |
| `prepareList` | `MAGICEDEN_API_KEY` | unsigned base64 transaction |
| `prepareMint` | `MAGICEDEN_API_KEY` | unsigned base64 transaction |

Reads are keyless. Instruction builders need the user's own Magic Eden key. If
the key is missing, say so plainly and stop; do not fake a ticket.

## Flow for a buy

1. `desk.solana.nftStats({ symbol })` - confirm the collection is real and get
   the floor.
2. `desk.solana.nftListings({ symbol, limit })` - pull live listings. The
   cheapest listing is the first one when sorted by price.
3. Set `maxPriceSol` from the user's stated ceiling, not from the floor. The cap
   is checked before any network call, so a listing that moved above the ceiling
   is rejected without touching the API.
4. `desk.solana.nftPrepareBuy({ buyer, seller, auctionHouse, tokenMint, tokenATA, priceSol, maxPriceSol })`.
5. Simulate the returned base64 through `desk.solana.simulate` before handing it
   over. A prepared transaction that fails simulation is a prepared loss.
6. Hand the user the unsigned transaction. Their wallet signs and sends.

## Rules

- Floor price is not a bid. Buying fills at the listing price, which can move
  between the read and the signature.
- Always pass `maxPriceSol`. Without it there is no ceiling on a mint or buy.
- Collection symbols are validated as slugs. `../` and empty strings are
  rejected, not encoded into a URL.
- Every prepare returns `signingReady: false` and `broadcastReady: false`. Oracle
  never signs a Solana transaction and never sends one.
- Solana lamports are integers. `priceSol` is decimal SOL; the module converts.

## Verification

`npm run e2e:solana-bitcoin` hits live Magic Eden reads, a live Jupiter quote,
a live prepared swap, and a live simulation, then asserts the prepare posture
held.
