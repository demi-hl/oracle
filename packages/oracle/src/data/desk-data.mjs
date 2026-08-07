// desk.data — unified read-only facade. Never touches wallet keys.

import { listProviders, getProvider } from "./catalog.mjs";
import { timed, mapLimit } from "./http.mjs";
import * as hl from "./providers/hl-info.mjs";
import * as poly from "./providers/poly-public.mjs";
import * as rh from "./providers/rh-agent.mjs";
import * as rpc from "./providers/evm-rpc.mjs";
import * as solana from "./providers/solana-rpc.mjs";
import * as bitcoin from "./providers/bitcoin-esplora.mjs";
import * as bitcoinMeta from "./providers/bitcoin-meta.mjs";
import * as satflow from "./providers/satflow.mjs";
import * as jupiter from "./providers/jupiter.mjs";
import * as llama from "./providers/defillama.mjs";
import * as lifi from "./providers/lifi.mjs";
import * as dxs from "./providers/dexscreener.mjs";
import * as uni from "./providers/uniswap-v3.mjs";
import * as univ4 from "./providers/uniswap-v4.mjs";
import * as aerodrome from "./providers/aerodrome.mjs";
import * as zerox from "./providers/zerox.mjs";
import * as bridges from "./providers/bridges.mjs";
import * as cow from "./providers/cowswap.mjs";
import * as oneinch from "./providers/oneinch.mjs";
import * as hlws from "./providers/hl-ws.mjs";
import * as polyws from "./providers/poly-ws.mjs";
import * as osnft from "./providers/opensea-nft.mjs";
import * as hevm from "./providers/hyperevm-dex.mjs";
import * as mesol from "./providers/magiceden-sol.mjs";
import * as hlstake from "./providers/hl-staking.mjs";
import * as hlmarkets from "./providers/hl-markets.mjs";
import * as hloutcome from "./providers/hl-outcome.mjs";
import * as polyclob from "./providers/poly-clob.mjs";
import * as protoTpl from "../protocol-templates/prepare-deploy.mjs";
import { listProtocolTemplates, runProtocolTemplateGate } from "../protocol-templates/gate.mjs";
import * as hlperps from "./providers/hl-perps.mjs";
import * as gecko from "./providers/geckoterminal.mjs";
import * as curve from "./providers/curve.mjs";
import * as gmx from "./providers/gmx.mjs";
import * as morpho from "./providers/morpho.mjs";
import * as balancer from "./providers/balancer.mjs";
import * as pendle from "./providers/pendle.mjs";
import * as odos from "./providers/odos.mjs";
import * as blockscout from "./providers/blockscout.mjs";
import * as portfolio from "./providers/portfolio.mjs";
import * as portfolioHistory from "./providers/portfolio-history.mjs";
import * as nftPortfolio from "./providers/nft-portfolio.mjs";
import * as paraswap from "./providers/paraswap.mjs";
import * as rfq from "./providers/rfq.mjs";
import * as acrossBridge from "./providers/across-bridge.mjs";
import * as beefyYields from "./providers/beefy-yields.mjs";
import * as birdeye from "./providers/birdeye-tokens.mjs";
import * as celestia from "./providers/celestia-da.mjs";
import * as dasAssets from "./providers/das-assets.mjs";
import * as l2beat from "./providers/l2beat-tvl.mjs";
import * as sparkLend from "./providers/spark-lend.mjs";
import * as symbiotic from "./providers/symbiotic-restaking.mjs";
import * as polygonStaking from "./providers/polygon-staking.mjs";
import * as aaveV3 from "./providers/aave-v3.mjs";
import * as babylon from "./providers/babylon-staking.mjs";
import * as bisq from "./providers/bisq-markets.mjs";
import * as bobRootstock from "./providers/bob-rootstock.mjs";
import * as braiins from "./providers/braiins-insights.mjs";
import * as cowProtocol from "./providers/cow-protocol.mjs";
import * as hiroStacks from "./providers/hiro-stacks.mjs";
import * as jito from "./providers/jito-mev.mjs";
import * as kamino from "./providers/kamino-strategies.mjs";
import * as liquid from "./providers/liquid-esplora.mjs";
import * as magicEdenOrd from "./providers/magiceden-ordinals.mjs";
import * as mempoolLightning from "./providers/mempool-lightning.mjs";
import * as mempoolMining from "./providers/mempool-mining.mjs";
import * as meteora from "./providers/meteora-dlmm.mjs";
import * as ordinalsRunes from "./providers/ordinals-runes.mjs";
import * as pyth from "./providers/pyth-price-feeds.mjs";
import * as relayscan from "./providers/relayscan-mev.mjs";
import * as sanctum from "./providers/sanctum-lst.mjs";
import * as solend from "./providers/solend-lending.mjs";

const OPS = {
  "hl-info": {
    health: (o) => hl.hlHealth(o),
    allMids: (o) => hl.hlAllMids(o),
    l2Book: (o, a = {}) => hl.hlL2Book(a.coin, o),
    outcomeMeta: (o) => hl.hlOutcomeMeta(o),
    clearinghouse: (o, a = {}) => hl.hlClearinghouse(a.user, o),
    userFills: (o, a = {}) => hl.hlUserFills(a.user, o),
    meta: (o) => hl.hlMeta(o),
    metaAndAssetCtxs: (o) => hl.hlMetaAndAssetCtxs(o),
    candleSnapshot: (o, a = {}) => hl.hlCandleSnapshot(a, o),
    openOrders: (o, a = {}) => hl.hlOpenOrders(a.user, o),
    frontendOpenOrders: (o, a = {}) => hl.hlFrontendOpenOrders(a.user, o),
    userState: (o, a = {}) => hl.hlUserState(a.user, o),
    spotMeta: (o) => hl.hlSpotMeta(o),
  },
  "poly-public": {
    health: (o) => poly.polyHealth(o),
    time: (o) => poly.polyTime(o),
    markets: (o, a = {}) => poly.polyMarkets(a, o),
    book: (o, a = {}) => poly.polyBook(a.tokenId, o),
    midpoint: (o, a = {}) => poly.polyMidpoint(a.tokenId, o),
    spread: (o, a = {}) => poly.polySpread(a.tokenId, o),
    price: (o, a = {}) => poly.polyPrice(a.tokenId, { side: a.side }, o),
    events: (o, a = {}) => poly.polyEvents(a, o),
  },
  "rh-agent": {
    health: (o) => rh.rhHealth(o),
    policy: (o) => rh.rhPolicy(o),
    chainConfig: (o) => rh.rhChainConfig(o),
    chainGas: (o) => rh.rhChainGas(o),
    swapsConfig: (o) => rh.rhSwapsConfig(o),
    swapsPresets: (o) => rh.rhSwapsPresets(o),
    tradingStatus: (o) => rh.rhTradingStatus(o),
    nftDrops: (o) => rh.rhNftDrops(o),
    feeEstimate: (o) => rh.rhFeeEstimate(o),
  },
  "evm-rpc": {
    health: (o, a = {}) => rpc.rpcHealth(a.chainId ?? 1, o),
    healthAll: (o, a = {}) => rpc.rpcHealthAll({ ...o, chainIds: a.chainIds }),
    blockNumber: (o, a = {}) => rpc.rpcBlockNumber(a.chainId ?? 1, o),
    chainId: (o, a = {}) => rpc.rpcChainId(a.chainId ?? 1, o),
    getBalance: (o, a = {}) => rpc.rpcGetBalance(a.chainId ?? 1, a.address, o),
    call: (o, a = {}) => rpc.rpcCall(a.chainId ?? 1, a.method, a.params || [], o),
    erc20Allowance: (o, a = {}) => rpc.erc20Allowance(a, o),
    erc20Balance: (o, a = {}) => rpc.erc20BalanceOf(a, o),
    transactionReceipt: (o, a = {}) => rpc.transactionReceipt(a, o),
  },
  portfolio: {
    health: (o) => portfolio.portfolioHealth(o),
    balances: (o, a = {}) => portfolio.portfolioBalance(a, o),
    snapshot: (o, a = {}) => portfolioHistory.portfolioSnapshot(a, o),
    history: (o, a = {}) => portfolioHistory.portfolioHistory(a, o),
    valueGraph: (o, a = {}) => portfolioHistory.portfolioValueGraph(a, o),
  },
  "nft-portfolio": {
    health: (o) => nftPortfolio.nftHealth(o),
    inventory: (o, a = {}) => nftPortfolio.nftInventory(a, o),
    gallery: (o, a = {}) => nftPortfolio.nftPortfolioGallery(a, o),
    pnl: (o, a = {}) => nftPortfolio.nftPnl(a, o),
    prepareList: (o, a = {}) => nftPortfolio.nftPrepareList(a, o),
  },
  "solana-rpc": {
    health: (o) => solana.solanaHealth(o),
    latestBlockhash: (o, a = {}) => solana.solanaLatestBlockhash(a, o),
    getBalance: (o, a = {}) => solana.solanaGetBalance(a, o),
    tokenAccounts: (o, a = {}) => solana.solanaTokenAccounts(a, o),
    simulate: (o, a = {}) => solana.solanaSimulateTransaction(a, o),
  },
  "bitcoin-esplora": {
    health: (o) => bitcoin.btcHealth(o),
    tipHeight: (o) => bitcoin.btcTipHeight(o),
    fees: (o) => bitcoin.btcFees(o),
    address: (o, a = {}) => bitcoin.btcAddressInfo(a, o),
    utxos: (o, a = {}) => bitcoin.btcUtxos(a, o),
    tx: (o, a = {}) => bitcoin.btcTx(a, o),
    decode: (o, a = {}) => bitcoin.btcDecodeTxHex(a, o),
  },
  "bitcoin-meta": {
    health: (o) => bitcoinMeta.btcMetaHealth(o),
    runeBalances: (o, a = {}) => bitcoinMeta.btcRuneBalances(a, o),
    inscriptions: (o, a = {}) => bitcoinMeta.btcInscriptions(a, o),
    inscriptionInfo: (o, a = {}) => bitcoinMeta.btcInscriptionInfo(a, o),
    inscriptionChildren: (o, a = {}) => bitcoinMeta.btcInscriptionChildren(a, o),
    ordBlockInfo: (o, a = {}) => bitcoinMeta.btcOrdBlockInfo(a, o),
  },
  satflow: {
    health: (o) => satflow.satflowHealth(o),
    collectionFloors: (o, a = {}) => satflow.satflowCollectionFloors(a, o),
    collectionStats: (o, a = {}) => satflow.satflowCollectionStats(a, o),
    item: (o, a = {}) => satflow.satflowItem(a, o),
    walletContents: (o, a = {}) => satflow.satflowWalletContents(a, o),
    floorListings: (o, a = {}) => satflow.satflowFloorListings(a, o),
    preparePurchase: (o, a = {}) => satflow.satflowPreparePurchase(a, o),
    prepareList: (o, a = {}) => satflow.satflowPrepareList(a, o),
  },
  jupiter: {
    health: (o) => jupiter.jupiterHealth(o),
    venues: (o, a = {}) => jupiter.jupiterVenues(a, o),
    quote: (o, a = {}) => jupiter.jupiterQuote(a, o),
    prepare: (o, a = {}) => jupiter.jupiterPrepareSwap(a, o),
  },
  defillama: {
    health: (o) => llama.llamaHealth(o),
    prices: (o, a = {}) => llama.llamaPrices(a.coins || [], o),
    pricesBySymbol: (o, a = {}) => llama.llamaPricesBySymbol(a.symbols, o),
    protocols: (o) => llama.llamaProtocols(o),
    yields: (o, a = {}) => llama.llamaYields(a, o),
    stablecoins: (o, a = {}) => llama.llamaStablecoins(a, o),
    dexVolumes: (o, a = {}) => llama.llamaDexVolumes(a, o),
  },
  lifi: {
    health: (o) => lifi.lifiHealth(o),
    quote: (o, a = {}) => lifi.lifiQuote(a, o),
    prepare: (o, a = {}) => lifi.lifiPrepare(a, o),
    chains: (o) => lifi.lifiChains(o),
  },
  dexscreener: {
    health: (o) => dxs.dexscreenerHealth(o),
    token: (o, a = {}) => dxs.dexscreenerToken(a.address || a.tokenAddress, o),
    search: (o, a = {}) => dxs.dexscreenerSearch(a.q || a.query, o),
    pair: (o, a = {}) => dxs.dexscreenerPair(a.chainId, a.pairAddress, o),
  },
  "uniswap-v3": {
    health: (o, a = {}) => uni.uniV3Health({ ...o, chainId: a.chainId ?? 8453 }),
    quote: (o, a = {}) => uni.uniV3QuoteExactIn(a, o),
    prepare: (o, a = {}) => uni.uniV3PrepareExactIn(a, o),
    quotePath: (o, a = {}) => uni.uniV3QuoteExactInPath(a, o),
    ethUsdc: (o, a = {}) => uni.uniV3EthUsdc(a, o),
    chains: () => uni.uniV3Chains(),
  },
  "uniswap-v4": {
    health: (o, a = {}) => univ4.uniV4Health({ ...o, chainId: a.chainId ?? 8453 }),
    quote: (o, a = {}) => univ4.uniV4QuoteExactIn(a, o),
    chains: () => univ4.uniV4Chains(),
  },
  aerodrome: {
    health: (o, a = {}) => aerodrome.aerodromeHealth({ ...o, chainId: a.chainId ?? 8453 }),
    quote: (o, a = {}) => aerodrome.aerodromeQuoteExactIn(a, o),
    prepare: (o, a = {}) => aerodrome.aerodromePrepareExactIn(a, o),
    chains: () => aerodrome.aerodromeChains(),
  },
  zerox: {
    health: (o) => zerox.zeroxHealth(o),
    price: (o, a = {}) => zerox.zeroxPrice(a, o),
    quote: (o, a = {}) => zerox.zeroxQuote(a, o),
    prepare: (o, a = {}) => zerox.zeroxPrepare(a, o),
  },
  across: {
    health: (o) => bridges.acrossHealth(o),
    suggestedFees: (o, a = {}) => bridges.acrossSuggestedFees(a, o),
  },
  hop: {
    health: (o) => bridges.hopHealth(o),
    quote: (o, a = {}) => bridges.hopQuote(a, o),
  },
  relay: {
    health: (o) => bridges.relayHealth(o),
    quote: (o, a = {}) => bridges.relayQuote(a, o),
    prepare: (o, a = {}) => bridges.relayPrepare(a, o),
  },
  cowswap: {
    health: (o) => cow.cowHealth(o),
    quote: (o, a = {}) => cow.cowQuote(a, o),
    prepareOrder: (o, a = {}) => cow.cowPrepareOrder(a, o),
    order: (o, a = {}) => cow.cowOrder(a, o),
    status: (o, a = {}) => cow.cowOrderStatus(a, o),
    chains: () => cow.cowChains(),
  },
  oneinch: {
    health: (o) => oneinch.oneinchHealth(o),
    quote: (o, a = {}) => oneinch.oneinchQuote(a, o),
    prepare: (o, a = {}) => oneinch.oneinchPrepare(a, o),
    approveSpender: (o, a = {}) => oneinch.oneinchApproveSpender(a, o),
  },
  "hl-ws": {
    health: (o) => hlws.hlWsHealth(o),
    allMids: (o) => hlws.hlWsAllMids(o),
    l2Book: (o, a = {}) => hlws.hlWsL2Book(a.coin, o),
    snapshot: (o, a = {}) => hlws.hlWsSnapshot(a.subscription || a, o),
  },
  "poly-ws": {
    health: (o, a = {}) => polyws.polyWsHealth({ ...o, assetId: a.assetId }),
    book: (o, a = {}) => polyws.polyWsBook(a.assetId || a.tokenId, o),
    snapshot: (o, a = {}) =>
      polyws.polyWsSnapshot(a.assetIds || a.assets_ids || [a.assetId], o),
  },
  "opensea-nft": {
    health: (o) => osnft.openseaHealth(o),
    collection: (o, a = {}) => osnft.openseaCollection(a.slug, o),
    floor: (o, a = {}) => osnft.openseaFloor(a.slug, o),
    accountNfts: (o, a = {}) => osnft.openseaAccountNfts(a, o),
    accountPnl: (o, a = {}) => osnft.openseaAccountPnl(a, o),
    prepareList: (o, a = {}) => osnft.openseaPrepareList(a, o),
  },

  "hl-outcome": {
    list: (o) => hloutcome.hlOutcomeList(o),
    prepareOrder: (o, a = {}) => hloutcome.hlPrepareOutcomeOrder(a, o),
    prepareCancel: (o, a = {}) => hloutcome.hlPrepareOutcomeCancel(a, o),
  },
  "protocol-templates": {
    health: () => ({ ok: true, templates: listProtocolTemplates().map((t) => t.id), firmAudit: false }),
    list: () => listProtocolTemplates(),
    gate: (o, a = {}) => runProtocolTemplateGate(a.templateId || a.id, o),
    prepareDeploy: (o, a = {}) => protoTpl.prepareTemplateDeploy(a, o),
  },
  "poly-clob": {
    prepareOrder: (o, a = {}) => {
      // prepare is sync; wrap for dataCall
      return polyclob.polyPrepareOrder(a || {});
    },
  },
  "hl-perps": {
    health: (o) => hlmarkets.hlMarketsHealth(o),
    assetInfo: (o, a = {}) => hlperps.hlPerpAssetInfo(a, o),
    prepareOrder: (o, a = {}) => hlperps.hlPreparePerpOrder(a, o),
    prepareCancel: (o, a = {}) => hlperps.hlPrepareCancelOrder(a, o),
    prepareLeverage: (o, a = {}) => hlperps.hlPrepareUpdateLeverage(a, o),
    prepareIsolatedMargin: (o, a = {}) => hlperps.hlPrepareUpdateIsolatedMargin(a, o),
    prepareBracket: (o, a = {}) => hlperps.hlPrepareBracketOrder(a, o),
    prepareBuilderApproval: (o, a = {}) => hlperps.hlPrepareBuilderApproval(a, o),
  },
  "hl-markets": {
    health: (o) => hlmarkets.hlMarketsHealth(o),
    markets: (o, a = {}) => hlmarkets.hlMarketDatapoints(a, o),
    leaderboards: (o, a = {}) => hlmarkets.hlLeaderboards(a, o),
    coin: (o, a = {}) => hlmarkets.hlCoinDatapoints(a, o),
    spot: (o, a = {}) => hlmarkets.hlSpotDatapoints(a, o),
  },
  "magiceden-sol": {
    health: (o) => mesol.magicEdenSolHealth(o),
    stats: (o, a = {}) => mesol.magicEdenSolStats(a, o),
    listings: (o, a = {}) => mesol.magicEdenSolListings(a, o),
    tokenListings: (o, a = {}) => mesol.magicEdenSolTokenListing(a, o),
    prepareBuy: (o, a = {}) => mesol.magicEdenSolPrepareBuy(a, o),
    prepareList: (o, a = {}) => mesol.magicEdenSolPrepareList(a, o),
    prepareMint: (o, a = {}) => mesol.magicEdenSolPrepareMint(a, o),
  },
  "hl-staking": {
    health: (o) => hlstake.hlStakingHealth(o),
    validators: (o) => hlstake.hlValidatorSummaries(o),
    delegatorSummary: (o, a = {}) => hlstake.hlDelegatorSummary(a, o),
    delegations: (o, a = {}) => hlstake.hlDelegations(a, o),
    rewards: (o, a = {}) => hlstake.hlDelegatorRewards(a, o),
    history: (o, a = {}) => hlstake.hlDelegatorHistory(a, o),
    preflight: (o, a = {}) => hlstake.hlStakingPreflight(a, o),
    prepareStakeDeposit: (o, a = {}) => hlstake.hlPrepareStakeDeposit(a, o),
    prepareStakeWithdraw: (o, a = {}) => hlstake.hlPrepareStakeWithdraw(a, o),
    prepareDelegate: (o, a = {}) => hlstake.hlPrepareDelegate(a, o),
  },
  "hyperevm-dex": {
    health: (o) => hevm.hyperevmHealth(o),
    search: (o, a = {}) => hevm.hyperevmSearch(a.q || a.query || "HYPE", o),
    token: (o, a = {}) => hevm.hyperevmToken(a.address || a.tokenAddress, o),
  },
  geckoterminal: {
    health: (o) => gecko.geckoHealth(o),
    networks: (o, a = {}) => gecko.geckoNetworks(a, o),
    pool: (o, a = {}) => gecko.geckoPool(a, o),
    token: (o, a = {}) => gecko.geckoToken(a, o),
    ohlcv: (o, a = {}) => gecko.geckoPoolOhlcv(a, o),
  },
  curve: {
    health: (o) => curve.curveHealth(o),
    openapi: (o) => curve.curveOpenApi(o),
    pools: (o, a = {}) => curve.curvePools(a, o),
    quote: (o, a = {}) => curve.curveQuote(a, o),
    prepare: (o, a = {}) => curve.curvePrepare(a, o),
  },
  gmx: {
    health: (o) => gmx.gmxHealth(o),
    tickers: (o, a = {}) => gmx.gmxTickers(a, o),
    markets: (o, a = {}) => gmx.gmxMarkets(a, o),
    marketsInfo: (o, a = {}) => gmx.gmxMarketsInfo(a, o),
    tokens: (o, a = {}) => gmx.gmxTokens(a, o),
    prepareOrder: (o, a = {}) => gmx.gmxPrepareOrder(a, o),
    positions: (o, a = {}) => gmx.gmxPositions(a, o),
    orderStatus: (o, a = {}) => gmx.gmxOrderStatus(a, o),
    verifyOrder: (o, a = {}) => gmx.gmxVerifyOrderReceipt(a, o),
  },
  morpho: {
    health: (o) => morpho.morphoHealth(o),
    markets: (o, a = {}) => morpho.morphoMarkets(a, o),
    vaults: (o, a = {}) => morpho.morphoVaults(a, o),
    prepareVault: (o, a = {}) => morpho.morphoPrepareVault(a, o),
  },
  balancer: {
    health: (o) => balancer.balancerHealth(o),
    pools: (o, a = {}) => balancer.balancerPools(a, o),
    quote: (o, a = {}) => balancer.balancerQuote(a, o),
    prepare: (o, a = {}) => balancer.balancerPrepare(a, o),
  },
  pendle: {
    health: (o) => pendle.pendleHealth(o),
    markets: (o, a = {}) => pendle.pendleMarkets(a, o),
    quote: (o, a = {}) => pendle.pendleQuote(a, o),
    prepare: (o, a = {}) => pendle.pendlePrepare(a, o),
  },
  odos: {
    health: (o) => odos.odosHealth(o),
    chains: (o) => odos.odosChains(o),
    quote: (o, a = {}) => odos.odosQuote(a, o),
    prepare: (o, a = {}) => odos.odosPrepare(a, o),
  },
  blockscout: {
    health: (o) => blockscout.blockscoutHealth(o),
    stats: (o, a = {}) => blockscout.blockscoutStats(a, o),
    address: (o, a = {}) => blockscout.blockscoutAddress(a, o),
    token: (o, a = {}) => blockscout.blockscoutToken(a, o),
  },
  paraswap: {
    health: (o) => paraswap.paraswapHealth(o),
    tokens: (o, a = {}) => paraswap.paraswapTokens(a, o),
    price: (o, a = {}) => paraswap.paraswapPrice(a, o),
    quote: (o, a = {}) => paraswap.paraswapPrice(a, o),
    prepare: (o, a = {}) => paraswap.paraswapPrepare(a, o),
  },
  rfq: {
    health: (o) => rfq.rfqHealth(o),
    intent: (o, a = {}) => rfq.rfqIntent(a, o),
    quote: (o, a = {}) => rfq.rfqQuote(a, o),
  },
  "polygon-staking": {
    health: (o) => polygonStaking.health(o),
    validators: (o, a = {}) => polygonStaking.validators(a, o),
    validatorDetail: (o, a = {}) => polygonStaking.validatorDetail(a, o),
  },
  "aave-v3": {
    health: (o) => aaveV3.aaveHealth(o),
    markets: (o, a = {}) => aaveV3.aaveMarkets(a, o),
    marketReserves: (o, a = {}) => aaveV3.aaveMarketReserves(a, o),
    chains: (o) => aaveV3.aaveChains(o),
  },
  "babylon-staking": {
    health: (o) => babylon.babylonHealth(o),
    stats: (o) => babylon.babylonStats(o),
    finalityProviders: (o) => babylon.babylonFinalityProviders(o),
    delegations: (o, a = {}) => babylon.babylonDelegations(a, o),
  },
  "bisq-markets": {
    health: (o) => bisq.bisqHealth(o),
    markets: (o) => bisq.bisqMarkets(o),
    ticker: (o, a = {}) => bisq.bisqTicker(a, o),
    trades: (o, a = {}) => bisq.bisqTrades(a, o),
  },
  "bob-rootstock": {
    health: (o, a = {}) => bobRootstock.btcL2Health(a.chainId, o),
    stats: (o, a = {}) => bobRootstock.btcL2Stats(a, o),
    addressInfo: (o, a = {}) => bobRootstock.btcL2AddressInfo(a, o),
    tokenBalances: (o, a = {}) => bobRootstock.btcL2TokenBalances(a, o),
  },
  "braiins-insights": {
    health: (o) => braiins.braiinsHealth(o),
    priceStats: (o) => braiins.braiinsPriceStats(o),
    poolStats: (o) => braiins.braiinsPoolStats(o),
  },
  "cow-protocol": {
    health: (o) => cowProtocol.cowProtocolHealth(o),
    auction: (o) => cowProtocol.cowAuction(o),
    openOrders: (o, a = {}) => cowProtocol.cowOpenOrders(a, o),
    recentTrades: (o, a = {}) => cowProtocol.cowRecentTrades(a, o),
  },
  "hiro-stacks": {
    health: (o) => hiroStacks.stacksHealth(o),
    networkInfo: (o) => hiroStacks.stacksNetworkInfo(o),
    stackingInfo: (o) => hiroStacks.stacksStackingInfo(o),
    poxCycles: (o) => hiroStacks.stacksPoxCycles(o),
    blocks: (o, a = {}) => hiroStacks.stacksBlocks(a, o),
  },
  "jito-mev": {
    health: (o) => jito.jitoHealth(o),
    recentBundles: (o, a = {}) => jito.jitoRecentBundles(a, o),
    tipFloor: (o) => jito.jitoTipFloor(o),
  },
  "kamino-strategies": {
    health: (o) => kamino.kaminoHealth(o),
    strategies: (o, a = {}) => kamino.kaminoStrategies(a, o),
    strategyMetrics: (o, a = {}) => kamino.kaminoStrategyMetrics(a, o),
  },
  "liquid-esplora": {
    health: (o) => liquid.liquidHealth(o),
    tipHeight: (o) => liquid.liquidTipHeight(o),
    addressInfo: (o, a = {}) => liquid.liquidAddressInfo(a, o),
    assetInfo: (o, a = {}) => liquid.liquidAssetInfo(a, o),
  },
  "magiceden-ordinals": {
    health: (o) => magicEdenOrd.magicEdenOrdHealth(o),
    collectionStat: (o, a = {}) => magicEdenOrd.magicEdenOrdCollectionStat(a, o),
  },
  "mempool-lightning": {
    health: (o) => mempoolLightning.lightningHealth(o),
    statistics: (o) => mempoolLightning.lightningStatistics(o),
    nodeRankings: (o, a = {}) => mempoolLightning.lightningNodeRankings(a, o),
    nodeCountries: (o) => mempoolLightning.lightningNodeCountries(o),
  },
  "mempool-mining": {
    health: (o) => mempoolMining.miningHealth(o),
    difficulty: (o) => mempoolMining.miningDifficulty(o),
    poolShare: (o, a = {}) => mempoolMining.miningPoolShare(a, o),
    hashrate: (o, a = {}) => mempoolMining.miningHashrate(a, o),
    rewardStats: (o, a = {}) => mempoolMining.miningRewardStats(a, o),
  },
  "meteora-dlmm": {
    health: (o) => meteora.meteoraHealth(o),
    pools: (o, a = {}) => meteora.meteoraPools(a, o),
    poolSearch: (o, a = {}) => meteora.meteoraPoolSearch(a, o),
  },
  "ordinals-runes": {
    health: (o) => ordinalsRunes.ordHealth(o),
    blockHeight: (o) => ordinalsRunes.ordBlockHeight(o),
    blockInfo: (o, a = {}) => ordinalsRunes.ordBlockInfo(a, o),
    satInfo: (o, a = {}) => ordinalsRunes.ordSatInfo(a, o),
    runeInfo: (o, a = {}) => ordinalsRunes.ordRuneInfo(a, o),
  },
  "pyth-price-feeds": {
    health: (o) => pyth.pythHealth(o),
    latestPrice: (o, a = {}) => pyth.pythLatestPrice(a, o),
    latestPrices: (o, a = {}) => pyth.pythLatestPrices(a, o),
    feedDirectory: (o) => pyth.pythFeedDirectory(o),
  },
  "relayscan-mev": {
    health: (o) => relayscan.relayscanHealth(o),
    overview: (o, a = {}) => relayscan.relayscanOverview(a, o),
    builderProfit: (o, a = {}) => relayscan.relayscanBuilderProfit(a, o),
    dailyStats: (o, a = {}) => relayscan.relayscanDailyStats(a, o),
  },
  "sanctum-lst": {
    health: (o) => sanctum.sanctumHealth(o),
    lstList: (o) => sanctum.sanctumLstList(o),
    apyAll: (o) => sanctum.sanctumApyAll(o),
    apyIndividual: (o, a = {}) => sanctum.sanctumApyIndividual(a, o),
  },
  "solend-lending": {
    health: (o) => solend.solendHealth(o),
    markets: (o) => solend.solendMarkets(o),
    reserves: (o, a = {}) => solend.solendReserves(a, o),
  },
  "across-bridge": {
    health: (o) => acrossBridge.acrossHealth(o),
    pools: (o, a = {}) => acrossBridge.acrossPools(a, o),
    suggestedFees: (o, a = {}) => acrossBridge.acrossSuggestedFees(a, o),
  },
  "beefy-yields": {
    health: (o) => beefyYields.beefyHealth(o),
    apy: (o, a = {}) => beefyYields.beefyApy(a, o),
    apyBreakdown: (o) => beefyYields.beefyApyBreakdown(o),
  },
  "birdeye-tokens": {
    health: (o) => birdeye.birdeyeHealth(o),
    tokenList: (o, a = {}) => birdeye.birdeyeTokenList(a, o),
  },
  "celestia-da": {
    health: (o) => celestia.celestiaHealth(o),
    stats: (o) => celestia.celestiaStats(o),
    blockStats: (o, a = {}) => celestia.celestiaBlockStats(a, o),
  },
  "das-assets": {
    health: (o) => dasAssets.dasHealth(o),
    assetsByOwner: (o, a = {}) => dasAssets.dasAssetsByOwner(a, o),
    searchAssets: (o, a = {}) => dasAssets.dasSearchAssets(a, o),
    assetProof: (o, a = {}) => dasAssets.dasAssetProof(a, o),
  },
  "l2beat-tvl": {
    health: (o) => l2beat.l2beatHealth(o),
    tvl: (o, a = {}) => l2beat.l2beatTvl(a, o),
    activity: (o, a = {}) => l2beat.l2beatActivity(a, o),
  },
  "spark-lend": {
    health: (o) => sparkLend.sparkHealth(o),
    markets: (o, a = {}) => sparkLend.sparkMarkets(a, o),
  },
  "symbiotic-restaking": {
    health: (o) => symbiotic.symbioticHealth(o),
    vaults: (o, a = {}) => symbiotic.symbioticVaults(a, o),
    vaultDetail: (o, a = {}) => symbiotic.symbioticVaultDetail(a, o),
  },
};

/**
 * Ops that create state at a third-party venue or produce a signable
 * authorization. They are NOT reads, and naming them `prepare*` does not make
 * them harmless — a prepared purchase intent is a real object at a real
 * marketplace, and a prepared EIP-712 action is one signature from settlement.
 */
const STATE_CREATING_OPS = new Set([
  "prepareBuilderApproval",
  "prepareBracket",
  "prepareIsolatedMargin",
  "prepareLeverage",
  "prepareCancel",
  "prepareOrder",
  "preparePurchase",
  "prepareList",
  "prepareSell",
  "prepareBuy",
  "prepareMint",
  "prepare",
  "prepareStakeDeposit",
  "prepareStakeWithdraw",
  "prepareDelegate",
  "prepareSwap",
  "prepareTransfer",
  "createOrder",
  "cancelOrder",
]);

/**
 * Is this op allowed on the read/prepare data plane?
 *
 * The previous implementation was a NAME regex, which is not a boundary: it
 * blocked `sendFoo` but allowed `txBroadcast`, `doSend`, `rawSign`,
 * `orderSubmit` and `forceExecute`, while blocking nothing that actually
 * mattered because every money-moving op here is named `prepare*`. The real
 * control is the catalog: a provider may only be asked for an op it declares.
 */
/**
 * Providers that SIGN and SUBMIT. These are not data-plane providers: the
 * read-only server must refuse them at the provider level, because a name-based
 * verb filter is not a boundary (`op:"trade"` matches no exec-sounding word).
 */
export const EXECUTION_PROVIDERS = new Set(["hl-exec"]);

/** True when the provider signs/submits and must never be served read-only. */
export function isExecutionProvider(providerId) {
  return EXECUTION_PROVIDERS.has(String(providerId || ""));
}

export function assertDataOpAllowed(providerId, op, args = {}) {
  const name = String(op || "");
  const key = `${providerId}.${name}`;

  if (EXECUTION_PROVIDERS.has(providerId)) {
    throw new Error(`data plane forbidden execution provider: ${providerId}`);
  }

  // 1. The op must be declared by the provider. This is the actual boundary —
  //    an undeclared op cannot be reached regardless of what it is called.
  //    Checked SECOND so that a write-shaped name gets the "forbidden" error
  //    rather than "not declared": callers (and tests) distinguish the two.
  const declared = listProviders().find((p) => p.id === providerId);

  // 2. Reject anything that reads as a settlement verb. Substring matching, so
  //    txBroadcast / doSend / orderSubmit / forceExecute cannot slip past word
  //    boundaries the way they did under the old anchored regex.
  if (/sign|execute|broadcast|submit|send|write|place/i.test(name) && !STATE_CREATING_OPS.has(name)) {
    throw new Error(`data plane forbidden op: ${key}`);
  }

  if (declared && Array.isArray(declared.ops) && declared.ops.length > 0) {
    if (!declared.ops.includes(name)) {
      throw new Error(`data plane: provider ${providerId} does not support op ${name}`);
    }
  }

  // 3. State-creating prepares are permitted on the data plane (that is its
  //    job) but must be visible as such to callers auditing behaviour.
  if (STATE_CREATING_OPS.has(name) && args && typeof args === "object") {
    Object.defineProperty(args, "__oracleStateCreating", { value: true, enumerable: false, configurable: true });
  }

  if (providerId === "evm-rpc" && name === "call") {
    const method = String(args?.method || "").trim();
    const allowed = new Set([
      "eth_call",
      "eth_getBalance",
      "eth_blockNumber",
      "eth_chainId",
      "eth_getCode",
      "eth_getLogs",
      "eth_getTransactionByHash",
      "eth_getTransactionReceipt",
      "eth_getBlockByNumber",
      "eth_getBlockByHash",
      "eth_feeHistory",
      "eth_gasPrice",
      "eth_maxPriorityFeePerGas",
      "net_version",
      "web3_clientVersion",
    ]);
    if (!allowed.has(method)) {
      throw new Error(`data plane allows only read-only JSON-RPC methods through evm-rpc.call: ${method || "<missing>"}`);
    }
  }
}

export async function dataCall(providerId, op, args = {}, opts = {}) {
  // dataCall is the READ plane, and it is what the package root exports. An
  // execution provider reached through here signs with a real key and submits
  // to a venue — with no grant check, no policy, no cap and no user-intent
  // proof. Blocking it only in the HTTP server left every package consumer and
  // agent wrapper calling root dataCall wide open.
  //
  if (isExecutionProvider(providerId)) {
    throw new Error(
      `${providerId} is an execution provider: it signs and submits with a real key. ` +
        "dataCall() is the public read plane and will not route to it."
    );
  }
  assertDataOpAllowed(providerId, op, args);
  const meta = getProvider(providerId);
  if (!meta) throw new Error(`Unknown data provider: ${providerId}`);
  if (!meta.ops.includes(op)) {
    throw new Error(`Provider ${providerId} does not support op '${op}' (has: ${meta.ops.join(", ")})`);
  }
  const table = OPS[providerId];
  if (!table || typeof table[op] !== "function") {
    throw new Error(`No client implementation for ${providerId}.${op}`);
  }
  return table[op](opts, args);
}

export async function dataHealth({ providers, fetchImpl, timeoutMs, includeRpc, includeWs, concurrency } = {}) {
  let ids = providers || listProviders().map((p) => p.id);
  // healthAll on evm-rpc is slow; default health uses ethereum only via "health"
  if (!includeRpc && !providers) {
    // keep evm-rpc but its health is chain 1 only — fine
  }
  // WS health opens sockets — opt-in unless explicit provider list
  if (!includeWs && !providers) {
    ids = ids.filter((id) => id !== "hl-ws" && id !== "poly-ws");
  }
  const opts = { fetchImpl, timeoutMs: timeoutMs ?? 8_000 };
  const out = {};
  // Bounded fan-out: an unbounded Promise.all across every provider trips public
  // rate limits (and makes one slow venue look like a global outage).
  await mapLimit(ids, concurrency ?? 8, async (id) => {
    if (!getProvider(id)) {
      out[id] = { ok: false, ms: 0, error: "unknown provider" };
      return;
    }
    const args = id === "evm-rpc" ? { chainId: 1 } : {};
    const result = await timed(() => dataCall(id, "health", args, opts));
    out[id] = result.ok
      ? { ok: true, ms: result.ms, detail: result.data }
      : { ok: false, ms: result.ms, error: result.error };
  });
  return { when: new Date().toISOString(), plane: "data", exec: false, providers: out };
}

export function dataCatalog() {
  return listProviders().map((p) => ({
    id: p.id,
    venue: p.venue,
    chainIds: p.chainIds,
    auth: p.auth,
    ops: p.ops,
    execution: p.execution || "read-only",
    description: p.description,
  }));
}

export const data = {
  catalog: dataCatalog,
  health: dataHealth,
  call: dataCall,
  hl: {
    health: (o) => dataCall("hl-info", "health", {}, o),
    allMids: (o) => dataCall("hl-info", "allMids", {}, o),
    l2Book: (coin, o) => dataCall("hl-info", "l2Book", { coin }, o),
    outcomeMeta: (o) => dataCall("hl-info", "outcomeMeta", {}, o),
    clearinghouse: (user, o) => dataCall("hl-info", "clearinghouse", { user }, o),
    userFills: (user, o) => dataCall("hl-info", "userFills", { user }, o),
    meta: (o) => dataCall("hl-info", "meta", {}, o),
    metaAndAssetCtxs: (o) => dataCall("hl-info", "metaAndAssetCtxs", {}, o),
    candleSnapshot: (a, o) => dataCall("hl-info", "candleSnapshot", a || {}, o),
    openOrders: (user, o) => dataCall("hl-info", "openOrders", { user }, o),
    userState: (user, o) => dataCall("hl-info", "userState", { user }, o),
    spotMeta: (o) => dataCall("hl-info", "spotMeta", {}, o),
    staking: {
      health: (o) => dataCall("hl-staking", "health", {}, o),
      validators: (o) => dataCall("hl-staking", "validators", {}, o),
      summary: (user, o) => dataCall("hl-staking", "delegatorSummary", { user }, o),
      delegations: (user, o) => dataCall("hl-staking", "delegations", { user }, o),
      rewards: (user, o) => dataCall("hl-staking", "rewards", { user }, o),
      history: (user, o) => dataCall("hl-staking", "history", { user }, o),
      preflight: (user, o) => dataCall("hl-staking", "preflight", { user }, o),
      prepareStake: (a, o) => dataCall("hl-staking", "prepareStakeDeposit", a || {}, o),
      prepareUnstake: (a, o) => dataCall("hl-staking", "prepareStakeWithdraw", a || {}, o),
      prepareDelegate: (a, o) => dataCall("hl-staking", "prepareDelegate", a || {}, o),
    },
  },
  poly: {
    health: (o) => dataCall("poly-public", "health", {}, o),
    time: (o) => dataCall("poly-public", "time", {}, o),
    markets: (a, o) => dataCall("poly-public", "markets", a || {}, o),
    book: (tokenId, o) => dataCall("poly-public", "book", { tokenId }, o),
    midpoint: (tokenId, o) => dataCall("poly-public", "midpoint", { tokenId }, o),
    spread: (tokenId, o) => dataCall("poly-public", "spread", { tokenId }, o),
    price: (tokenId, side, o) => dataCall("poly-public", "price", { tokenId, side }, o),
    events: (a, o) => dataCall("poly-public", "events", a || {}, o),
  },
  polyClob: {
    prepareOrder: (a, o) => dataCall("poly-clob", "prepareOrder", a || {}, o),
  },
  rh: {
    health: (o) => dataCall("rh-agent", "health", {}, o),
    policy: (o) => dataCall("rh-agent", "policy", {}, o),
    chainConfig: (o) => dataCall("rh-agent", "chainConfig", {}, o),
    chainGas: (o) => dataCall("rh-agent", "chainGas", {}, o),
    swapsConfig: (o) => dataCall("rh-agent", "swapsConfig", {}, o),
    tradingStatus: (o) => dataCall("rh-agent", "tradingStatus", {}, o),
    nftDrops: (o) => dataCall("rh-agent", "nftDrops", {}, o),
  },
  rpc: {
    health: (chainId, o) => dataCall("evm-rpc", "health", { chainId }, o),
    healthAll: (a, o) => dataCall("evm-rpc", "healthAll", a || {}, o),
    blockNumber: (chainId, o) => dataCall("evm-rpc", "blockNumber", { chainId }, o),
    getBalance: (chainId, address, o) => dataCall("evm-rpc", "getBalance", { chainId, address }, o),
    call: (chainId, method, params, o) =>
      dataCall("evm-rpc", "call", { chainId, method, params }, o),
  },
  portfolio: {
    balance: (a, o) => dataCall("portfolio", "balances", a || {}, o),
    snapshot: (a, o) => dataCall("portfolio", "snapshot", a || {}, o),
    history: (a, o) => dataCall("portfolio", "history", a || {}, o),
    valueGraph: (a, o) => dataCall("portfolio", "valueGraph", a || {}, o),
  },
  nft: {
    inventory: (a, o) => dataCall("nft-portfolio", "inventory", a || {}, o),
    gallery: (a, o) => dataCall("nft-portfolio", "gallery", a || {}, o),
    pnl: (a, o) => dataCall("nft-portfolio", "pnl", a || {}, o),
    prepareList: (a, o) => dataCall("nft-portfolio", "prepareList", a || {}, o),
    floor: (slug, o) => dataCall("opensea-nft", "floor", { slug }, o),
    collection: (slug, o) => dataCall("opensea-nft", "collection", { slug }, o),
  },
  solana: {
    health: (o) => dataCall("solana-rpc", "health", {}, o),
    latestBlockhash: (a, o) => dataCall("solana-rpc", "latestBlockhash", a || {}, o),
    balance: (address, o) => dataCall("solana-rpc", "getBalance", { address }, o),
    tokenAccounts: (a, o) => dataCall("solana-rpc", "tokenAccounts", a || {}, o),
    simulate: (a, o) => dataCall("solana-rpc", "simulate", a || {}, o),
    jupiterQuote: (a, o) => dataCall("jupiter", "quote", a || {}, o),
    jupiterPrepare: (a, o) => dataCall("jupiter", "prepare", a || {}, o),
    nftStats: (a, o) => dataCall("magiceden-sol", "stats", a || {}, o),
    nftListings: (a, o) => dataCall("magiceden-sol", "listings", a || {}, o),
    nftTokenListings: (a, o) => dataCall("magiceden-sol", "tokenListings", a || {}, o),
    nftPrepareBuy: (a, o) => dataCall("magiceden-sol", "prepareBuy", a || {}, o),
    nftPrepareList: (a, o) => dataCall("magiceden-sol", "prepareList", a || {}, o),
    nftPrepareMint: (a, o) => dataCall("magiceden-sol", "prepareMint", a || {}, o),
  },
  bitcoin: {
    health: (o) => dataCall("bitcoin-esplora", "health", {}, o),
    tipHeight: (o) => dataCall("bitcoin-esplora", "tipHeight", {}, o),
    fees: (o) => dataCall("bitcoin-esplora", "fees", {}, o),
    address: (address, o) => dataCall("bitcoin-esplora", "address", { address }, o),
    utxos: (address, o) => dataCall("bitcoin-esplora", "utxos", { address }, o),
    tx: (txid, o) => dataCall("bitcoin-esplora", "tx", { txid }, o),
    decode: (a, o) => dataCall("bitcoin-esplora", "decode", a || {}, o),
    metaHealth: (o) => dataCall("bitcoin-meta", "health", {}, o),
    runeBalances: (address, o) => dataCall("bitcoin-meta", "runeBalances", { address }, o),
    inscriptions: (address, o) => dataCall("bitcoin-meta", "inscriptions", { address }, o),
    satflowHealth: (o) => dataCall("satflow", "health", {}, o),
    satflowFloors: (a, o) => dataCall("satflow", "collectionFloors", a || {}, o),
    satflowWallet: (address, o) => dataCall("satflow", "walletContents", { address }, o),
  },
  prices: {
    health: (o) => dataCall("defillama", "health", {}, o),
    current: (coins, o) => dataCall("defillama", "prices", { coins }, o),
    bySymbol: (symbols, o) => dataCall("defillama", "pricesBySymbol", { symbols }, o),
    protocols: (o) => dataCall("defillama", "protocols", {}, o),
  },
  lifi: {
    health: (o) => dataCall("lifi", "health", {}, o),
    quote: (a, o) => dataCall("lifi", "quote", a || {}, o),
    chains: (o) => dataCall("lifi", "chains", {}, o),
  },
  dex: {
    health: (o) => dataCall("dexscreener", "health", {}, o),
    token: (address, o) => dataCall("dexscreener", "token", { address }, o),
    search: (q, o) => dataCall("dexscreener", "search", { q }, o),
    pair: (chainId, pairAddress, o) =>
      dataCall("dexscreener", "pair", { chainId, pairAddress }, o),
  },
  uni: {
    health: (a, o) => dataCall("uniswap-v3", "health", a || {}, o),
    quote: (a, o) => dataCall("uniswap-v3", "quote", a || {}, o),
    quotePath: (a, o) => dataCall("uniswap-v3", "quotePath", a || {}, o),
    ethUsdc: (a, o) => dataCall("uniswap-v3", "ethUsdc", a || {}, o),
    chains: (o) => dataCall("uniswap-v3", "chains", {}, o),
  },
  univ4: {
    health: (a, o) => dataCall("uniswap-v4", "health", a || {}, o),
    quote: (a, o) => dataCall("uniswap-v4", "quote", a || {}, o),
    chains: (o) => dataCall("uniswap-v4", "chains", {}, o),
  },
  bridges: {
    across: (a, o) => dataCall("across", "suggestedFees", a || {}, o),
    hop: (a, o) => dataCall("hop", "quote", a || {}, o),
    relay: (a, o) => dataCall("relay", "quote", a || {}, o),
  },
  cow: {
    quote: (a, o) => dataCall("cowswap", "quote", a || {}, o),
  },
  hlWs: {
    allMids: (o) => dataCall("hl-ws", "allMids", {}, o),
    l2Book: (coin, o) => dataCall("hl-ws", "l2Book", { coin }, o),
  },
  polyWs: {
    book: (assetId, o) => dataCall("poly-ws", "book", { assetId }, o),
  },
};
