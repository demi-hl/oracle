// Per-chain venue registry — the curated, code-reviewed set of contracts the
// agent wallet is allowed to transact with on each chain. This is how the dest
// allowlist "just works when you go to a new chain" WITHOUT the footgun of
// auto-trusting whatever address a tx points at: venues come from THIS vetted
// map, never from the transaction itself.
//
// The policy layer (exec-policy.mjs) unions three sources for the effective
// destination allowlist on a given chain:
//   1. MAD_DEST_ALLOWLIST         (env; global, applies to every chain)
//   2. VENUES[chainId]            (this file; per-chain known-good contracts)
//   3. CROSS_CHAIN_VENUES         (this file; same address on all chains, e.g. Permit2)
//
// To enable trading on a new chain: add its router/quoter/venue addresses here
// in ONE reviewed edit. After that, trades on that chain pass the allowlist with
// no per-trade friction. Every address is lowercased; verify each before adding.

// Uniswap Permit2 — CREATE2-deployed to the SAME address on every EVM chain.
// Verified canonical. Safe as a cross-chain constant.
export const CROSS_CHAIN_VENUES = [
  "0x000000000022d473030f116ddee9f6b43ac78ba3", // Permit2
];

// Per-chain vetted venues. Only entries verified against a trusted source.
// Empty arrays are intentional: that chain has no approved venues yet, so a
// value/contract tx there is REFUSED until you add its real venues here.
export const VENUES = {
  // Robinhood Chain — verified from rhbot server/swap.js SWAP_CONFIG (2026-07-22).
  4663: [
    "0xcaf681a66d020601342297493863e78c959e5cb2", // router
    "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7", // quoter
    "0x1f7d7550b1b028f7571e69a784071f0205fd2efa", // factory
    "0x0bd7d308f8e1639fab988df18a8011f41eacad73", // weth
    "0x5fc5360d0400a0fd4f2af552add042d716f1d168", // usdg
    "0xb477751b76cf82d00a686a1232f5fcd772414af3", // LI.FI diamond on RH (verified via li.quest /chains diamondAddress, 2026-07-23)
    "0xff5cb29241f002ffed2eaa224e3e996d24a6e8d1", // Curve RouterNG (official docs + eth_getCode, 2026-07-24)
  ],

  // Base (8453) — Uniswap v3. Verified 2026-07-22 against official Uniswap
  // deployments docs (developers.uniswap.org) + on-chain eth_getCode.
  8453: [
    "0x2626664c2603336e57b271c5c0b26f421741e481", // SwapRouter02
    "0x6ff5693b99212da76ad316178a184ab56d299b43", // UniversalRouter
    "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a", // QuoterV2
    "0x33128a8fc17869897dce68ed026d694621f6fdfd", // UniswapV3Factory
    "0x4200000000000000000000000000000000000006", // WETH
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
    "0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5", // Aerodrome Slipstream SwapRouter (slipstream README + eth_getCode + live quote, 2026-07-24)
    "0x254cf9e1e6e233aa1ac962cb9b05b2cfeaae15b0", // Aerodrome Slipstream QuoterV2 (slipstream README + eth_getCode + live quote, 2026-07-24)
    "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a", // Aerodrome Slipstream PoolFactory (slipstream README + eth_getCode, 2026-07-24)
    "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // LI.FI canonical diamond (verified via li.quest /chains diamondAddress, 2026-07-23)
    "0x888888888889758f76e7103c6cbf23abbf58f946", // Pendle Router (official deployments + eth_getCode, 2026-07-23)
    "0x3f170631ed9821ca51a59d996ab095162438dc10", // Balancer v3 Router (official deployments + eth_getCode, 2026-07-23)
    "0x4f37a9d177470499a2dd084621020b023fcffc1f", // Curve RouterNG (official docs + eth_getCode, 2026-07-24)
    "0xc92e8bdf79f0507f65a392b0ab4667716bfe0110", // CoW VaultRelayer (CoW contracts networks.json v1.8.0, 2026-07-24)
  ],

  // Arbitrum One (42161) — Uniswap v3. Verified 2026-07-22 against arbiscan
  // (Uniswap V3: Router 2 label) + swap-router-contracts release + on-chain code.
  42161: [
    "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", // SwapRouter02
    "0x61ffe014ba17989e743c5f6cb21bf9697530b21e", // QuoterV2
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // USDC (native)
    "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // LI.FI canonical diamond (verified via li.quest, 2026-07-23) — Leg2 Arb->Stable bridge
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", // USDT0 on Arbitrum (ERC20 approve target for Leg2 bridge)
    "0x888888888889758f76e7103c6cbf23abbf58f946", // Pendle Router (official deployments + eth_getCode, 2026-07-23)
    "0xeaedc32a51c510d35ebc11088fd5ff2b47aacf2e", // Balancer v3 Router (official deployments + eth_getCode, 2026-07-23)
    "0x2191718cd32d02b8e60badffea33e4b5dd9a0a0d", // Curve RouterNG (official docs + eth_getCode, 2026-07-24)
    "0xc92e8bdf79f0507f65a392b0ab4667716bfe0110", // CoW VaultRelayer (CoW contracts networks.json v1.8.0, 2026-07-24)
    "0x1c3fa76e6e1088bce750f23a5bfcffa1efef6a41", // GMX v2 ExchangeRouter (gmx-synthetics deployments/arbitrum, 2026-07-24)
    "0x7452c558d45f8afc8c83dae62c3f8a5be19c71f6", // GMX v2 Router approval spender (gmx-synthetics deployments/arbitrum, 2026-07-24)
  ],

  // Add verified venues per chain before trading there. Left empty on purpose:
  // an empty chain refuses non-allowlisted destinations (fail-closed by design).
  1: [
    "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", // Uniswap SwapRouter02
    "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // LI.FI canonical diamond (verified via li.quest, 2026-07-23) — ETH->Arb gas bridge
    "0x4cd00e387622c35bddb9b4c962c136462338bc31", // Relay Depository (api.relay.link quote target + Etherscan label, 2026-07-23)
    "0x6a000f20005980200259b80c5102003040001068", // ParaSwap/Velora Augustus V6.2 (Velora docs + priceRoute target, 2026-07-23)
    "0xae563e3f8219521950555f5962419c8919758ea2", // Balancer v3 Router (official deployments + eth_getCode, 2026-07-23)
    "0x45312ea0eff7e09c83cbe249fa1d7598c4c8cd4e", // Curve RouterNG (official docs + eth_getCode, 2026-07-24)
    "0xc92e8bdf79f0507f65a392b0ab4667716bfe0110", // CoW VaultRelayer (CoW contracts networks.json v1.8.0, 2026-07-24)
  ],      // Ethereum
  137: [
    "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // LI.FI diamond (li.quest /chains + eth_getCode, 2026-07-23)
    "0x0dcded3545d565ba3b19e683431381007245d983", // Curve RouterNG (official docs + eth_getCode, 2026-07-24)
  ],    // Polygon
  10: [
    "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // LI.FI diamond (li.quest /chains + eth_getCode, 2026-07-23)
    "0xe2fa4e1d17725e72dcdafe943ecf45df4b9e285b", // Balancer v3 Router (official deployments + eth_getCode, 2026-07-23)
    "0x0dcded3545d565ba3b19e683431381007245d983", // Curve RouterNG (official docs + eth_getCode, 2026-07-24)
  ],     // Optimism
  56: [
    "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // LI.FI diamond (li.quest /chains + eth_getCode, 2026-07-23)
    "0xa72c85c258a81761433b4e8da60505fe3dd551cc", // Curve RouterNG (official docs + eth_getCode, 2026-07-24)
  ],     // BSC
  43114: [
    "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // LI.FI diamond (li.quest /chains + eth_getCode, 2026-07-23)
    "0xf39ca6ede9bf7820a952b52f3c94af526bab9015", // Balancer v3 Router (official deployments + eth_getCode, 2026-07-23)
    "0x0dcded3545d565ba3b19e683431381007245d983", // Curve RouterNG (official docs + eth_getCode, 2026-07-24)
    "0x8f550e53dfe96c055d5bdb267c21f268fcaf63b2", // GMX v2 ExchangeRouter (gmx-synthetics deployments/avalanche, 2026-07-24)
    "0x820f5ffc5b525cd4d88cd91acf2c28f16530cc68", // GMX v2 Router approval spender (gmx-synthetics deployments/avalanche, 2026-07-24)
  ],  // Avalanche
  999: [
    "0x0a0758d937d1059c356d4714e57f5df0239bce1a", // LI.FI diamond (li.quest /chains + eth_getCode, 2026-07-23)
    "0xd2002373543ce3527023c75e7518c274a51ce712", // Curve RouterNG (official docs + eth_getCode, 2026-07-24)
  ],    // HyperEVM
  2741: [
    "0x4f8c9056bb8a3616693a76922fa35d53c056e5b3", // LI.FI diamond (li.quest /chains + eth_getCode, 2026-07-23)
  ],   // Abstract
  988: [
    "0x026f252016a7c47cdef1f05a3fc9e20c92a49c37", // LI.FI diamond (li.quest /chains + eth_getCode, 2026-07-23)
    "0xff5cb29241f002ffed2eaa224e3e996d24a6e8d1", // Curve RouterNG (official docs + eth_getCode, 2026-07-24)
    "0x817997ca8394e26cce3de3a076a4889b27dbf9de", // WgUSDT (wrapped native USDT0, WETH-style deposit/transfer)
    "0x3dea4be5615974f31624404ef288ba3b36dfeb83", // FEFER/WgUSDT UniV2 pair (raw swap target, verified on-chain)
    "0xeaf7ac0fdf150cdd89340fb762d83848de6a7b83", // FEFER token (approve/transfer for sell-back)
    "0x779ded0c9e1022225f8e0630b35a9b54be713736", // USDT0 canonical (native mirror)
    "0xbc6f7725f08232c151b528bdfcaaf89993ca86ee", // Atomic FEFER raw-pair buyer; deployed by executor, owner verified on-chain (2026-07-23)
  ],    // Stable
};

// Destinations that can move value according to a market quote. Calldata sent
// to these contracts must carry a fresh bounded auto-slippage guard through the
// signer boundary. Tokens, wrappers, quoters, factories, and Permit2 are
// intentionally excluded because approvals/deposits are not swaps.
export const SWAP_VENUES = {
  1: [
    "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", // SwapRouter02
    "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // LI.FI diamond
    "0x4cd00e387622c35bddb9b4c962c136462338bc31", // Relay Depository
    "0x6a000f20005980200259b80c5102003040001068", // ParaSwap/Velora Augustus V6.2
    "0xae563e3f8219521950555f5962419c8919758ea2", // Balancer v3 Router
    "0x45312ea0eff7e09c83cbe249fa1d7598c4c8cd4e", // Curve RouterNG
  ],
  10: [
    "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // LI.FI diamond
    "0xe2fa4e1d17725e72dcdafe943ecf45df4b9e285b", // Balancer v3 Router
    "0x0dcded3545d565ba3b19e683431381007245d983", // Curve RouterNG
  ],
  56: [
    "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // LI.FI diamond
    "0xa72c85c258a81761433b4e8da60505fe3dd551cc", // Curve RouterNG
  ],
  137: [
    "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // LI.FI diamond
    "0x0dcded3545d565ba3b19e683431381007245d983", // Curve RouterNG
  ],
  988: [
    "0x026f252016a7c47cdef1f05a3fc9e20c92a49c37", // LI.FI diamond
    "0xff5cb29241f002ffed2eaa224e3e996d24a6e8d1", // Curve RouterNG
    "0x3dea4be5615974f31624404ef288ba3b36dfeb83", // verified raw V2 pair
    "0xbc6f7725f08232c151b528bdfcaaf89993ca86ee", // atomic raw-pair helper
  ],
  999: [
    "0x0a0758d937d1059c356d4714e57f5df0239bce1a", // LI.FI diamond
    "0xd2002373543ce3527023c75e7518c274a51ce712", // Curve RouterNG
  ],
  2741: [
    "0x4f8c9056bb8a3616693a76922fa35d53c056e5b3", // LI.FI diamond
  ],
  4663: [
    "0xcaf681a66d020601342297493863e78c959e5cb2", // SwapRouter02
    "0xb477751b76cf82d00a686a1232f5fcd772414af3", // LI.FI diamond
    "0xff5cb29241f002ffed2eaa224e3e996d24a6e8d1", // Curve RouterNG
  ],
  8453: [
    "0x2626664c2603336e57b271c5c0b26f421741e481", // SwapRouter02
    "0x6ff5693b99212da76ad316178a184ab56d299b43", // UniversalRouter
    "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // LI.FI diamond
    "0x888888888889758f76e7103c6cbf23abbf58f946", // Pendle Router
    "0x3f170631ed9821ca51a59d996ab095162438dc10", // Balancer v3 Router
    "0x4f37a9d177470499a2dd084621020b023fcffc1f", // Curve RouterNG
  ],
  42161: [
    "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", // SwapRouter02
    "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // LI.FI diamond
    "0x888888888889758f76e7103c6cbf23abbf58f946", // Pendle Router
    "0xeaedc32a51c510d35ebc11088fd5ff2b47aacf2e", // Balancer v3 Router
    "0x2191718cd32d02b8e60badffea33e4b5dd9a0a0d", // Curve RouterNG
  ],
  43114: [
    "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // LI.FI diamond
    "0xf39ca6ede9bf7820a952b52f3c94af526bab9015", // Balancer v3 Router
    "0x0dcded3545d565ba3b19e683431381007245d983", // Curve RouterNG
  ],
};

export function isSwapVenue(chainId, address) {
  const target = String(address || "").trim().toLowerCase();
  if (!target) return false;
  return (SWAP_VENUES[Number(chainId)] || []).includes(target);
}

/**
 * Known-good destinations for a chain: the union of that chain's vetted venues
 * and the cross-chain constants. Returns a Set of lowercased addresses.
 * @param {number} chainId
 * @returns {Set<string>}
 */
export function venuesFor(chainId) {
  const perChain = VENUES[Number(chainId)] || [];
  return new Set(
    [...perChain, ...CROSS_CHAIN_VENUES].map((a) => String(a).trim().toLowerCase()).filter(Boolean)
  );
}
