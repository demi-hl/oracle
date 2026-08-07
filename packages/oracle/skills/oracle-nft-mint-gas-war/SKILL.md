---
name: oracle-nft-mint-gas-war
description: Guard public NFT mint bots with chain-wide gas-war caps before any wallet-signed mint transaction is returned.
---

# Oracle NFT mint gas-war guard

Use when a public Oracle lane prepares NFT mint transactions or runs a mint bot
across configured chains.

## Rule

A mint bot may move fast, but it must not bid uncapped gas.

Every prepared mint transaction must carry a gas envelope that fits the user's
explicit grant or bot policy:

- `maxTotalGasWei` / grant `maxGasWei`: total gas spend cap (`gasLimit * maxFeePerGas` or `gasLimit * gasPrice`)
- optional `maxFeePerGasWei`: per-unit fee cap
- optional `maxPriorityFeePerGasWei`: tip cap for gas wars
- chain id: required and bound to the prepared transaction

Missing caps fail closed. A mint returning calldata without gas caps is not
public-safe.

## Implementation hook

Use `validateNftMintGasWar()` or `assertNftMintGasWar()` from the public package
before returning a wallet-signable NFT mint transaction.

```js
import { assertNftMintGasWar } from "oracle-agent";

assertNftMintGasWar({
  chainId,
  tx: { gasLimit, maxFeePerGas, maxPriorityFeePerGas },
  policy: {
    grant, // may provide maxGasWei
    maxFeePerGasWei,
    maxPriorityFeePerGasWei,
  },
});
```

## Public behavior

- PASS: return the unsigned mint transaction with the gas verdict fields.
- BLOCK: show the cap breached and ask the user to raise the cap or skip.
- Never silently widen gas during a gas war.
- Never treat mint price cap as gas cap; mint value and gas spend are separate.
- Never backend-sign public mints. User wallet or explicit self-hosted session
grant signs.

## Verification

Run:

```bash
node --test test/nft-gas-war-guard.test.mjs test/package-surface.test.mjs
```

Full public release gate still requires `npm test`, package dry-run, and secret
scan before publishing.
