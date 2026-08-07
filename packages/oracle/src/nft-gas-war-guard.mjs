// Oracle public NFT mint gas-war guard.
//
// Pure, dependency-free policy checks for NFT mint bots across any configured
// chain. This module does not sign, broadcast, read RPC, or know private keys.
// It only decides whether a proposed mint transaction's gas envelope fits the
// user's explicit cap. Missing caps fail closed.

const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;

export class NftGasWarLimitError extends Error {
  constructor(verdict) {
    super(`nft gas-war limit: ${verdict.reason}`);
    this.name = "NftGasWarLimitError";
    this.verdict = verdict;
  }
}

function toBig(value, label, { required = true, allowZero = false } = {}) {
  if (value == null || value === "") {
    if (required) throw new Error(`${label} required`);
    return null;
  }
  let n;
  if (typeof value === "bigint") n = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
    n = BigInt(value);
  } else if (typeof value === "string") {
    const s = value.trim();
    if (s.startsWith("0x") || s.startsWith("0X")) n = BigInt(s);
    else {
      if (!DECIMAL_RE.test(s)) throw new Error(`${label} must be an integer wei string`);
      n = BigInt(s);
    }
  } else throw new Error(`${label} must be bigint, number, or integer string`);
  if (n < 0n || (!allowZero && n === 0n)) throw new Error(`${label} must be ${allowZero ? "non-negative" : "positive"}`);
  return n;
}

function toChainId(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("chainId must be a positive integer");
  return n;
}

function readGasPrice(tx = {}) {
  if (tx.maxFeePerGas != null) return toBig(tx.maxFeePerGas, "maxFeePerGas");
  if (tx.gasPrice != null) return toBig(tx.gasPrice, "gasPrice");
  return null;
}

/**
 * Validate an NFT mint gas envelope against a user/grant gas-war policy.
 *
 * Input accepts either top-level gas fields or a tx object:
 *   validateNftMintGasWar({ chainId, tx, policy })
 *   tx: { gasLimit, maxFeePerGas, maxPriorityFeePerGas } or legacy { gasPrice }
 *   policy: {
 *     maxTotalGasWei,          // required unless grant.maxGasWei provided
 *     maxFeePerGasWei,         // optional per-unit cap
 *     maxPriorityFeePerGasWei, // optional EIP-1559 tip cap
 *     grant                    // optional normalized public grant with maxGasWei
 *   }
 */
export function validateNftMintGasWar(input = {}) {
  try {
    const chainId = toChainId(input.chainId ?? input.tx?.chainId);
    const tx = input.tx || input;
    const policy = input.policy || input;
    const grantMaxGas = policy.grant?.maxGasWei ?? input.grant?.maxGasWei;
    const maxTotalGasWei = toBig(policy.maxTotalGasWei ?? policy.maxGasWei ?? grantMaxGas, "maxTotalGasWei");
    const gasLimit = toBig(tx.gasLimit ?? tx.gas, "gasLimit");
    const unitFee = readGasPrice(tx);
    if (unitFee == null) throw new Error("maxFeePerGas or gasPrice required");
    const maxFeePerGasWei = toBig(policy.maxFeePerGasWei, "maxFeePerGasWei", { required: false });
    const maxPriorityFeePerGasWei = toBig(policy.maxPriorityFeePerGasWei, "maxPriorityFeePerGasWei", { required: false });
    const priorityFee = tx.maxPriorityFeePerGas == null ? null : toBig(tx.maxPriorityFeePerGas, "maxPriorityFeePerGas");
    const totalGasWei = gasLimit * unitFee;

    if (totalGasWei > maxTotalGasWei) {
      return {
        ok: false,
        status: "BLOCK",
        reason: `total gas ${totalGasWei} exceeds cap ${maxTotalGasWei}`,
        chainId,
        totalGasWei: totalGasWei.toString(),
        maxTotalGasWei: maxTotalGasWei.toString(),
      };
    }
    if (maxFeePerGasWei != null && unitFee > maxFeePerGasWei) {
      return {
        ok: false,
        status: "BLOCK",
        reason: `unit fee ${unitFee} exceeds cap ${maxFeePerGasWei}`,
        chainId,
        unitFeeWei: unitFee.toString(),
        maxFeePerGasWei: maxFeePerGasWei.toString(),
        totalGasWei: totalGasWei.toString(),
        maxTotalGasWei: maxTotalGasWei.toString(),
      };
    }
    if (priorityFee != null && maxPriorityFeePerGasWei != null && priorityFee > maxPriorityFeePerGasWei) {
      return {
        ok: false,
        status: "BLOCK",
        reason: `priority fee ${priorityFee} exceeds cap ${maxPriorityFeePerGasWei}`,
        chainId,
        priorityFeeWei: priorityFee.toString(),
        maxPriorityFeePerGasWei: maxPriorityFeePerGasWei.toString(),
        totalGasWei: totalGasWei.toString(),
        maxTotalGasWei: maxTotalGasWei.toString(),
      };
    }
    return {
      ok: true,
      status: "PASS",
      reason: "gas envelope within NFT mint gas-war caps",
      chainId,
      totalGasWei: totalGasWei.toString(),
      maxTotalGasWei: maxTotalGasWei.toString(),
      unitFeeWei: unitFee.toString(),
      maxFeePerGasWei: maxFeePerGasWei?.toString() ?? null,
      priorityFeeWei: priorityFee?.toString() ?? null,
      maxPriorityFeePerGasWei: maxPriorityFeePerGasWei?.toString() ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      status: "BLOCK",
      reason: String(error?.message || error),
    };
  }
}

export function assertNftMintGasWar(input = {}) {
  const verdict = validateNftMintGasWar(input);
  if (!verdict.ok) throw new NftGasWarLimitError(verdict);
  return verdict;
}
