# Hyperliquid builder code

Oracle's Hyperliquid order preparer discloses and attaches this builder code to eligible perp orders:

- Builder address: `0x4d47B6757aFd42c3dbd9691b71B43d74Afa4b6b2`
- Oracle perps fee: **5 basis points** (`0.05%`)
- Hyperliquid order wire value: `builder: { "b": "0x4d47B6757aFd42c3dbd9691b71B43d74Afa4b6b2", "f": 50 }`

Hyperliquid expresses `f` in tenths of a basis point, so `f: 50` means 5 basis points. This is separate from the 10 basis point same-chain swap tier and from Hyperliquid's own trading fees.

## Locals Only

Locals Only ownership only changes Oracle's integrator-fee rate. It does not waive the Hyperliquid builder fee, which is a separate venue mechanism. Eligible holder and non-holder perp orders carry the same disclosed builder parameter. This is not an access gate. Holders and non-holders use the same public package, markets, order preparation, and wallet handoff.

## One-time approval

Before Hyperliquid accepts an order carrying this builder code, the user must approve a maximum fee for the builder address with an `ApproveBuilderFee` action:

```json
{
  "type": "approveBuilderFee",
  "builder": "0x4d47B6757aFd42c3dbd9691b71B43d74Afa4b6b2",
  "maxFeeRate": "0.05%",
  "nonce": 0
}
```

The nonce is replaced at preparation time. Hyperliquid requires the **main wallet**, not an agent or API wallet, to sign this approval. The approval is revocable. Oracle prepares the action but never signs or submits it.

The approved maximum can be checked with Hyperliquid's read-only info request:

```json
{
  "type": "maxBuilderFee",
  "user": "0xUSER",
  "builder": "0x4d47B6757aFd42c3dbd9691b71B43d74Afa4b6b2"
}
```

## Builder-account requirements

Hyperliquid requires the builder address to:

1. Use Manual / Standard account mode.
2. Maintain at least 100 USDC in perps account value.
3. Use standard account abstraction for builder-fee accrual.

The public preparer does not inject a signature, approval, API-wallet credential, or broadcast call. `hlPrepareBuilderFeeApproval()` returns the unsigned approval envelope, while `hlPreparePerpOrder()` and `hlPrepareBracketOrder()` disclose the builder address and fee before wallet review.

Official specification: [Hyperliquid builder codes](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes).
