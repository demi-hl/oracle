import { Interface, MaxUint256, isAddress } from "ethers";

const TRANSFER_SELECTOR = "0xa9059cbb";
const TRANSFER_FROM_SELECTOR = "0x23b872dd";
const DEFAULT_TOKEN_TRANSFER_TTL_MS = 20_000;

const ERC20_TRANSFER = new Interface([
  "function transfer(address to,uint256 amount) returns (bool)",
  "function transferFrom(address from,address to,uint256 amount) returns (bool)",
]);

function normalAddress(value, label) {
  const text = String(value || "").trim();
  if (!isAddress(text)) throw new Error(`${label} must be an address`);
  return text.toLowerCase();
}

function amountString(value, label = "token transfer amount", { allowZero = false } = {}) {
  // A JS number cannot represent every uint256, and above 2^53 it silently
  // rounds — usually UPWARD, which would widen a spending cap past what the
  // user asked for. `9007199254740995` arrives as `...996` and authorizes one
  // more token than intended. Refuse unsafe numbers instead of quietly
  // accepting a different value than the caller wrote.
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${label} must be an integer`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `${label} exceeds safe integer precision — pass it as a decimal string or BigInt so the exact value is preserved`
      );
    }
  }
  let amount;
  try {
    amount = BigInt(String(value));
  } catch {
    throw new Error(`${label} must be an integer string`);
  }
  if (allowZero ? amount < 0n : amount <= 0n) throw new Error(`${label} must be positive`);
  if (amount >= MaxUint256) throw new Error("unbounded token transfer amount refused");
  return amount.toString();
}

function txValue(tx = {}) {
  const raw = tx.value == null ? "0" : String(tx.value);
  return BigInt(raw);
}

export function isTokenTransferCall(data) {
  const hex = String(data || "").toLowerCase();
  return hex.startsWith(TRANSFER_SELECTOR) || hex.startsWith(TRANSFER_FROM_SELECTOR);
}

export function decodeTokenTransferCalldata(data) {
  const hex = String(data || "").toLowerCase();
  try {
    if (hex.startsWith(TRANSFER_SELECTOR)) {
      const [recipient, amount] = ERC20_TRANSFER.decodeFunctionData("transfer", data);
      return {
        kind: "transfer",
        recipient: normalAddress(recipient, "token transfer recipient"),
        amount: amountString(amount),
      };
    }
    if (hex.startsWith(TRANSFER_FROM_SELECTOR)) {
      const [from, recipient, amount] = ERC20_TRANSFER.decodeFunctionData("transferFrom", data);
      return {
        kind: "transferFrom",
        from: normalAddress(from, "token transfer source"),
        recipient: normalAddress(recipient, "token transfer recipient"),
        amount: amountString(amount),
      };
    }
  } catch (error) {
    if (/token transfer/.test(String(error?.message || error))) throw error;
    throw new Error("invalid token transfer calldata");
  }
  throw new Error("token transfer calldata required");
}

export function createTokenTransferGuard({
  chainId,
  token,
  kind = "transfer",
  from,
  recipient,
  amount,
  maxAmount,
  provider,
  purpose,
  nowMs = Date.now(),
  ttlMs = DEFAULT_TOKEN_TRANSFER_TTL_MS,
} = {}) {
  const guard = {
    mode: "token-transfer",
    chainId: Number(chainId),
    token: normalAddress(token, "token transfer token"),
    kind: String(kind || "transfer"),
    recipient: normalAddress(recipient, "token transfer recipient"),
    issuedAtMs: Number(nowMs),
    expiresAtMs: Number(nowMs) + Number(ttlMs || DEFAULT_TOKEN_TRANSFER_TTL_MS),
  };
  if (guard.kind !== "transfer" && guard.kind !== "transferFrom") {
    throw new Error("token transfer kind must be transfer or transferFrom");
  }
  if (guard.kind === "transferFrom") guard.from = normalAddress(from, "token transfer source");
  if (amount != null) guard.amount = amountString(amount);
  if (maxAmount != null) guard.maxAmount = amountString(maxAmount);
  if (!guard.amount && !guard.maxAmount) throw new Error("token transfer guard requires exact amount or maxAmount");
  if (provider) guard.provider = String(provider).trim();
  if (purpose) guard.purpose = String(purpose).trim();
  if (!Number.isFinite(guard.chainId)) throw new Error("token transfer chainId required");
  if (!Number.isFinite(guard.issuedAtMs) || !Number.isFinite(guard.expiresAtMs) || guard.expiresAtMs <= guard.issuedAtMs) {
    throw new Error("token transfer guard expiry invalid");
  }
  return guard;
}

export function assertTokenTransferGuard(guard, tx = {}, { chainId, nowMs = Date.now() } = {}) {
  if (!guard || guard.mode !== "token-transfer") throw new Error("token transfer guard required");

  // Time is a security parameter here, so an unusable clock must fail CLOSED.
  // A NaN/Infinity `nowMs` made every `now > expiresAtMs` comparison false and
  // silently disabled expiry; a guard missing its timestamps skipped the TTL
  // check entirely. Both turn a short-lived authorization into a permanent one.
  const now = Number(nowMs);
  if (!Number.isFinite(now)) {
    throw new Error("token transfer guard: current time must be a finite number");
  }
  const issuedAtMs = Number(guard.issuedAtMs);
  const expiresAtMs = Number(guard.expiresAtMs);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)) {
    throw new Error("token transfer guard: issuedAtMs and expiresAtMs are required and must be finite");
  }
  if (expiresAtMs <= issuedAtMs) {
    throw new Error("token transfer guard: expiry must be after issuance");
  }
  if (now > expiresAtMs) {
    throw new Error(`token transfer guard expired at ${expiresAtMs}, now ${now}`);
  }

  const txChainId = Number(tx.chainId ?? chainId);
  if (Number(guard.chainId) !== txChainId) throw new Error(`token transfer chain mismatch: expected ${txChainId}, got ${guard.chainId}`);
  const token = normalAddress(tx.to, "token transfer token");
  if (normalAddress(guard.token, "token transfer token") !== token) throw new Error("token transfer token mismatch");
  const decoded = decodeTokenTransferCalldata(tx.data);
  if (String(guard.kind) !== decoded.kind) throw new Error("token transfer kind mismatch");
  if (normalAddress(guard.recipient, "token transfer recipient") !== decoded.recipient) throw new Error("token transfer recipient mismatch");
  if (decoded.kind === "transferFrom" && normalAddress(guard.from, "token transfer source") !== decoded.from) {
    throw new Error("token transfer source mismatch");
  }
  // An amount ceiling is MANDATORY. Both checks below were conditional on the
  // field being present, so a guard omitting BOTH `amount` and `maxAmount`
  // skipped every amount check and authorized a transfer of any size — the
  // final ERC-20 gate was effectively unbounded. A guard with no cap is not a
  // guard.
  if (guard.amount == null && guard.maxAmount == null) {
    throw new Error("token transfer guard must bind an amount or a maxAmount — a capless guard authorizes any size");
  }
  // Coherence first: a guard whose own fields contradict each other is
  // malformed, and saying so is more useful than reporting whichever bound
  // happened to trip.
  if (guard.amount != null && guard.maxAmount != null) {
    if (BigInt(amountString(guard.amount)) > BigInt(amountString(guard.maxAmount))) {
      throw new Error("token transfer guard amount exceeds its own maxAmount");
    }
  }
  if (guard.amount != null && amountString(guard.amount) !== decoded.amount) {
    throw new Error("token transfer amount mismatch");
  }
  if (guard.maxAmount != null && BigInt(decoded.amount) > BigInt(amountString(guard.maxAmount))) {
    throw new Error("token transfer amount exceeds guard maxAmount");
  }
  if (txValue(tx) !== 0n) throw new Error("token transfer tx value must be zero");
  if (Number(guard.expiresAtMs) <= Number(nowMs)) throw new Error("token transfer guard expired");
  if (Number(guard.issuedAtMs) > Number(nowMs) + 5_000) throw new Error("token transfer guard issued in the future");
  return {
    chainId: txChainId,
    token,
    kind: decoded.kind,
    from: decoded.from || null,
    recipient: decoded.recipient,
    amount: decoded.amount,
    provider: guard.provider || null,
    purpose: guard.purpose || null,
  };
}
