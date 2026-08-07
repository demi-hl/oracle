#!/usr/bin/env node
// Desk HTTP surface: read-only data plane + onboarding (scoped keys only).
// NEVER enables wallet signing/exec. Loopback by default.
//
//   MAD_DESK_PORT=8787 node bin/desk-server.mjs

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { verifyMessage } from "ethers";
import { data, dataCall, dataHealth, dataCatalog, isExecutionProvider } from "../src/data/desk-data.mjs";
import { getProvider } from "../src/data/catalog.mjs";
import { csvEnv, env, envFlag } from "../src/oracle-env.mjs";
import { readPackageManifest } from "../src/package-manifest.mjs";
import { prepareSwapForDesk, SwapPrepareError } from "../src/desk/swap-prepare.mjs";
import {
  listTiers,
  onboardUser,
  onboardAuthenticate,
  onboardListKeys,
  onboardRevoke,
} from "../src/onboarding/index.mjs";

const HOST = env("ORACLE_DATA_HOST", "MAD_DESK_HOST", "127.0.0.1");
const PORT = Number(env("ORACLE_DATA_PORT", "MAD_DESK_PORT", 8787));
const ONBOARD_ENABLED = envFlag("ORACLE_ONBOARD_HTTP", "MAD_ONBOARD_HTTP", false);
const PUBLIC_API_MODE = envFlag("ORACLE_PUBLIC_API_MODE", "MAD_PUBLIC_API_MODE", false);
const pkg = readPackageManifest(import.meta.url);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MAX_BODY_BYTES = 64 * 1024;
const CHALLENGE_TTL_SECONDS = 300;
const MAX_CHALLENGES = 10_000;
const walletChallenges = new Map();

if (!LOOPBACK_HOSTS.has(String(HOST).toLowerCase())) {
  throw new Error("oracle data server only binds loopback; use 127.0.0.1 and do not expose it through a reverse proxy");
}

function csvSet(value) {
  return new Set(String(value || "").split(",").map((s) => s.trim()).filter(Boolean));
}

function publicAllowsServerKeyProvider(provider) {
  return csvSet(csvEnv("ORACLE_PUBLIC_ALLOW_SERVER_KEY_PROVIDERS", "MAD_PUBLIC_ALLOW_SERVER_KEY_PROVIDERS")).has(provider);
}

function providerNeedsServerKey(meta) {
  return meta && meta.auth && meta.auth !== "none";
}

function publicCallableProviders() {
  return dataCatalog()
    .filter((p) => !providerNeedsServerKey(p) || publicAllowsServerKeyProvider(p.id))
    .map((p) => p.id);
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function normalizedOwner(owner) {
  const value = String(owner || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(value)) throw new HttpError(400, "invalid-owner", "owner must be a 0x-prefixed address");
  return value;
}

function parseProofMessage(message) {
  const out = {};
  const lines = String(message || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines[0] !== "Oracle onboarding") throw new HttpError(401, "invalid-proof", "wallet proof must be an Oracle onboarding challenge");
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function pruneWalletChallenges(now = Math.floor(Date.now() / 1000)) {
  for (const [nonce, challenge] of walletChallenges) {
    if (challenge.expiresAt <= now) walletChallenges.delete(nonce);
  }
}

function issueWalletChallenge({ owner, action, tier, id } = {}) {
  const expectedOwner = normalizedOwner(owner);
  const expectedAction = String(action || "");
  if (!new Set(["onboard", "list", "revoke"]).has(expectedAction)) {
    throw new HttpError(400, "invalid-action", "action must be onboard, list, or revoke");
  }
  const expectedTier = tier == null ? null : String(tier);
  if (expectedAction === "onboard" && !expectedTier) {
    throw new HttpError(400, "tier-required", "onboard challenge requires tier");
  }
  const expectedId = id == null ? null : String(id).trim();
  if (expectedAction === "revoke" && !expectedId) {
    throw new HttpError(400, "id-required", "revoke challenge requires key id");
  }
  if (expectedId && expectedId.length > 256) {
    throw new HttpError(400, "invalid-id", "key id is too long");
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  pruneWalletChallenges(issuedAt);
  if (walletChallenges.size >= MAX_CHALLENGES) {
    throw new HttpError(429, "challenge-capacity", "too many pending wallet challenges");
  }
  const expiresAt = issuedAt + CHALLENGE_TTL_SECONDS;
  const nonce = randomBytes(32).toString("hex");
  const lines = [
    "Oracle onboarding",
    `owner: ${expectedOwner}`,
    `action: ${expectedAction}`,
  ];
  if (expectedTier != null) lines.push(`tier: ${expectedTier}`);
  if (expectedId != null) lines.push(`id: ${expectedId}`);
  lines.push(`nonce: ${nonce}`, `issuedAt: ${issuedAt}`, `expiresAt: ${expiresAt}`);
  const message = lines.join("\n");
  walletChallenges.set(nonce, {
    owner: expectedOwner,
    action: expectedAction,
    tier: expectedTier,
    id: expectedId,
    issuedAt,
    expiresAt,
    message,
    used: false,
  });
  return { message, issuedAt, expiresAt };
}

function requireWalletProof(body = {}, { owner, action, tier, id } = {}) {
  const expectedOwner = normalizedOwner(owner);
  const proof = body.proof || body.walletProof || {};
  const message = proof.message || body.message;
  const signature = proof.signature || body.signature;
  if (!message || !signature) throw new HttpError(401, "wallet-proof-required", "wallet signature proof required");
  let recovered;
  try {
    recovered = verifyMessage(String(message), String(signature)).toLowerCase();
  } catch {
    throw new HttpError(401, "invalid-proof", "wallet proof signature is invalid");
  }
  if (recovered !== expectedOwner) throw new HttpError(401, "owner-signature-mismatch", "wallet proof signer does not match owner");
  const fields = parseProofMessage(message);
  if (normalizedOwner(fields.owner) !== expectedOwner) throw new HttpError(401, "owner-proof-mismatch", "wallet proof owner mismatch");
  const nonce = String(fields.nonce || "");
  if (!/^[0-9a-f]{64}$/.test(nonce)) {
    throw new HttpError(401, "challenge-required", "wallet proof must use a server-issued challenge");
  }
  const challenge = walletChallenges.get(nonce);
  if (!challenge) throw new HttpError(401, "challenge-required", "wallet challenge is unknown or expired");
  if (challenge.used) throw new HttpError(401, "proof-replayed", "wallet challenge was already used");
  if (String(message) !== challenge.message) {
    throw new HttpError(401, "challenge-mismatch", "wallet proof does not match the issued challenge");
  }
  challenge.used = true;

  if (challenge.owner !== expectedOwner) throw new HttpError(401, "owner-proof-mismatch", "wallet proof owner mismatch");
  if (challenge.action !== action || String(fields.action || "") !== action) {
    throw new HttpError(401, "action-proof-mismatch", "wallet proof action mismatch");
  }
  if (tier != null && (challenge.tier !== String(tier) || String(fields.tier || "") !== String(tier))) {
    throw new HttpError(401, "tier-proof-mismatch", "wallet proof tier mismatch");
  }
  if (id != null && (challenge.id !== String(id) || String(fields.id || "") !== String(id))) {
    throw new HttpError(401, "id-proof-mismatch", "wallet proof key id mismatch");
  }
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = Number(fields.issuedAt || 0);
  const expiresAt = Number(fields.expiresAt || 0);
  if (issuedAt !== challenge.issuedAt || expiresAt !== challenge.expiresAt) {
    throw new HttpError(401, "proof-expiry-mismatch", "wallet proof timestamps do not match the issued challenge");
  }
  if (issuedAt > now + 60) throw new HttpError(401, "proof-from-future", "wallet proof issuedAt is in the future");
  if (expiresAt <= now) throw new HttpError(401, "proof-expired", "wallet proof expired");
  if (expiresAt - issuedAt > 600) throw new HttpError(401, "proof-window-too-long", "wallet proof window must be <= 10 minutes");
  return { owner: expectedOwner, recovered, action, expiresAt };
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-oracle-plane": "data+onboard",
    "x-oracle-exec": "false",
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(new HttpError(413, "body-too-large", `request body exceeds ${MAX_BODY_BYTES} bytes`));
      return;
    }
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (c) => {
      if (rejected) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        reject(new HttpError(413, "body-too-large", `request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (rejected) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Local-only origin guard.
 *
 * This server binds loopback and is documented as "safe because it's local",
 * but loopback is NOT a security boundary against a browser. Any page the
 * operator visits can issue requests to http://127.0.0.1:8787, and a
 * DNS-rebinding host can resolve an attacker domain to 127.0.0.1 and reach it
 * under that name. Either way the request arrives with the server's own API
 * keys attached, able to call every prepare op.
 *
 * Two cheap checks close both: the Host header must actually be loopback
 * (defeats rebinding, which needs its own hostname), and a cross-origin
 * browser request must be rejected (defeats the visited-page case; real CLI
 * and server-side callers send no Origin at all).
 */
function assertLocalCaller(req) {
  // The SOCKET is the boundary, not the Host header. Host is caller-controlled,
  // and `0.0.0.0` was on the accept list — so binding ORACLE_DATA_HOST=0.0.0.0
  // and sending `Host: 0.0.0.0` from another machine returned 200. Check the
  // actual peer address first; nothing a remote client can type changes it.
  const peer = String(req.socket?.remoteAddress || "");
  const normalisedPeer = peer.replace(/^::ffff:/, "");
  const PEER_LOOPBACK = new Set(["127.0.0.1", "::1"]);
  const peerIsLoopback =
    PEER_LOOPBACK.has(normalisedPeer) || normalisedPeer.startsWith("127.");
  if (!peerIsLoopback) {
    return `remote address ${peer || "(unknown)"} is not loopback — this server only answers local callers`;
  }

  const host = String(req.headers.host || "").toLowerCase();
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  // 0.0.0.0 is deliberately NOT here: it is a bind wildcard, never a legitimate
  // Host for a loopback-only service, and accepting it defeated the check.
  const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
  if (!LOOPBACK.has(hostname)) {
    return `unexpected Host header ${host || "(none)"} — this server only answers to loopback names`;
  }
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    try {
      const oh = new URL(origin).hostname;
      if (!LOOPBACK.has(oh)) return `cross-origin request from ${origin} refused`;
    } catch {
      return `malformed Origin ${origin} refused`;
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  try {
    const localOnly = assertLocalCaller(req);
    if (localOnly) return send(res, 403, { error: localOnly });

    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      return send(res, 200, {
        ok: true,
        service: "oracle",
        plane: "data+onboard",
        exec: false,
        version: pkg.version,
        onboardHttp: ONBOARD_ENABLED,
      });
    }

    if (req.method === "GET" && path === "/data/catalog") {
      return send(res, 200, { catalog: dataCatalog() });
    }

    if (req.method === "GET" && path === "/data/health") {
      const report = await dataHealth({
        timeoutMs: 10_000,
        providers: PUBLIC_API_MODE ? publicCallableProviders() : undefined,
      });
      return send(res, 200, report);
    }

    if (path === "/data/call") {
      let provider, op, args;
      if (req.method === "GET") {
        provider = url.searchParams.get("provider");
        op = url.searchParams.get("op");
        const argsRaw = url.searchParams.get("args");
        args = argsRaw ? JSON.parse(argsRaw) : {};
      } else if (req.method === "POST") {
        const body = await readBody(req);
        provider = body.provider;
        op = body.op;
        args = body.args || {};
      } else {
        return send(res, 405, { error: "method not allowed" });
      }
      if (!provider || !op) return send(res, 400, { error: "provider and op required" });
      // Provider-level boundary. A name-based verb filter is NOT a boundary:
      // `op:"trade"` matches none of these words, so the live signing lane was
      // reachable through a server whose /health advertises exec:false. Reject
      // the execution provider outright, before any op-name heuristic.
      if (isExecutionProvider(provider)) {
        return send(res, 403, {
          error: `${provider} is an execution provider and is not served by the data plane; run the execution binary instead`,
        });
      }
      if (/sign|execute|broadcast|approve|submit|place|send|write|trade|order|swap/i.test(op)) {
        return send(res, 403, { error: "sign/exec ops forbidden on data server" });
      }
      const meta = getProvider(provider);
      if (PUBLIC_API_MODE && providerNeedsServerKey(meta) && !publicAllowsServerKeyProvider(provider)) {
        return send(res, 403, {
          error: `public mode blocks ${provider}.${op}: server API key providers are disabled unless explicitly allowlisted`,
        });
      }
      const result = await dataCall(provider, op, args, { timeoutMs: 15_000 });
      return send(res, 200, { provider, op, result });
    }

    // POST /swap/prepare -- the route apps/oracle-app has always called and
    // nothing implemented. Returns an UNSIGNED transaction; the desk plane
    // still never signs or broadcasts. The sign/exec guard above deliberately
    // does not apply: that guard blocks the generic /data/call passthrough
    // (which could reach an execution provider), whereas this is a dedicated
    // prepare-only handler that cannot execute anything.
    if (req.method === "POST" && path === "/swap/prepare") {
      const body = await readBody(req);
      if (body.privateKey || body.secretKey || body.mnemonic) {
        return send(res, 400, { error: "do not send key material — taker address only" });
      }
      try {
        const out = await prepareSwapForDesk(body);
        // A route that could not be built is a 200 with ok:false, not a fault:
        // "no liquidity at this size" is a real answer to the question asked.
        return send(res, 200, out);
      } catch (e) {
        if (e instanceof SwapPrepareError) return send(res, e.status, { error: e.message });
        throw e;
      }
    }

    if (path.startsWith("/onboard")) {
      if (!ONBOARD_ENABLED) return send(res, 403, { error: "onboard HTTP disabled" });

      if (req.method === "GET" && path === "/onboard/tiers") {
        return send(res, 200, { tiers: listTiers() });
      }

      if (req.method === "POST" && path === "/onboard/challenge") {
        const body = await readBody(req);
        return send(res, 200, issueWalletChallenge(body));
      }

      if (req.method === "POST" && path === "/onboard") {
        const body = await readBody(req);
        if (body.privateKey || body.secretKey) {
          return send(res, 400, { error: "do not send wallet private keys — owner address only" });
        }
        const tier = body.tier || "observer";
        requireWalletProof(body, { owner: body.owner, action: "onboard", tier });
        const controllers = csvEnv("ORACLE_EXECUTOR_CONTROLLERS", "MAD_EXECUTOR_CONTROLLERS")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const result = onboardUser({
          owner: body.owner,
          tier,
          name: body.name,
          controllerAllowlist: controllers,
        });
        return send(res, 201, result);
      }

      if (req.method === "POST" && path === "/onboard/auth") {
        const body = await readBody(req);
        const rawKey = body.key || body.apiKey;
        if (!rawKey) throw new HttpError(400, "key-required", "key required");
        let auth;
        try {
          auth = onboardAuthenticate(rawKey);
        } catch {
          // Uniform 401 with no distinction between malformed, unknown, and
          // revoked -- that difference is not the caller's business.
          throw new HttpError(401, "invalid-key", "invalid or revoked key");
        }
        return send(res, 200, auth);
      }

      if (req.method === "GET" && path === "/onboard/keys") {
        const owner = url.searchParams.get("owner");
        if (!owner) return send(res, 400, { error: "owner query required" });
        return send(res, 405, { error: "method not allowed", message: "use POST /onboard/keys with wallet proof" });
      }

      if (req.method === "POST" && path === "/onboard/keys") {
        const body = await readBody(req);
        requireWalletProof(body, { owner: body.owner, action: "list" });
        return send(res, 200, { keys: onboardListKeys(body.owner) });
      }

      if (req.method === "POST" && path === "/onboard/revoke") {
        const body = await readBody(req);
        requireWalletProof(body, { owner: body.owner, action: "revoke", id: body.id });
        const rec = onboardRevoke({ owner: body.owner, id: body.id });
        return send(res, 200, { revoked: rec });
      }
    }

    return send(res, 404, {
      error: "not found",
      routes: [
        "/health",
        "/data/catalog",
        "/data/health",
        "/data/call",
        "POST /swap/prepare",
        "/onboard/tiers",
        "POST /onboard/challenge",
        "POST /onboard",
        "POST /onboard/auth",
        "POST /onboard/keys",
        "POST /onboard/revoke",
      ],
    });
  } catch (e) {
    if (e instanceof HttpError) {
      return send(res, e.status, { error: e.code, message: e.message });
    }
    // Never echo raw Error objects or stacks to the client.
    console.error("desk-server internal error:", e && e.stack ? e.stack : e);
    return send(res, 500, { error: "internal-error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    JSON.stringify({
      listening: `http://${HOST}:${PORT}`,
      plane: "data+onboard",
      exec: false,
      catalog: data.catalog().map((p) => p.id),
      tiers: listTiers().map((t) => t.id),
    })
  );
});
