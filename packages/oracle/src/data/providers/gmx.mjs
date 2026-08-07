// GMX v2 public API + guarded async order-intent prepare. Arbitrum + Avalanche, no key.
// GMX order creation is asynchronous: user tx creates an order, keepers later execute/cancel it.
// This provider prepares reviewed calldata + approval metadata only; executionReady stays false until a separate signer-bound GMX policy exists.
import { Interface, getAddress, isAddress } from "ethers";
import { httpJson } from "../http.mjs";
import { rpcCall as defaultRpcCall, transactionReceipt } from "./evm-rpc.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";

export const GMX_API = Object.freeze({
  42161: "https://arbitrum-api.gmxinfra.io",
  43114: "https://avalanche-api.gmxinfra.io",
});

export const GMX_V2_CHAINS = Object.freeze({
  42161: {
    name: "arbitrum",
    api: GMX_API[42161],
    exchangeRouter: "0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41",
    router: "0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6",
    orderVault: "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5",
    dataStore: "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8",
    reader: "0x470fbC46bcC0f16532691Df360A07d8Bf5ee0789",
    eventEmitter: "0xC8ee91A54287DB53897056e12D9819156D3822Fb",
    wnt: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  43114: {
    name: "avalanche",
    api: GMX_API[43114],
    exchangeRouter: "0x8f550E53DFe96C055D5Bdb267c21F268fCAF63B2",
    router: "0x820F5FfC5b525cD4d88Cd91aCf2c28F16530Cc68",
    orderVault: "0xD3D60D22d415aD43b7e64b510D86A30f19B1B12C",
    dataStore: "0x2F0b22339414ADeD7D5F06f9D604c7fF5b2fe3f6",
    reader: "0x62Cb8740E6986B29dC671B2EB596676f60590A5B",
    eventEmitter: "0xDb17B211c34240B014ab6d61d4A31FA0C0e20c26",
    wnt: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  },
});

const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

const ORDER_TYPES = Object.freeze({
  marketSwap: 0,
  limitSwap: 1,
  marketIncrease: 2,
  limitIncrease: 3,
  marketDecrease: 4,
  limitDecrease: 5,
  stopLossDecrease: 6,
  stopIncrease: 8,
});

const DECREASE_SWAP_TYPES = Object.freeze({
  noSwap: 0,
  swapPnlTokenToCollateralToken: 1,
  swapCollateralTokenToPnlToken: 2,
});

export const GMX_EXCHANGE_ROUTER_IFACE = new Interface([
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function sendTokens(address token,address receiver,uint256 amount) payable",
  "function sendWnt(address receiver,uint256 amount) payable",
  "function createOrder(((address receiver,address cancellationReceiver,address callbackContract,address uiFeeReceiver,address market,address initialCollateralToken,address[] swapPath) addresses,(uint256 sizeDeltaUsd,uint256 initialCollateralDeltaAmount,uint256 triggerPrice,uint256 acceptablePrice,uint256 executionFee,uint256 callbackGasLimit,uint256 minOutputAmount,uint256 validFromTime) numbers,uint8 orderType,uint8 decreasePositionSwapType,bool isLong,bool shouldUnwrapNativeToken,bool autoCancel,bytes32 referralCode,bytes32[] dataList) params) payable returns (bytes32)",
  "function cancelOrder(bytes32 key) payable",
]);

const GMX_READER_IFACE = new Interface([
  "function getAccountPositions(address dataStore,address account,uint256 start,uint256 end) view returns (bytes)",
  "function getAccountOrders(address dataStore,address account,uint256 start,uint256 end) view returns (bytes)",
  "function getOrder(address dataStore,bytes32 key) view returns (bytes)",
]);

const GMX_EVENT_IFACE = new Interface([
  "event EventLog1(address msgSender,string eventName,string indexed eventNameHash,bytes32 indexed topic1,((tuple(string key,address value)[] items,tuple(string key,address[] value)[] arrayItems),(tuple(string key,uint256 value)[] items,tuple(string key,uint256[] value)[] arrayItems),(tuple(string key,int256 value)[] items,tuple(string key,int256[] value)[] arrayItems),(tuple(string key,bool value)[] items,tuple(string key,bool[] value)[] arrayItems),(tuple(string key,bytes32 value)[] items,tuple(string key,bytes32[] value)[] arrayItems),(tuple(string key,bytes value)[] items,tuple(string key,bytes[] value)[] arrayItems),(tuple(string key,string value)[] items,tuple(string key,string[] value)[] arrayItems)) eventData)",
  "event EventLog2(address msgSender,string eventName,string indexed eventNameHash,bytes32 indexed topic1,bytes32 indexed topic2,((tuple(string key,address value)[] items,tuple(string key,address[] value)[] arrayItems),(tuple(string key,uint256 value)[] items,tuple(string key,uint256[] value)[] arrayItems),(tuple(string key,int256 value)[] items,tuple(string key,int256[] value)[] arrayItems),(tuple(string key,bool value)[] items,tuple(string key,bool[] value)[] arrayItems),(tuple(string key,bytes32 value)[] items,tuple(string key,bytes32[] value)[] arrayItems),(tuple(string key,bytes value)[] items,tuple(string key,bytes[] value)[] arrayItems),(tuple(string key,string value)[] items,tuple(string key,string[] value)[] arrayItems)) eventData)",
]);

const ORDER_LIFECYCLE_STATUS = Object.freeze({
  OrderCreated: "created",
  OrderUpdated: "updated",
  OrderExecuted: "executed",
  OrderCancelled: "cancelled",
  OrderFrozen: "frozen",
});

function metaFor(chainId) {
  const id = Number(chainId ?? 42161);
  const meta = GMX_V2_CHAINS[id];
  if (!meta) throw new Error(`gmx: unsupported chainId ${chainId} (supported: ${Object.keys(GMX_V2_CHAINS).join(", ")})`);
  return { chainId: id, ...meta };
}

function base(chainId, o = {}) {
  const meta = metaFor(chainId);
  return (o.baseUrl || meta.api).replace(/\/$/, "");
}

function addr(value, label) {
  if (!isAddress(value)) throw new Error(`${label} must be a valid EVM address`);
  return getAddress(value);
}

function lower(value) {
  return getAddress(value).toLowerCase();
}

function positive(value, label) {
  let n;
  try {
    n = BigInt(String(value));
  } catch {
    throw new Error(`${label} must be an integer string`);
  }
  if (n <= 0n) throw new Error(`${label} must be positive`);
  return n;
}

function nonnegative(value, label) {
  let n;
  try {
    n = BigInt(String(value ?? "0"));
  } catch {
    throw new Error(`${label} must be an integer string`);
  }
  if (n < 0n) throw new Error(`${label} must be non-negative`);
  return n;
}

function bps(value, fallback = 50) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error("gmx maxSlippageBps must be 0..100");
  return Math.floor(n);
}

function orderType(value) {
  const key = String(value || "marketIncrease").trim();
  if (!(key in ORDER_TYPES)) throw new Error(`gmx unsupported orderType ${key}`);
  if (!["marketIncrease", "marketDecrease"].includes(key)) {
    throw new Error("gmx prepare currently supports marketIncrease and marketDecrease only");
  }
  return { key, code: ORDER_TYPES[key] };
}

function decreaseSwapType(value) {
  const key = String(value || "noSwap").trim();
  if (!(key in DECREASE_SWAP_TYPES)) throw new Error(`gmx unsupported decreasePositionSwapType ${key}`);
  return { key, code: DECREASE_SWAP_TYPES[key] };
}

function asList(data, field) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[field])) return data[field];
  return [];
}

function findMarket(markets, marketAddress) {
  const target = lower(marketAddress);
  return markets.find((m) => lower(m.marketToken || m.market || m.address) === target) || null;
}

function tickerFor(tickers, token) {
  const target = lower(token);
  return tickers.find((t) => lower(t.tokenAddress || t.address) === target) || null;
}

function priceWithSlippage({ ticker, isLong, typeKey, maxSlippageBps }) {
  const min = positive(ticker?.minPrice, "gmx minPrice");
  const max = positive(ticker?.maxPrice, "gmx maxPrice");
  const slip = BigInt(maxSlippageBps);
  const denom = 10_000n;
  if (typeKey === "marketIncrease") {
    return (isLong ? (max * (denom + slip)) / denom : (min * (denom - slip)) / denom).toString();
  }
  return (isLong ? (min * (denom - slip)) / denom : (max * (denom + slip)) / denom).toString();
}

function liquidityFor(market, isLong) {
  const raw = isLong ? market.availableLiquidityLong : market.availableLiquidityShort;
  try {
    return BigInt(String(raw ?? "0"));
  } catch {
    return 0n;
  }
}

function bytes32Address(value) {
  const text = String(value || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(text)) return null;
  return `0x${text.slice(-40)}`;
}

function itemValue(section, key, normalizer = (x) => x) {
  const items = Array.from(section?.items || section?.[0] || []);
  const found = items.find((item) => String(item?.key ?? item?.[0] ?? "") === key);
  return found ? normalizer(found.value ?? found[1]) : null;
}

function dataItems(eventData = {}) {
  const addressItems = eventData.addressItems || eventData[0];
  const uintItems = eventData.uintItems || eventData[1];
  const boolItems = eventData.boolItems || eventData[3];
  const bytes32Items = eventData.bytes32Items || eventData[4];
  const stringItems = eventData.stringItems || eventData[6];
  return {
    account: itemValue(addressItems, "account", (v) => lower(v)),
    market: itemValue(addressItems, "market", (v) => lower(v)),
    initialCollateralToken: itemValue(addressItems, "initialCollateralToken", (v) => lower(v)),
    key: itemValue(bytes32Items, "key", (v) => String(v).toLowerCase()),
    reason: itemValue(stringItems, "reason", (v) => String(v)),
    sizeDeltaUsd: itemValue(uintItems, "sizeDeltaUsd", (v) => BigInt(v).toString()),
    initialCollateralDeltaAmount: itemValue(uintItems, "initialCollateralDeltaAmount", (v) => BigInt(v).toString()),
    executionFee: itemValue(uintItems, "executionFee", (v) => BigInt(v).toString()),
    acceptablePrice: itemValue(uintItems, "acceptablePrice", (v) => BigInt(v).toString()),
    isLong: itemValue(boolItems, "isLong", (v) => Boolean(v)),
  };
}

function parseGmxLifecycleEvent(log = {}, meta) {
  if (lower(log.address) !== lower(meta.eventEmitter)) return null;
  let parsed;
  try {
    parsed = GMX_EVENT_IFACE.parseLog({ topics: log.topics, data: log.data });
  } catch {
    return null;
  }
  const eventName = String(parsed?.args?.eventName || "");
  const status = ORDER_LIFECYCLE_STATUS[eventName];
  if (!status) return null;
  const items = dataItems(parsed.args.eventData || {});
  const orderKey = (items.key || String(parsed.args.topic1 || "")).toLowerCase();
  const account = items.account || bytes32Address(parsed.args.topic2);
  return {
    eventName,
    status,
    orderKey,
    account: account ? lower(account) : null,
    market: items.market,
    initialCollateralToken: items.initialCollateralToken,
    sizeDeltaUsd: items.sizeDeltaUsd,
    initialCollateralDeltaAmount: items.initialCollateralDeltaAmount,
    executionFee: items.executionFee,
    acceptablePrice: items.acceptablePrice,
    isLong: items.isLong,
    reason: items.reason,
    logIndex: log.logIndex == null ? null : Number.parseInt(String(log.logIndex), 16),
  };
}

function lifecycleRank(status) {
  return { executed: 5, cancelled: 4, frozen: 3, created: 2, updated: 1 }[status] || 0;
}

export function parseGmxOrderEvents(logs = [], { chainId } = {}) {
  const meta = metaFor(chainId);
  return (Array.isArray(logs) ? logs : [])
    .map((log) => parseGmxLifecycleEvent(log, meta))
    .filter(Boolean)
    .sort((a, b) => (a.logIndex ?? 0) - (b.logIndex ?? 0));
}

export async function gmxMarkets(args = {}, opts = {}) {
  return httpJson(`${base(args.chainId ?? 42161, opts)}/markets`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
}

export async function gmxMarketsInfo(args = {}, opts = {}) {
  return httpJson(`${base(args.chainId ?? 42161, opts)}/markets/info`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
}

export async function gmxTokens(args = {}, opts = {}) {
  return httpJson(`${base(args.chainId ?? 42161, opts)}/tokens`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
}

export async function gmxTickers(args = {}, opts = {}) {
  return httpJson(`${base(args.chainId ?? 42161, opts)}/prices/tickers`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
}

export async function gmxHealth(opts = {}) {
  const data = await gmxTickers({ chainId: 42161 }, opts);
  return { ok: Array.isArray(data) && data.length > 0, tickerSample: Array.isArray(data) ? data.length : 0 };
}

export async function gmxPositions(args = {}, opts = {}) {
  const meta = metaFor(args.chainId ?? 42161);
  const account = addr(args.account || args.owner || args.user, "gmx account");
  const start = nonnegative(args.start ?? 0, "gmx start");
  const end = nonnegative(args.end ?? args.limit ?? 20, "gmx end");
  const data = GMX_READER_IFACE.encodeFunctionData("getAccountPositions", [meta.dataStore, account, start, end]);
  const call = opts.rpcCall || defaultRpcCall;
  const raw = await call(meta.chainId, "eth_call", [{ to: meta.reader, data }, args.blockTag || "latest"], opts);
  return { provider: "gmx", chainId: meta.chainId, reader: lower(meta.reader), dataStore: lower(meta.dataStore), account: lower(account), raw };
}

export async function gmxOrderStatus(args = {}, opts = {}) {
  const meta = metaFor(args.chainId ?? 42161);
  const key = String(args.key || args.orderKey || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("gmx order key must be bytes32 hex");
  const data = GMX_READER_IFACE.encodeFunctionData("getOrder", [meta.dataStore, key]);
  const call = opts.rpcCall || defaultRpcCall;
  const raw = await call(meta.chainId, "eth_call", [{ to: meta.reader, data }, args.blockTag || "latest"], opts);
  return { provider: "gmx", chainId: meta.chainId, reader: lower(meta.reader), dataStore: lower(meta.dataStore), key, raw };
}

export async function gmxVerifyOrderReceipt(args = {}, opts = {}) {
  const meta = metaFor(args.chainId ?? 42161);
  const receipt = opts.receipt || await transactionReceipt({
    chainId: meta.chainId,
    txHash: args.txHash,
    expectedTo: args.expectedTo || meta.exchangeRouter,
  }, opts);
  const txHash = String(args.txHash || receipt.txHash || "").toLowerCase();
  if (receipt.ok !== true) {
    return { ok: false, provider: "gmx", chainId: meta.chainId, txHash, status: receipt.status || "unknown", reason: receipt.reason || "receipt not successful", receipt };
  }
  const events = parseGmxOrderEvents(receipt.logs || [], { chainId: meta.chainId });
  const expectedKey = args.expectedOrderKey || args.orderKey ? String(args.expectedOrderKey || args.orderKey).toLowerCase() : null;
  const relevant = expectedKey ? events.filter((event) => event.orderKey === expectedKey) : events;
  if (relevant.length === 0) {
    return { ok: false, provider: "gmx", chainId: meta.chainId, txHash, status: "unknown", reason: expectedKey ? "order key not found in GMX EventEmitter logs" : "no GMX order lifecycle event found", events, receipt };
  }
  const best = relevant.reduce((prev, event) => lifecycleRank(event.status) >= lifecycleRank(prev.status) ? event : prev, relevant[0]);
  const expectedAccount = args.expectedAccount || args.account ? lower(args.expectedAccount || args.account) : null;
  if (expectedAccount && best.account !== expectedAccount) {
    return { ok: false, provider: "gmx", chainId: meta.chainId, txHash, status: best.status, reason: `account mismatch: expected ${expectedAccount}, got ${best.account || "null"}`, orderKey: best.orderKey, account: best.account, events, receipt };
  }
  return {
    ok: true,
    provider: "gmx",
    chainId: meta.chainId,
    txHash,
    status: best.status,
    orderKey: best.orderKey,
    account: best.account,
    market: best.market,
    eventEmitter: lower(meta.eventEmitter),
    events: relevant,
    receipt,
  };
}

export async function gmxPrepareOrder(args = {}, opts = {}) {
  const meta = metaFor(args.chainId ?? 42161);
  const type = orderType(args.orderType || args.type);
  const decSwap = decreaseSwapType(args.decreasePositionSwapType);
  const account = addr(args.account || args.owner || args.from || args.sender || args.receiver, "gmx account");
  const receiver = addr(args.receiver || account, "gmx receiver");
  const cancellationReceiver = addr(args.cancellationReceiver || receiver, "gmx cancellationReceiver");
  const callbackContract = args.callbackContract ? addr(args.callbackContract, "gmx callbackContract") : ZERO;
  const uiFeeReceiver = args.uiFeeReceiver ? addr(args.uiFeeReceiver, "gmx uiFeeReceiver") : ZERO;
  const marketAddress = addr(args.market || args.marketToken, "gmx market");
  const collateral = addr(args.initialCollateralToken || args.collateralToken || meta.usdc, "gmx initialCollateralToken");
  const collateralAmount = type.key === "marketIncrease"
    ? positive(args.initialCollateralDeltaAmount ?? args.collateralAmount ?? args.amountIn, "gmx initialCollateralDeltaAmount")
    : nonnegative(args.initialCollateralDeltaAmount ?? args.collateralAmount ?? "0", "gmx initialCollateralDeltaAmount");
  const sizeDeltaUsd = positive(args.sizeDeltaUsd, "gmx sizeDeltaUsd");
  const executionFee = positive(args.executionFee, "gmx executionFee");
  const maxExecutionFeeWei = BigInt(String(args.maxExecutionFeeWei ?? "10000000000000000"));
  if (executionFee > maxExecutionFeeWei) throw new Error("gmx executionFee exceeds maxExecutionFeeWei");
  const maxSizeDeltaUsd = BigInt(String(args.maxSizeDeltaUsd ?? "50000000000000000000000000000000000"));
  if (sizeDeltaUsd > maxSizeDeltaUsd) throw new Error("gmx sizeDeltaUsd exceeds maxSizeDeltaUsd");
  const slip = bps(args.maxSlippageBps ?? args.slippageBps, 50);
  const isLong = args.isLong == null ? true : Boolean(args.isLong);

  const [marketEnvelope, tickers] = await Promise.all([
    gmxMarketsInfo({ chainId: meta.chainId }, opts),
    gmxTickers({ chainId: meta.chainId }, opts),
  ]);
  const market = findMarket(asList(marketEnvelope, "markets"), marketAddress);
  if (!market) throw new Error("gmx market not found in public registry");
  if (market.isListed === false) throw new Error("gmx market is not listed");
  const indexToken = addr(market.indexToken, "gmx market indexToken");
  const longToken = addr(market.longToken, "gmx market longToken");
  const shortToken = addr(market.shortToken, "gmx market shortToken");
  const collLower = lower(collateral);
  if (![lower(longToken), lower(shortToken)].includes(collLower)) {
    throw new Error("gmx collateral token must match market longToken or shortToken for this guarded slice");
  }
  const available = liquidityFor(market, isLong);
  if (available > 0n && sizeDeltaUsd > available) throw new Error("gmx sizeDeltaUsd exceeds available market liquidity");
  const ticker = tickerFor(tickers, indexToken);
  if (!ticker) throw new Error("gmx index ticker not found");
  const acceptablePrice = args.acceptablePrice
    ? positive(args.acceptablePrice, "gmx acceptablePrice").toString()
    : priceWithSlippage({ ticker, isLong, typeKey: type.key, maxSlippageBps: slip });

  const swapPath = (args.swapPath || []).map((x) => addr(x, "gmx swapPath market"));
  if (swapPath.length > 3) throw new Error("gmx swapPath too long for guarded slice");
  const triggerPrice = nonnegative(args.triggerPrice ?? "0", "gmx triggerPrice");
  const callbackGasLimit = nonnegative(args.callbackGasLimit ?? "0", "gmx callbackGasLimit");
  const minOutputAmount = nonnegative(args.minOutputAmount ?? "0", "gmx minOutputAmount");
  const validFromTime = nonnegative(args.validFromTime ?? "0", "gmx validFromTime");
  const shouldUnwrapNativeToken = Boolean(args.shouldUnwrapNativeToken);
  const autoCancel = args.autoCancel == null ? true : Boolean(args.autoCancel);
  const referralCode = String(args.referralCode || ZERO_BYTES32);
  if (!/^0x[0-9a-fA-F]{64}$/.test(referralCode)) throw new Error("gmx referralCode must be bytes32 hex");
  const dataList = Array.isArray(args.dataList) ? args.dataList : [];
  for (const item of dataList) if (!/^0x[0-9a-fA-F]{64}$/.test(String(item))) throw new Error("gmx dataList entries must be bytes32 hex");

  const params = {
    addresses: {
      receiver,
      cancellationReceiver,
      callbackContract,
      uiFeeReceiver,
      market: marketAddress,
      initialCollateralToken: collateral,
      swapPath,
    },
    numbers: {
      sizeDeltaUsd,
      initialCollateralDeltaAmount: collateralAmount,
      triggerPrice,
      acceptablePrice: BigInt(acceptablePrice),
      executionFee,
      callbackGasLimit,
      minOutputAmount,
      validFromTime,
    },
    orderType: type.code,
    decreasePositionSwapType: decSwap.code,
    isLong,
    shouldUnwrapNativeToken,
    autoCancel,
    referralCode,
    dataList,
  };
  const calls = [];
  if (type.key === "marketIncrease" && collateralAmount > 0n) {
    calls.push(GMX_EXCHANGE_ROUTER_IFACE.encodeFunctionData("sendTokens", [collateral, meta.orderVault, collateralAmount]));
  }
  calls.push(GMX_EXCHANGE_ROUTER_IFACE.encodeFunctionData("sendWnt", [meta.orderVault, executionFee]));
  calls.push(GMX_EXCHANGE_ROUTER_IFACE.encodeFunctionData("createOrder", [params]));
  const data = GMX_EXCHANGE_ROUTER_IFACE.encodeFunctionData("multicall", [calls]);
  const gmxGuard = {
    mode: "gmx-order",
    provider: "gmx",
    chainId: meta.chainId,
    chain: meta.name,
    orderType: type.key,
    orderTypeCode: type.code,
    decreasePositionSwapType: decSwap.key,
    account: lower(account),
    receiver: lower(receiver),
    exchangeRouter: lower(meta.exchangeRouter),
    router: lower(meta.router),
    orderVault: lower(meta.orderVault),
    market: lower(marketAddress),
    indexToken: lower(indexToken),
    initialCollateralToken: lower(collateral),
    initialCollateralDeltaAmount: collateralAmount.toString(),
    sizeDeltaUsd: sizeDeltaUsd.toString(),
    executionFee: executionFee.toString(),
    acceptablePrice,
    maxSlippageBps: slip,
    isLong,
    asyncExecution: true,
    issuedAtMs: Number(opts.nowMs ?? Date.now()),
  };
  return stampPrepared({
    provider: "gmx",
    chainId: meta.chainId,
    chain: meta.name,
    orderReady: true,
    executionReady: false,
    asyncExecution: true,
    orderType: type.key,
    market: lower(marketAddress),
    requiresApproval: type.key === "marketIncrease" && collateralAmount > 0n ? {
      token: lower(collateral),
      spender: lower(meta.router),
      amount: collateralAmount.toString(),
    } : null,
    gmxGuard,
    transaction: {
      chainId: meta.chainId,
      from: lower(account),
      to: lower(meta.exchangeRouter),
      data,
      value: executionFee.toString(),
      gmxGuard,
    },
  }, { provider: "gmx", kind: "gmx-order" });
}
