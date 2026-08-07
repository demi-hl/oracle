// Oracle ↔ Buzz integration API (public plane).
//
// Buzz should integrate Oracle **via HTTP**, not by embedding our private
// executor. This module is the contract Buzz (or any partner) can call:
//
//   1) Discovery     GET  /public/buzz
//   2) Grants        existing /public/connect/* + /public/grants/*
//   3) Shared auth   POST /public/buzz/auth/verify   (capability tokens)
//   4) Shared audit  POST /public/buzz/audit/{append,verify,entries}
//
// Hard boundaries (same as the rest of the public plane):
//   - No private keys, no bearer mint, no broadcast.
//   - Minting capabilities stays client-side (owner wallet signs).
//   - Audit detail is scanned for secret shapes before append/response.
//   - Fail closed on unknown fields / bad capability tags.

import {
  verifyCapability,
  authPreimage,
  AUTH_DOMAIN,
} from "../agent-auth.mjs";
import {
  appendAudit,
  verifyChain,
  getEntries,
  AUDIT_ACTIONS,
  GENESIS_HASH,
} from "../audit-log.mjs";
import { assertNoSecretMaterial, SecretLeakError } from "./connect-agent.mjs";

export const BUZZ_API_VERSION = 1;
export const BUZZ_INTEGRATION_ID = "oracle-buzz-http-v1";

/** Public-safe audit actions partners may append. */
export const BUZZ_PUBLIC_AUDIT_ACTIONS = Object.freeze([
  AUDIT_ACTIONS.AUTH_GRANT,
  AUDIT_ACTIONS.AUTH_OK,
  AUDIT_ACTIONS.AUTH_FAIL,
  "connect.assemble",
  "connect.bound",
  "grant.revoke",
  "grant.active",
  "buzz.ping",
]);

export function buildBuzzCatalog({ baseUrl = null, plans = null } = {}) {
  const base = baseUrl || "";
  return Object.freeze({
    ok: true,
    integration: BUZZ_INTEGRATION_ID,
    version: BUZZ_API_VERSION,
    plane: "public",
    unsigned: true,
    custody: "user-signs",
    defaultPosture: "DISARMED",
    summary:
      "Oracle exposes grants, capability verify, and audit over HTTP so Buzz (or any client) can integrate without house keys.",
    doAll: {
      api: true,
      sharedAuth: true,
      sharedAudit: true,
      note: "One surface — not three separate products. Buzz calls these routes; user still signs grants/capabilities.",
    },
    // Access tiers are published in the discovery document so an integrator
    // can see the ceiling before writing code against it. Anonymous access
    // keeps working; a key raises the limit. Locals Only holders get the paid
    // tier at no cost — the NFT is the license.
    access: plans
      ? Object.freeze({
          anonymous: true,
          keyHeader: "authorization: Bearer <key>",
          plans: Object.freeze(plans),
          note: "Unkeyed requests are served at the free tier. Keys never carry secrets or grant custody.",
        })
      : undefined,
    endpoints: Object.freeze([
      {
        method: "GET",
        path: `${base}/public/buzz`,
        purpose: "Discovery catalog for Buzz integrators",
      },
      {
        method: "GET",
        path: `${base}/public/health`,
        purpose: "Liveness",
      },
      {
        method: "GET",
        path: `${base}/public/config`,
        purpose: "Public custody config (Privy flags, no secrets)",
      },
      {
        method: "POST",
        path: `${base}/public/connect/request`,
        purpose: "Build human-readable connect request",
      },
      {
        method: "POST",
        path: `${base}/public/connect/assemble`,
        purpose: "Assemble unsigned grant for user personal_sign",
      },
      {
        method: "POST",
        path: `${base}/public/grants/active`,
        purpose: "List active grants from injected store",
      },
      {
        method: "POST",
        path: `${base}/public/grants/get`,
        purpose: "Get one grant by id",
      },
      {
        method: "POST",
        path: `${base}/public/buzz/auth/verify`,
        purpose: "Verify owner-signed capability token (shared auth)",
      },
      {
        method: "POST",
        path: `${base}/public/buzz/auth/preimage`,
        purpose: "Build exact capability signing preimage (client mints)",
      },
      {
        method: "POST",
        path: `${base}/public/buzz/audit/append`,
        purpose: "Append public audit event to shared hash chain",
      },
      {
        method: "POST",
        path: `${base}/public/buzz/audit/verify`,
        purpose: "Verify audit chain integrity",
      },
      {
        method: "POST",
        path: `${base}/public/buzz/audit/entries`,
        purpose: "Read audit entries (paginated)",
      },
    ]),
    auth: Object.freeze({
      domain: AUTH_DOMAIN,
      format: '["auth", ownerAddress, conditions, signature]',
      mint: "client-side only — owner wallet personal_sign(preimage)",
      verify: "POST /public/buzz/auth/verify",
      clauses: ["chain=<id>", "action=<scope>", "expires<unix", "notbefore>unix"],
    }),
    audit: Object.freeze({
      model: "sha256 hash-chain",
      genesis: GENESIS_HASH,
      publicActions: BUZZ_PUBLIC_AUDIT_ACTIONS,
      streamDefault: "buzz-public",
    }),
    never: Object.freeze([
      "private-executor-broadcast",
      "server-side-capability-mint-with-house-key",
      "raw-private-keys-in-responses",
    ]),
  });
}

export function handleBuzzAuthPreimage(body = {}) {
  const agentAddress = body.agentAddress;
  const conditions = body.conditions == null ? "" : String(body.conditions);
  if (!agentAddress || typeof agentAddress !== "string") {
    const err = new Error("agentAddress required");
    err.code = "invalid-auth-preimage";
    throw err;
  }
  const preimage = authPreimage(agentAddress, conditions);
  return {
    ok: true,
    domain: AUTH_DOMAIN,
    agentAddress,
    conditions,
    preimage,
    note: "Owner personal_sign(preimage). Server never mints with a house key.",
  };
}

export function handleBuzzAuthVerify(body = {}) {
  const tag = body.capability ?? body.tag ?? body.auth;
  const agentAddress = body.agentAddress;
  if (tag == null) {
    const err = new Error("capability tag required");
    err.code = "invalid-capability";
    throw err;
  }
  if (!agentAddress) {
    const err = new Error("agentAddress required");
    err.code = "invalid-capability";
    throw err;
  }
  const result = verifyCapability(tag, {
    agentAddress,
    chainId: body.chainId ?? null,
    action: body.action ?? null,
    now: body.now ?? null,
  });
  if (!result || result.ok !== true) {
    return {
      ok: false,
      valid: false,
      reason: (result && (result.reason || result.error)) || "invalid",
      result,
    };
  }
  return {
    ok: true,
    valid: true,
    result,
  };
}

function assertPublicAuditAction(action) {
  if (!BUZZ_PUBLIC_AUDIT_ACTIONS.includes(action)) {
    const err = new Error(
      `action not allowed on public buzz audit: ${action}`
    );
    err.code = "audit-action-forbidden";
    throw err;
  }
}

export async function handleBuzzAuditAppend(body = {}, { path } = {}) {
  const action = body.action;
  if (!action) {
    const err = new Error("action required");
    err.code = "invalid-audit";
    throw err;
  }
  assertPublicAuditAction(action);
  const detail = body.detail ?? null;
  try {
    assertNoSecretMaterial(detail);
  } catch (e) {
    if (e instanceof SecretLeakError || e?.name === "SecretLeakError") {
      const err = new Error("audit detail blocked: secret-shaped material");
      err.code = "secret-leak-blocked";
      throw err;
    }
    throw e;
  }
  const entry = await appendAudit({
    action,
    actor: body.actor ?? null,
    objectId: body.objectId ?? null,
    detail,
    stream: body.stream || "buzz-public",
    path,
  });
  return { ok: true, entry };
}

export function handleBuzzAuditVerify(body = {}, { path } = {}) {
  const out = verifyChain({
    stream: body.stream || "buzz-public",
    path,
  });
  return { ok: true, ...out };
}

export function handleBuzzAuditEntries(body = {}, { path } = {}) {
  const entries = getEntries({
    stream: body.stream || "buzz-public",
    fromSeq: body.fromSeq ?? 1,
    limit: Math.min(Number(body.limit || 100), 500),
    path,
  });
  return { ok: true, count: entries.length, entries };
}
