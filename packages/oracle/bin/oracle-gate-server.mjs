#!/usr/bin/env node
/**
 * Locals Only distribution gate.
 *
 * Serves exactly three things:
 *   POST /gate/challenge  -> a nonce + message to sign
 *   POST /gate/verify     -> signature in, session token out
 *   GET  /gate/install    -> the install command, holders only
 *
 * This is the ONE piece of Oracle that is meant to run on a server the operator
 * controls. Everything else in this repo binds loopback and is keyless by
 * design; a gate that runs on the visitor's machine is not a gate. Bind this to
 * 0.0.0.0 behind TLS deliberately, via ORACLE_GATE_HOST.
 *
 * It never touches key material. verifyMessage RECOVERS a public address from a
 * signature the user's own wallet produced.
 */

import { createServer } from "node:http";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";

import {
  createNonceStore,
  issueChallenge,
  verifyChallenge,
  readSession,
  isAddress,
  LOCALS_ONLY_CONTRACT,
  LOCALS_ONLY_CHAIN_ID,
} from "../src/gate/holder-gate.mjs";

const PORT = Number(process.env.ORACLE_GATE_PORT || 8810);
const HOST = process.env.ORACLE_GATE_HOST || "127.0.0.1";
const DOMAIN = process.env.ORACLE_GATE_DOMAIN || `${HOST}:${PORT}`;
const INSTALL_COMMAND = process.env.ORACLE_INSTALL_COMMAND || "npm install -g @oracle-agent/oracle";

/**
 * Gated distribution.
 *
 * A gate that only returns an `npm install` line protects nothing while the
 * package sits on the public registry: a non-holder skips this server and runs
 * the command themselves. Client-side checks cannot fix that, because the code
 * doing the checking is on the visitor's machine.
 *
 * So the artifact itself is served from here, to a proven holder, behind a
 * short-lived signed URL. Set ORACLE_GATE_TARBALL to the packed .tgz. When it
 * is unset the server keeps its old behaviour and says so, rather than
 * pretending to gate a public package.
 */
const TARBALL = process.env.ORACLE_GATE_TARBALL || "";
const DOWNLOAD_TTL_MS = Number(process.env.ORACLE_GATE_DOWNLOAD_TTL_MS || 5 * 60 * 1000);

// First round is holders only, so the desktop builds sit behind the same proof
// as the CLI rather than on a public release page. The artifact id is signed
// alongside the address, so a link minted for one build cannot be rewritten to
// fetch another.
const ARTIFACTS = {
  cli: { path: TARBALL, type: "application/gzip" },
  linux: { path: process.env.ORACLE_GATE_APPIMAGE || "", type: "application/octet-stream" },
  mac: { path: process.env.ORACLE_GATE_DMG || "", type: "application/x-apple-diskimage" },
  win: { path: process.env.ORACLE_GATE_EXE || "", type: "application/octet-stream" },
};

function artifactFor(id) {
  const entry = ARTIFACTS[id || "cli"];
  if (!entry || !entry.path || !existsSync(entry.path)) return null;
  return entry;
}

function availableArtifacts() {
  return Object.keys(ARTIFACTS).filter((k) => artifactFor(k));
}

function signDownload(address, expiresAt, artifact = "cli") {
  return createHmac("sha256", SECRET)
    .update(`${address.toLowerCase()}.${expiresAt}.${artifact}`)
    .digest("base64url");
}

function verifyDownload(address, expiresAt, sig, artifact = "cli", now = Date.now()) {
  if (!isAddress(String(address || "")) || !Number.isFinite(expiresAt) || expiresAt < now) return false;
  const expected = Buffer.from(signDownload(address, expiresAt, artifact));
  const supplied = Buffer.from(String(sig || ""));
  // Length first: timingSafeEqual throws when the buffers differ in size.
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

/**
 * Session signing secret. Generated per process when unset, which invalidates
 * live sessions on restart. That is the safe default: a hardcoded fallback
 * would let anyone who reads this file mint valid sessions.
 */
const SECRET = process.env.ORACLE_GATE_SECRET || randomBytes(32).toString("hex");
if (!process.env.ORACLE_GATE_SECRET) {
  console.warn("[gate] ORACLE_GATE_SECRET unset: sessions will not survive a restart");
}

const store = createNonceStore();
setInterval(() => store.prune(), 60_000).unref();

const MAX_BODY = 4096;

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("body-too-large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid-json");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || DOMAIN}`);

  try {
    if (req.method === "POST" && url.pathname === "/gate/challenge") {
      const body = await readBody(req);
      if (!isAddress(body.address)) return json(res, 400, { error: "invalid-address" });
      const challenge = issueChallenge(body.address, { domain: DOMAIN, store });
      return json(res, 200, challenge);
    }

    if (req.method === "POST" && url.pathname === "/gate/verify") {
      const body = await readBody(req);
      if (!body.nonce || !body.signature) return json(res, 400, { error: "nonce-and-signature-required" });
      try {
        const result = await verifyChallenge({
          nonce: String(body.nonce),
          signature: String(body.signature),
          store,
          secret: SECRET,
        });
        return json(res, 200, result);
      } catch (error) {
        const reason = error.message;
        // A non-holder gets a clear, actionable answer. Everything else is a
        // protocol failure and says so without leaking internals.
        const status = reason === "not-a-holder" ? 403 : 401;
        return json(res, status, {
          error: reason,
          message: reason === "not-a-holder"
            ? "This wallet does not hold a Locals Only NFT."
            : "Challenge verification failed.",
          contract: LOCALS_ONLY_CONTRACT,
          chainId: LOCALS_ONLY_CHAIN_ID,
        });
      }
    }

    if (req.method === "GET" && url.pathname === "/gate/install") {
      const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const session = readSession(token, { secret: SECRET });
      if (!session) return json(res, 401, { error: "session-required" });

      // Gated artifact: mint a short-lived signed URL bound to THIS holder's
      // address. The link expires and cannot be reused by another wallet.
      // Desktop builds ride the same proof as the CLI. Round one is holders
      // only, so nothing sits on a public release page.
      const downloads = {};
      for (const id of availableArtifacts()) {
        const exp = Date.now() + DOWNLOAD_TTL_MS;
        const s2 = signDownload(session.address, exp, id);
        const q2 = new URLSearchParams({ address: session.address, expires: String(exp), sig: s2, artifact: id });
        downloads[id] = { url: `/gate/download?${q2.toString()}`, expiresAt: exp };
      }

      let download = null;
      if (TARBALL && existsSync(TARBALL)) {
        const expiresAt = Date.now() + DOWNLOAD_TTL_MS;
        const sig = signDownload(session.address, expiresAt, "cli");
        const qs = new URLSearchParams({ address: session.address, expires: String(expiresAt), sig, artifact: "cli" });
        const href = `/gate/download?${qs.toString()}`;
        // Two steps, deliberately. npm 12 refuses to fetch a package from a
        // URL at all (EALLOWREMOTE: "Fetching packages of type remote have
        // been disabled"), so `npm i -g <url>` is dead on current npm even
        // though the tarball itself installs fine from a local path. Verified
        // 2026-08-06 on npm 12.0.1.
        download = {
          url: href,
          expiresAt,
          command: `curl -fL -o oracle.tgz "<gate-origin>${href}" && npm i -g ./oracle.tgz`,
        };
      }

      return json(res, 200, {
        address: session.address,
        balance: session.balance,
        // Honest about which mode this deployment is in. A public-registry
        // install is convenience, not enforcement, and must not be labelled
        // as gated.
        distribution: download ? "gated-tarball" : "public-registry",
        download,
        downloads,
        install: download ? download.command : INSTALL_COMMAND,
        next: [
          INSTALL_COMMAND,
          "oracle init",
          "oracle mcp install claude-code",
        ],
      });
    }

    if (req.method === "GET" && url.pathname === "/gate/download") {
      const artifactId = url.searchParams.get("artifact") || "cli";
      const entry = artifactFor(artifactId);
      if (!entry) {
        return json(res, 503, {
          error: "no-artifact",
          message: `No artifact configured for "${artifactId}". Available: ${availableArtifacts().join(", ") || "none"}.`,
        });
      }
      const address = url.searchParams.get("address");
      const expiresAt = Number(url.searchParams.get("expires"));
      const sig = url.searchParams.get("sig");
      // The signature binds the artifact to one address and one deadline. A
      // link that leaks is useless after DOWNLOAD_TTL_MS, and cannot be edited
      // to name a different wallet without invalidating the HMAC.
      if (!verifyDownload(address, expiresAt, sig, artifactId)) {
        return json(res, 403, {
          error: "invalid-or-expired-link",
          message: "Re-authenticate with the gate to mint a fresh download link.",
        });
      }
      const file = resolvePath(entry.path);
      const size = statSync(file).size;
      res.writeHead(200, {
        "content-type": entry.type,
        "content-length": String(size),
        "content-disposition": `attachment; filename="${basename(file)}"`,
        "cache-control": "no-store",
      });
      createReadStream(file).pipe(res);
      return undefined;
    }

    if (req.method === "GET" && url.pathname === "/gate/health") {
      return json(res, 200, {
        ok: true,
        gate: "locals-only",
        contract: LOCALS_ONLY_CONTRACT,
        chainId: LOCALS_ONLY_CHAIN_ID,
        pendingChallenges: store.size,
        distribution: TARBALL && existsSync(TARBALL) ? "gated-tarball" : "public-registry",
      });
    }

    return json(res, 404, { error: "not-found" });
  } catch (error) {
    const status = error.message === "body-too-large" ? 413 : 400;
    return json(res, status, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[gate] locals-only distribution gate on http://${HOST}:${PORT}`);
  console.log(`[gate] contract ${LOCALS_ONLY_CONTRACT} chain ${LOCALS_ONLY_CHAIN_ID}`);
  if (TARBALL && existsSync(TARBALL)) {
    console.log(`[gate] serving gated artifact ${TARBALL}`);
  } else {
    console.warn("[gate] ORACLE_GATE_TARBALL unset: handing out a PUBLIC registry command.");
    console.warn("[gate] That is discovery, not enforcement — anyone can run it without this gate.");
  }
});
