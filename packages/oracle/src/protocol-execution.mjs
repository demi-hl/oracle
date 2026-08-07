import { isAddress } from "ethers";
import { assertAutoSlippageGuard } from "./auto-slippage.mjs";

export const EXECUTABLE_PROTOCOL_PROVIDERS = Object.freeze([
  "lifi",
  "relay",
  "uniswap-v3",
  "aerodrome",
  "zerox",
  "paraswap",
  "odos",
  "oneinch",
  "pendle",
  "balancer",
  "curve",
]);

function hexData(value) {
  const data = String(value || "");
  return /^0x(?:[0-9a-fA-F]{2})*$/.test(data);
}

function sameAddress(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

/**
 * Validate a provider-produced executable route before it may cross into the
 * generic signer. This function accepts no caller-supplied destination/calldata;
 * those must come from the provider's freshly generated route.
 */
export function assertPreparedProtocolRoute(
  route,
  { provider, chainId, from, nowMs = Date.now() } = {}
) {
  // `calldataReady` means the provider assembled real calldata from a fresh
  // quote. It deliberately does NOT mean "cleared to execute" — the user's
  // wallet is still the only authority. The old flag name was `executionReady`,
  // which read as permission and trained agents to treat a quote as authority.
  const prepared = route && (route.calldataReady === true || route.executionReady === true);
  if (!prepared) {
    throw new Error(`${provider || "protocol"}: executable provider preparation required`);
  }
  if (provider && route.provider !== provider) {
    throw new Error(`protocol provider mismatch: expected ${provider}, got ${route.provider || "unknown"}`);
  }
  if (Number(route.chainId) !== Number(chainId)) {
    throw new Error(`protocol route chain mismatch: expected ${chainId}, got ${route.chainId}`);
  }
  const raw = Array.isArray(route.transactions) ? route.transactions : [route.transaction];
  if (!raw.length || raw.some((tx) => !tx)) throw new Error("protocol route has no executable transaction");

  return raw.map((tx, index) => {
    if (Number(tx.chainId ?? route.chainId) !== Number(chainId)) {
      throw new Error(`protocol transaction ${index} chain mismatch`);
    }
    if (!isAddress(String(tx.to || ""))) throw new Error(`protocol transaction ${index} target must be an address`);
    if (!hexData(tx.data) || String(tx.data).length < 10) {
      throw new Error(`protocol transaction ${index} requires non-empty hex calldata`);
    }
    if (from && tx.from && !sameAddress(tx.from, from)) {
      throw new Error(`protocol transaction ${index} sender mismatch`);
    }
    const guard = tx.slippageGuard || tx.madSlippage || route.autoSlippage || route.quote?.autoSlippage;
    // Same bar as enforceTxPolicy sign/broadcast: a prepare helper must not
    // become a second, softer gate that trusts caller-bound unsigned guards.
    assertAutoSlippageGuard(guard, {
      nowMs,
      chainId,
      venue: tx.to,
      tx: { ...tx, chainId: Number(chainId), to: tx.to, data: tx.data },
      requireSigned: true,
    });
    return {
      chainId: Number(chainId),
      to: tx.to,
      data: tx.data,
      value: tx.value == null ? "0x0" : String(tx.value),
      ...(tx.gasLimit != null || tx.gas != null ? { gasLimit: String(tx.gasLimit ?? tx.gas) } : {}),
      ...(tx.nonce != null ? { nonce: Number(tx.nonce) } : {}),
      slippageGuard: guard,
    };
  });
}
