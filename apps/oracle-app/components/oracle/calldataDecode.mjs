const APPROVE_SELECTOR = "0x095ea7b3";
const SET_APPROVAL_FOR_ALL_SELECTOR = "0xa22cb465";
const CALLDATA_HEX_LENGTH = 8 + 64 + 64;

function failure(selector, reason) {
  return { ok: false, selector, reason };
}

function decodeAddress(word) {
  // Rejecting dirty padding prevents misleading bytes from being presented as a valid address.
  if (word.slice(0, 24) !== "0".repeat(24)) return null;
  return `0x${word.slice(24)}`;
}

export function decodeCalldata(data) {
  try {
    if (typeof data !== "string" || data === "") return failure(null, "invalid input");
    if (!data.startsWith("0x")) return failure(null, "missing 0x prefix");

    const hex = data.slice(2);
    const selector = hex.length >= 8 && /^[0-9a-fA-F]{8}/.test(hex)
      ? `0x${hex.slice(0, 8).toLowerCase()}`
      : null;

    if (hex.length % 2 !== 0) return failure(selector, "odd length");
    if (!/^[0-9a-fA-F]+$/.test(hex)) return failure(selector, "non-hex characters");
    if (selector !== APPROVE_SELECTOR && selector !== SET_APPROVAL_FOR_ALL_SELECTOR) {
      return failure(selector, "unknown selector");
    }
    if (hex.length !== CALLDATA_HEX_LENGTH) return failure(selector, "wrong length");

    const firstWord = hex.slice(8, 72).toLowerCase();
    const secondWord = hex.slice(72, 136).toLowerCase();
    const address = decodeAddress(firstWord);
    if (address === null) return failure(selector, "malformed address");

    if (selector === APPROVE_SELECTOR) {
      const amount = BigInt(`0x${secondWord}`).toString(10);
      return {
        ok: true,
        selector,
        signature: "approve(address,uint256)",
        name: "approve",
        args: [
          { name: "spender", type: "address", value: address },
          { name: "amount", type: "uint256", value: amount },
        ],
        summary: amount === "0"
          ? `approve ${address} to spend 0 (revokes the allowance)`
          : `approve ${address} to spend ${amount} token units`,
      };
    }

    const approved = /[1-9a-f]/.test(secondWord);
    return {
      ok: true,
      selector,
      signature: "setApprovalForAll(address,bool)",
      name: "setApprovalForAll",
      args: [
        { name: "operator", type: "address", value: address },
        { name: "approved", type: "bool", value: approved },
      ],
      summary: approved
        ? `GRANT operator ${address} control of the ENTIRE collection`
        : `revoke operator ${address} from the entire collection`,
    };
  } catch {
    return failure(null, "invalid input");
  }
}

export function describesRevoke(decoded) {
  if (!decoded || decoded.ok !== true || !Array.isArray(decoded.args)) return false;
  if (decoded.signature === "approve(address,uint256)") {
    return decoded.args[1]?.name === "amount" && decoded.args[1].value === "0";
  }
  if (decoded.signature === "setApprovalForAll(address,bool)") {
    return decoded.args[1]?.name === "approved" && decoded.args[1].value === false;
  }
  return false;
}
