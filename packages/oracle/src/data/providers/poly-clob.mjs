import { stampPrepared } from "../../prepare-envelope.mjs";
// Polymarket CLOB — prepare-only for Oracle.
// Builds unsigned EIP-712 order envelopes (no keys).
// Sign/post live in @oracle-agent/operator poly-exec only.
// Deep-import sign/post helpers hard-refuse here.

import { createHmac, randomInt } from "node:crypto";
import {
  keccak256,
  concat,
  zeroPadValue,
  getCreate2Address,
  AbiCoder,
} from "ethers";

export const POLY_CHAIN_ID = 137;
export const POLY_CLOB_REST = "https://clob.polymarket.com";

const CTF_EXCHANGE_V2 = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK_CTF_EXCHANGE_V2 = "0xe2222d279d744050d28e00520010520000310F59";
const BYTES32_ZERO =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const COLLATERAL_DECIMALS = 6;

// Deposit wallet CREATE2 (Polymarket relayer)
const DEPOSIT_WALLET_FACTORY = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
const DEPOSIT_WALLET_IMPLEMENTATION = "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB";
const ERC1967_CONST1 = "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";
const ERC1967_CONST2 = "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076";
const ERC1967_PREFIX = 0x61003d3d8160233d3973n;

const EIP712_DOMAIN_V2 = {
  name: "Polymarket CTF Exchange",
  version: "2",
  chainId: POLY_CHAIN_ID,
};

const ORDER_TYPES_V2 = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
};

const ROUNDING_CONFIG = {
  "0.1": { price: 1, size: 2, amount: 3 },
  "0.01": { price: 2, size: 2, amount: 4 },
  "0.001": { price: 3, size: 2, amount: 5 },
  "0.0001": { price: 4, size: 2, amount: 6 },
};

function _initCodeHashERC1967(implementation, args) {
  const argHex = args.startsWith("0x") ? args.slice(2) : args;
  const n = BigInt(argHex.length / 2);
  const combined = ERC1967_PREFIX + (n << 56n);
  const prefixHex = "0x" + combined.toString(16).padStart(20, "0");
  return keccak256(concat([prefixHex, implementation, "0x6009", ERC1967_CONST2, ERC1967_CONST1, args]));
}

/** Deterministic Polymarket deposit wallet for an EOA (Polygon). */
export function deriveDepositWallet(owner) {
  const walletId = zeroPadValue(String(owner).toLowerCase(), 32);
  const args = AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes32"],
    [DEPOSIT_WALLET_FACTORY, walletId]
  );
  const salt = keccak256(args);
  const bytecodeHash = _initCodeHashERC1967(DEPOSIT_WALLET_IMPLEMENTATION, args);
  return getCreate2Address(DEPOSIT_WALLET_FACTORY, salt, bytecodeHash);
}

function decimalPlaces(n) {
  const s = String(n);
  if (!s.includes(".")) return 0;
  return s.split(".")[1].replace(/0+$/, "").length;
}

function roundDown(n, dp) {
  const f = 10 ** dp;
  return Math.floor(n * f + 1e-12) / f;
}

function roundUp(n, dp) {
  const f = 10 ** dp;
  return Math.ceil(n * f - 1e-12) / f;
}

function roundNormal(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f + Number.EPSILON) / f;
}

/** Official-client-style maker/taker raw amounts (decimal, not fixed-point). */
export function getOrderRawAmounts(side, size, price, roundConfig) {
  const rawPrice = roundNormal(Number(price), roundConfig.price);
  const isBuy = side === "BUY";

  if (isBuy) {
    const rawTakerAmt = roundDown(Number(size), roundConfig.size);
    let rawMakerAmt = rawTakerAmt * rawPrice;
    if (decimalPlaces(rawMakerAmt) > roundConfig.amount) {
      rawMakerAmt = roundUp(rawMakerAmt, roundConfig.amount + 4);
      if (decimalPlaces(rawMakerAmt) > roundConfig.amount) {
        rawMakerAmt = roundDown(rawMakerAmt, roundConfig.amount);
      }
    }
    return { rawMakerAmt, rawTakerAmt };
  }

  const rawMakerAmt = roundDown(Number(size), roundConfig.size);
  let rawTakerAmt = rawMakerAmt * rawPrice;
  if (decimalPlaces(rawTakerAmt) > roundConfig.amount) {
    rawTakerAmt = roundUp(rawTakerAmt, roundConfig.amount + 4);
    if (decimalPlaces(rawTakerAmt) > roundConfig.amount) {
      rawTakerAmt = roundDown(rawTakerAmt, roundConfig.amount);
    }
  }
  return { rawMakerAmt, rawTakerAmt };
}

export function toRawAmountStr(value) {
  const str = Number(value).toFixed(COLLATERAL_DECIMALS);
  const [integer, fraction = ""] = str.split(".");
  const raw = integer + fraction.padEnd(COLLATERAL_DECIMALS, "0").slice(0, COLLATERAL_DECIMALS);
  return raw.replace(/^0+/, "") || "0";
}

export function buildHmacSignature(secret, timestamp, method, requestPath, body) {
  let message = String(timestamp) + method + requestPath;
  if (body) message += body;
  // Polymarket secrets are base64 (sometimes base64url)
  const normalized = String(secret).replace(/-/g, "+").replace(/_/g, "/");
  const secretBuf = Buffer.from(normalized, "base64");
  const sig = createHmac("sha256", secretBuf).update(message).digest("base64");
  return sig.replace(/\+/g, "-").replace(/\//g, "_");
}

export function buildL2Headers(creds, address, method, path, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = buildHmacSignature(creds.secret, timestamp, method, path, body);
  return {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_API_KEY: creds.key,
    POLY_PASSPHRASE: creds.passphrase,
    "content-type": "application/json",
  };
}

/**
 * Build V2 order message + domain (no sign).
 */
export function buildOrderV2Message(params = {}) {
  const {
    tokenId,
    side,
    price,
    size,
    maker,
    signer,
    negRisk = false,
    tickSize = "0.01",
    orderType = "GTC",
    signatureType = 0,
    metadata = BYTES32_ZERO,
    builder = BYTES32_ZERO,
  } = params;

  if (!tokenId) throw new Error("tokenId required");
  if (side !== "BUY" && side !== "SELL") throw new Error("side must be BUY or SELL");
  if (!maker || !signer) throw new Error("maker and signer required");
  const px = Number(price);
  const sz = Number(size);
  if (!(px > 0 && px < 1)) throw new Error(`price out of (0,1): ${price}`);
  if (!(sz > 0)) throw new Error(`size must be > 0: ${size}`);
  if (![0, 3].includes(Number(signatureType))) {
    throw new Error(`Desk poly supports signatureType 0 (EOA) or 3 (deposit wallet), got ${signatureType}`);
  }

  const roundConfig = ROUNDING_CONFIG[String(tickSize)] || ROUNDING_CONFIG["0.01"];
  const { rawMakerAmt, rawTakerAmt } = getOrderRawAmounts(side, sz, px, roundConfig);
  const makerAmount = toRawAmountStr(rawMakerAmt);
  const takerAmount = toRawAmountStr(rawTakerAmt);
  const salt = String(randomInt(1, 2 ** 31 - 1));
  const timestamp = Date.now().toString();
  const sideInt = side === "BUY" ? 0 : 1;
  const exchange = negRisk ? NEG_RISK_CTF_EXCHANGE_V2 : CTF_EXCHANGE_V2;

  const orderMessage = {
    salt,
    maker,
    signer,
    tokenId: String(tokenId),
    makerAmount,
    takerAmount,
    side: sideInt,
    signatureType: Number(signatureType),
    timestamp,
    metadata,
    builder,
  };

  const domain = { ...EIP712_DOMAIN_V2, verifyingContract: exchange };
  const notionalUsdc = side === "BUY" ? rawMakerAmt : rawTakerAmt;

  return {
    domain,
    types: ORDER_TYPES_V2,
    value: orderMessage,
    orderType,
    side,
    notionalUsdc,
    exchange,
  };
}

/** Deep-import refuse: signing lives in @oracle-agent/operator. */
export async function signOrderV2_1271() {
  throw new Error(
    "poly-clob.signOrderV2_1271 refused: @oracle-agent/oracle is prepare-only. Sign via @oracle-agent/operator poly-exec."
  );
}

/**
 * Deep-import refuse: signed order build lives in @oracle-agent/operator.
 */
export async function buildSignedOrderV2() {
  throw new Error(
    "poly-clob.buildSignedOrderV2 refused: @oracle-agent/oracle is prepare-only. Sign via @oracle-agent/operator poly-exec."
  );
}

/**
 * Deep-import refuse: CLOB submit lives in @oracle-agent/operator.
 */
export async function postClobOrder() {
  throw new Error(
    "poly-clob.postClobOrder refused: @oracle-agent/oracle is prepare-only. Submit via @oracle-agent/operator poly-exec."
  );
}

/** Max notional USDC for a single desk order (env MAD_POLY_MAX_NOTIONAL, default 25). */
export function polyMaxNotional() {
  const n = Number(process.env.MAD_POLY_MAX_NOTIONAL || "25");
  return Number.isFinite(n) && n > 0 ? n : 25;
}


/** Prepare-only: unsigned CLOB order envelope for operator to sign locally. */
export function polyPrepareOrder(args = {}) {
  const built = buildOrderV2Message(args);
  return stampPrepared(
    {
      provider: "poly-clob",
      kind: "poly-order",
      chainId: POLY_CHAIN_ID,
      tokenId: String(args.tokenId),
      side: built.side,
      orderType: built.orderType,
      notionalUsdc: built.notionalUsdc,
      exchange: built.exchange,
      domain: built.domain,
      types: built.types,
      value: built.value,
      tickSize: args.tickSize || "0.01",
      negRisk: Boolean(args.negRisk),
      signatureType: Number(args.signatureType ?? 0),
      // amounts echoed for caps
      maxNotionalUsdc: args.maxNotionalUsdc ?? null,
    },
    { provider: "poly-clob", kind: "poly-order" }
  );
}
