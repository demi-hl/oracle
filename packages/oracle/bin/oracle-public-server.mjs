#!/usr/bin/env node
// Oracle Public HTTP server (Slice G) — secret-free BFF boot script.
//
//   ORACLE_PUBLIC_HOST=127.0.0.1 ORACLE_PUBLIC_PORT=8799 node bin/oracle-public-server.mjs
//
// Loopback by default. Serves ONLY the public read/assemble contract; no
// signing, no keys, no executor imports. Every response body is scanned for
// secret material before send (see src/public-api/http.mjs).

import { startPublicServer, resolvePublicBind, VERSION, PUBLIC_PLANE } from "../src/public-api/http.mjs";

const bind = resolvePublicBind();
const server = startPublicServer(bind);

server.on("listening", () => {
  const addr = server.address();
  const host = typeof addr === "object" && addr ? addr.address : bind.host;
  const port = typeof addr === "object" && addr ? addr.port : bind.port;
  // NOTE: log line intentionally carries only public bind info + version.
  console.log(
    `oracle-public-server listening on http://${host}:${port} (plane=${PUBLIC_PLANE}, version=${VERSION}, unsigned-only)`
  );
});

server.on("error", (err) => {
  console.error(`oracle-public-server failed to bind: ${err.code || err.message}`);
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    // Fallback hard-exit if sockets linger.
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
