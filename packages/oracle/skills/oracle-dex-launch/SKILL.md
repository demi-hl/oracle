---
name: oracle-dex-launch
description: Use when designing, reviewing, or preparing a DEX, AMM pool, router/factory fork, token launch, or liquidity bootstrap.
---

# DEX / AMM launch builder

Use this for launching or auditing token markets, DEX forks, pools, routing surfaces,
liquidity bootstraps, and trading UIs.

## Decide the AMM shape

- V2 constant-product pair: factory, router, WETH/wrapped native, fee, LP token.
- V3 concentrated liquidity: factory, position manager, quoter, router, fee tiers.
- Stable-swap / Curve-like: pool invariant, amplification, coins, router.
- Aggregator frontend: quote source, destination allowlist, minOut/deadline guard.

Do not bend one adapter to fit another shape. V2, V3, stable-swap, and aggregator
routes need separate encoders and tests.

## Launch checklist

1. Verify canonical factory/router/quoter addresses from official sources and live
   functional probes, not names or codesize alone.
2. Define initial liquidity, starting price, lock/burn policy, and treasury role.
3. Simulate buy and sell, including exact approval path and round-trip retention.
4. Enforce nonzero minOut, short deadlines, route attestation, and gas caps.
5. Record per-chain provenance next to any allowlisted venue address.
6. Publish honest risk labels: `LIVE`, `UNKNOWN`, `UNAVAILABLE`, or `FAIL`.

## Hard rules

- No fake TVL, wash-volume instructions, hidden tax switches, or owner-only sell
  bypasses.
- A successful buy quote does not prove sellability. Test exits first.
- A router on one chain is not verified on another chain.
- Preparing a pool deploy is not live support; live support needs simulation,
  allowlist, signer-bound policy, receipt verification, and docs.
