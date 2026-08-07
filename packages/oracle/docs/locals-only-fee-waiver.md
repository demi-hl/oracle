# Locals Only fee waiver

Oracle is public to everyone. Source access, npm installation, CLI commands,
desktop downloads, ordinary product use, and execution arming are not gated by
an NFT.

It does not gate Oracle downloads, access, source, CLI use, desktop use, or
execution preparation.

A wallet holding a Locals Only NFT receives a **0% Oracle integrator fee**. A
non-holder can use the same product and routes, but the standard disclosed
Oracle fee applies when fee collection is configured.

## Collection

- Chain: HyperEVM, chain ID `999`
- Contract: `0x62FCFAf7573AD8B41a0FBF347AfEb85e06599A75`
- Check: read-only ERC-721 `balanceOf(address)`

The balance check does not request a signature, approval, private key, seed
phrase, or transaction. Run `oracle fees status` for the configured wallet or
`oracle fees check <address>` for any public address.

## Fee behavior

- No fee recipient configured: Oracle charges no integrator fee to anyone.
- Fee recipient configured, non-holder: the configured fee applies, capped at
  100 basis points.
- Fee recipient configured, Locals Only holder: Oracle's integrator fee is 0%.
- Hyperliquid builder fees are not waived. Provider fees, bridge fees, gas,
  slippage, LP fees, and network costs also remain separate.

Fee resolution stays separate from custody. The public package remains keyless
and prepare-only; the user's wallet reviews, signs, and submits.
