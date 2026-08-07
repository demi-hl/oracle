# Hyperliquid builder code

Oracle can attach an operator-configured builder code to eligible Hyperliquid orders. The builder address comes from `ORACLE_HL_BUILDER_ADDRESS` and is not published in source, documentation, metadata, or website copy.

## Oracle fee tiers

- Core perpetuals: **2 basis points** (`0.02%`)
- HIP-3: **1 basis point** (`0.01%`)
- HIP-4 outcomes: **1 basis point** (`0.01%`)
- Spot policy: **1 basis point** (`0.01%`), currently inactive because Oracle does not ship a spot-order preparation path

Category environment overrides may lower these values but cannot raise them. Hyperliquid expresses order `f` values in tenths of a basis point, so the canonical wire values are `20` for core perpetuals and `10` for HIP-3/HIP-4.

These builder fees are separate from Hyperliquid's native trading fees and from Oracle's routed-swap fee. Hyperliquid perpetual routes carry **0 routed-integrator bps**, preventing fee stacking.

A verified Locals Only holder receives a 0% Oracle fee rate, including the Oracle builder fee. Ownership never changes product access, execution arming, package access, or wallet custody.

## One-time approval

Before Oracle attaches builder data, it reads Hyperliquid's `maxBuilderFee` information endpoint for the user's main wallet and the configured builder. The returned integer is measured in tenths of a basis point. Missing, invalid, unavailable, or insufficient approval prevents builder data from being attached.

`prepareBuilderApproval` returns an unsigned `approveBuilderFee` action containing `hyperliquidChain`, `signatureChainId`, `maxFeeRate`, `builder`, and `nonce`. Hyperliquid requires the user's **main wallet**, not an agent or API wallet, to review and sign this approval. Oracle never signs or submits it.

The approval is revocable. Prepared orders remain non-signing-ready and non-broadcast-ready until the wallet reviews and signs them.

Official specification: [Hyperliquid builder codes](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes).
