import { existsSync, readFileSync } from "node:fs";
import { get } from "node:http";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const desktopDir = join(root, "apps/oracle-desktop");
const server = join(desktopDir, "runtime/oracle-app/apps/oracle-app/server.js");
const oraclePkg = JSON.parse(readFileSync(join(root, "packages/oracle/package.json"), "utf8"));

function bin(name) {
  const file = join(root, "node_modules/.bin", name + (process.platform === "win32" ? ".cmd" : ""));
  if (!existsSync(file)) throw new Error(`missing bin ${file}; run npm ci first`);
  return file;
}

// npm writes .cmd shims on Windows, and CreateProcess cannot execute a batch
// file directly — spawn fails with EINVAL. Everything that launches a bin must
// go through a shell there.
const needsShell = process.platform === "win32";
const publicDesktopEnv = {
  ORACLE_PUBLIC_DESKTOP: "1",
  ORACLE_REMOTE_COMPUTE_DISABLE: "1",
  ORACLE_OPERATOR_BIN_DIR: "",
  ORACLE_GATE_BYPASS: "0",
  ORACLE_EXECUTE_ENABLED: "0",
  MAD_EXECUTE_ENABLED: "0",
};

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

function request(url) {
  return new Promise((resolve, reject) => {
    const req = get(url, { timeout: 5000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy(new Error("response too large"));
      });
      res.on("end", () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function waitFor(url, accepts, label) {
  const deadline = Date.now() + 25_000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await request(url);
      if (accepts(response)) return response;
      last = `${response.status} ${response.body.slice(0, 160)}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready: ${last || "no response"}`);
}

function parseJson(response) {
  try {
    return JSON.parse(response.body);
  } catch (error) {
    throw new Error(`invalid JSON from status ${response.status}: ${error.message}`);
  }
}

function spawnManaged(name, command, args, env, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  const logs = [];
  const capture = (chunk) => {
    logs.push(String(chunk));
    while (logs.join("").length > 8000) logs.shift();
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      console.error(`${name} exited ${code || signal}:\n${logs.join("")}`);
    }
  });
  return { child, logs };
}

async function run() {
  if (!existsSync(server)) throw new Error(`missing staged Next server ${server}`);

  const dataPort = await reservePort();
  const appPort = await reservePort();
  const dataUrl = `http://127.0.0.1:${dataPort}`;
  const appUrl = `http://127.0.0.1:${appPort}`;

  const version = await new Promise((resolve, reject) => {
    // The shim path is quoted because Windows installs land under
    // "C:\Program Files\..." and shell:true concatenates rather than escapes.
    const target = needsShell ? `"${bin("oracle")}"` : bin("oracle");
    const child = spawn(target, ["--version"], { cwd: root, env: { ...process.env, ...publicDesktopEnv }, shell: needsShell });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(out.trim()))));
  });
  if (!version.includes(oraclePkg.version)) {
    throw new Error(`oracle CLI version mismatch: expected ${oraclePkg.version}, got ${version}`);
  }
  if (/operator\s+\d/i.test(version)) {
    throw new Error(`public desktop CLI must not resolve a host operator: ${version}`);
  }

  // Only the npm .cmd shim needs a shell. process.execPath must NOT get one:
  // it is an unquoted absolute path, and on Windows that is "C:\Program
  // Files\nodejs\node.exe", which the shell splits at the space and reports as
  // "'C:\Program' is not recognized".
  const data = spawnManaged("oracle-data", bin("oracle-data"), [], {
    ...publicDesktopEnv,
    ORACLE_DATA_HOST: "127.0.0.1",
    MAD_DESK_HOST: "127.0.0.1",
    ORACLE_DATA_PORT: String(dataPort),
    MAD_DESK_PORT: String(dataPort),
  }, { shell: needsShell });
  const app = spawnManaged("oracle-app", process.execPath, [server], {
    ...publicDesktopEnv,
    HOSTNAME: "127.0.0.1",
    ORACLE_APP_HOST: "127.0.0.1",
    PORT: String(appPort),
    ORACLE_DATA_URL: dataUrl,
    ORACLE_API_URL: dataUrl,
  });

  try {
    const dataHealth = parseJson(await waitFor(`${dataUrl}/health`, (r) => r.status === 200, "oracle-data"));
    if (dataHealth.exec !== false || dataHealth.version !== oraclePkg.version) {
      throw new Error(`bad data health ${JSON.stringify(dataHealth)}`);
    }

    const health = parseJson(await waitFor(`${appUrl}/api/health`, (r) => r.status === 200, "app health"));
    if (health.custody !== "public-keyless-prepare-only") {
      throw new Error(`bad app custody ${JSON.stringify(health)}`);
    }

    const status = parseJson(await waitFor(`${appUrl}/api/oracle/status`, (r) => r.status === 200, "app status"));
    if (status.reachable !== true || status.readOnly !== true || status.version !== oraclePkg.version) {
      throw new Error(`bad app status ${JSON.stringify(status)}`);
    }

    const catalog = parseJson(await waitFor(`${appUrl}/api/oracle/catalog`, (r) => r.status === 200, "catalog"));
    if (!Array.isArray(catalog.catalog) || catalog.catalog.length < 5) {
      throw new Error(`catalog did not bridge from the CLI data plane: ${JSON.stringify(catalog).slice(0, 240)}`);
    }

    const signer = parseJson(await waitFor(`${appUrl}/api/oracle/signer`, (r) => r.status === 200, "signer posture"));
    if (signer.configured !== false || signer.reachable !== false || signer.armed !== false) {
      throw new Error(`desktop must not auto-configure a signer: ${JSON.stringify(signer)}`);
    }

    const page = await waitFor(appUrl, (r) => r.status === 200 && /Oracle|Ask Oracle|self-custody/i.test(r.body), "home page");
    if (!/ORACLE|Oracle/i.test(page.body)) throw new Error("home page did not render Oracle copy");

    console.log(JSON.stringify({ ok: true, cli: version, data: dataHealth, status, catalogCount: catalog.catalog.length, appUrl }, null, 2));
  } finally {
    // SIGTERM does not exist on Windows, and because the .cmd shim runs under a
    // shell, child.kill() only reaps cmd.exe — the real node server survives,
    // keeps the port, and the script never exits. taskkill /T kills the tree.
    for (const proc of [app.child, data.child]) {
      if (proc.killed || proc.exitCode !== null) continue;
      if (needsShell) {
        try {
          execFileSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
        } catch {
          proc.kill();
        }
      } else {
        proc.kill("SIGTERM");
      }
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

// A hang is worse than a failure: it burns a CI runner for its whole timeout and
// reports nothing. Fail loudly instead.
const budget = setTimeout(() => {
  console.error("  FAIL runtime smoke exceeded 5m budget (servers likely never became ready)");
  process.exit(1);
}, 300_000);
budget.unref();
