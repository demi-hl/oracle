// desk-server local-caller guard: DNS rebinding and cross-origin CSRF.
//
// The server binds loopback and was documented as "safe because local", but
// loopback is not a boundary against a browser: any page the operator visits
// can POST to 127.0.0.1, and a rebinding host can reach it under an attacker
// name. Both arrive carrying the server's own API keys.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 8899;
let proc;

async function start() {
  proc = spawn(process.execPath, ["bin/desk-server.mjs"], {
    env: { ...process.env, ORACLE_DATA_PORT: String(PORT), ORACLE_DATA_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
    // Detach so we can kill the whole group: the server holds the port and an
    // orphan would hang the next run.
    detached: true,
  });
  proc.unref();
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("desk-server did not become ready");
}

function stop() {
  if (!proc?.pid) return;
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Send a raw HTTP request so we control the Host header verbatim.
 * Node's fetch() rewrites Host from the URL, which would silently turn the
 * DNS-rebinding case into a normal loopback request and make this test lie.
 */
function rawRequest(headerLines) {
  return new Promise((resolve, reject) => {
    const sock = connect(PORT, "127.0.0.1", () => {
      sock.write(headerLines.join("\r\n") + "\r\n\r\n");
    });
    let buf = "";
    sock.setTimeout(5000, () => {
      sock.destroy();
      reject(new Error("raw request timed out"));
    });
    sock.on("data", (d) => {
      buf += d.toString();
    });
    sock.on("end", () => resolve(buf));
    sock.on("close", () => resolve(buf));
    sock.on("error", reject);
  });
}

function statusOf(raw) {
  const m = /^HTTP\/1\.\d (\d{3})/.exec(raw || "");
  return m ? Number(m[1]) : null;
}

test("desk-server rejects rebinding and cross-origin callers", { timeout: 60_000 }, async (t) => {
  await start();
  t.after(stop);

  // A normal local caller (no Origin, loopback Host) still works.
  const ok = statusOf(await rawRequest([`GET /health HTTP/1.1`, `Host: 127.0.0.1:${PORT}`, "Connection: close"]));
  assert.equal(ok, 200, "a legitimate local caller must still be served");

  // DNS rebinding: the connection lands on loopback but claims another name.
  const rebind = statusOf(await rawRequest([`GET /health HTTP/1.1`, `Host: attacker.example`, "Connection: close"]));
  assert.equal(rebind, 403, "a non-loopback Host header must be refused");

  // A page the operator visited issuing a cross-origin request.
  const crossOrigin = statusOf(
    await rawRequest([`GET /health HTTP/1.1`, `Host: 127.0.0.1:${PORT}`, "Origin: https://evil.example", "Connection: close"])
  );
  assert.equal(crossOrigin, 403, "a cross-origin browser request must be refused");

  // The op surface must be equally protected, not just /health.
  const args = encodeURIComponent('{"amountHype":"100"}');
  const op = statusOf(
    await rawRequest([
      `GET /data/call?provider=hl-staking&op=prepareStakeDeposit&args=${args} HTTP/1.1`,
      `Host: 127.0.0.1:${PORT}`,
      "Origin: https://evil.example",
      "Connection: close",
    ])
  );
  assert.equal(op, 403, "a cross-origin caller must not reach a prepare op");

  // A same-origin localhost page is legitimate.
  const sameOrigin = statusOf(
    await rawRequest([
      `GET /health HTTP/1.1`,
      `Host: 127.0.0.1:${PORT}`,
      `Origin: http://127.0.0.1:${PORT}`,
      "Connection: close",
    ])
  );
  assert.equal(sameOrigin, 200, "a same-origin local page must still work");
});
