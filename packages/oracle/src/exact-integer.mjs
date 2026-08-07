// Exact integer parsing for anything that bounds money.
//
// A JS number cannot represent every uint256, and above 2^53 it silently
// rounds — usually UPWARD, which widens a cap past what the user wrote.
// `9007199254740995` becomes `...996`. Every guard, allowance, and policy
// ceiling must therefore refuse unsafe numbers rather than quietly storing a
// different value than the caller asked for.
//
// This lives in one place because the same bug was found independently in
// token-transfer-guard, approval-guard, session grants, and exec-policy.

/**
 * Parse a value into an exact non-negative BigInt.
 * Accepts: decimal string, BigInt, or a safe-integer number.
 * Refuses: non-integers, unsafe numbers, and unparseable input.
 */
export function exactBigInt(value, label = "amount") {
  if (typeof value === "bigint") return value;

  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${label} must be an integer`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `${label} exceeds safe integer precision — pass it as a decimal string or BigInt so the exact value is preserved`
      );
    }
    return BigInt(value);
  }

  const text = String(value ?? "").trim();
  if (text === "") throw new Error(`${label} is required`);
  // Reject scientific notation and floats outright: BigInt("1e3") throws, but
  // Number("1e3") would silently succeed if a caller coerced first.
  if (!/^-?\d+$/.test(text) && !/^0x[0-9a-fA-F]+$/.test(text)) {
    throw new Error(`${label} must be an integer in decimal or 0x-hex form, got ${JSON.stringify(text)}`);
  }
  try {
    return BigInt(text);
  } catch {
    throw new Error(`${label} must be an integer, got ${JSON.stringify(text)}`);
  }
}

/** As exactBigInt, but also requires the value to be strictly positive. */
export function exactPositiveBigInt(value, label = "amount") {
  const n = exactBigInt(value, label);
  if (n <= 0n) throw new Error(`${label} must be positive`);
  return n;
}

/**
 * Convert a decimal string to a scaled integer WITHOUT floats.
 * `toScaledInteger("1.5", 6)` -> 1500000n, and `"01.5"` -> 1500000n.
 * Leading zeros, missing fractions, and long fractions are all handled by
 * string arithmetic, so magnitude never affects the scale.
 */
export function toScaledInteger(value, decimals, label = "amount") {
  const text = String(value ?? "").trim();
  if (!/^-?\d*(\.\d+)?$/.test(text) || text === "" || text === "." || text === "-") {
    throw new Error(`${label} must be a decimal number, got ${JSON.stringify(text)}`);
  }
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const [intPart = "0", fracPart = ""] = body.split(".");
  if (fracPart.length > decimals) {
    throw new Error(`${label} has more than ${decimals} decimal places, which would lose precision`);
  }
  const scaled = BigInt((intPart || "0") + fracPart.padEnd(decimals, "0"));
  return negative ? -scaled : scaled;
}
