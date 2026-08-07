import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ORACLE_CHAINS, type OracleRevokePrepareResponse } from "@oracle-agent/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Revoke PREPARE. Builds UNSIGNED calldata that drops an approval.
 *
 * Two shapes, because the two approval kinds revoke differently:
 *   - ERC-20:  `approve(spender, 0)`
 *   - ERC-721: `setApprovalForAll(operator, false)`
 *
 * Sending `approve(operator, 0)` to an NFT contract would NOT revoke an
 * operator grant — on ERC-721 that selector means "approve token id 0" — so the
 * standard must drive the selector rather than being assumed.
 *
 * Custody boundary, deliberately narrow:
 *   - no key material is read, held, or derived here
 *   - nothing is signed and nothing is broadcast
 *   - the response is inert calldata a wallet the user controls must review
 *   - preparation is NEVER success; the allowance is only gone once the user's
 *     wallet submits and a later read-back shows zero
 *
 * Encoding is done locally because both layouts are fixed-width. That keeps
 * preparation deterministic and removes any upstream that could substitute a
 * different spender or a non-zero amount.
 */
const APPROVE_SELECTOR = "095ea7b3";
/** keccak256("setApprovalForAll(address,bool)")[0:4] */
const SET_APPROVAL_FOR_ALL_SELECTOR = "a22cb465";
const ZERO_AMOUNT_WORD = "0".repeat(64);
const FALSE_WORD = "0".repeat(64);

function unavailable(reason: string, configured = true): OracleRevokePrepareResponse {
  return {
    configured,
    reachable: false,
    error: reason,
    transaction: null,
    intentHash: null,
    requiresWalletSignature: true,
    backendSigner: false,
  };
}

function evmAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

function addressWord(address: string): string {
  return address.slice(2).padStart(64, "0");
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(unavailable("Request body must be JSON"), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const token = evmAddress(body.token);
  const spender = evmAddress(body.spender);
  // Default to the ERC-20 shape; an operator grant must ask for it explicitly.
  const standard = body.standard === "erc721" ? "erc721" : "erc20";
  const chainIdRaw = typeof body.chainId === "string" ? body.chainId : null;
  const chain = ORACLE_CHAINS.find((item) => item.id === chainIdRaw);

  if (!chain || chain.family !== "evm" || chain.chainId === null) {
    return NextResponse.json(unavailable("Revoke is only supported on EVM chains Oracle indexes"), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (!token || !spender) {
    return NextResponse.json(unavailable("A valid token address and spender address are required"), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (token === spender) {
    return NextResponse.json(unavailable("Token and spender must be different addresses"), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const data = standard === "erc721"
    ? `0x${SET_APPROVAL_FOR_ALL_SELECTOR}${addressWord(spender)}${FALSE_WORD}`
    : `0x${APPROVE_SELECTOR}${addressWord(spender)}${ZERO_AMOUNT_WORD}`;
  const transaction = { to: token, data, value: "0x0" as const, chainId: chain.chainId };
  const intentHash = createHash("sha256")
    .update(`${chain.chainId}:${token}:${spender}:${standard}:0`)
    .digest("hex")
    .slice(0, 32);

  return NextResponse.json(
    {
      configured: true,
      reachable: true,
      error: null,
      transaction,
      intentHash,
      requiresWalletSignature: true,
      backendSigner: false,
    } satisfies OracleRevokePrepareResponse,
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
