const { app, BrowserWindow, shell, ipcMain } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");

let mainWindow = null;
let publicDesktopEnv = null;

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy(new Error("response too large"));
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode || 0, body: JSON.parse(body || "null") });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function waitForJson(url, accepts, label) {
  const deadline = Date.now() + 20_000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await requestJson(url);
      if (accepts(response)) return response.body;
      last = `${response.status} ${JSON.stringify(response.body).slice(0, 160)}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready: ${last || "no response"}`);
}

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

const SENSITIVE_ENV = /^(MAD_|ORACLE_(?:EXEC|SIGN|SIGNER|OPERATOR|COMPUTE|REMOTE|WALLET|PRIVATE|CONTROL|CAPS|ARM|GATE_BYPASS|API_KEY|BASE_URL|PROVIDER|MODEL)|ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|XAI_API_KEY|DEEPSEEK_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|CLAUDE_|CODEX_|XAI_)/;
const KEEP_ENV = [
  "PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT",
  "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
];

function stripSensitiveEnv(env) {
  for (const key of Object.keys(env)) {
    if (SENSITIVE_ENV.test(key)) delete env[key];
  }
}

function configurePublicDesktopRuntime() {
  if (publicDesktopEnv) return publicDesktopEnv;
  const home = path.join(app.getPath("userData"), "public-runtime");
  const configDir = path.join(home, ".config", "oracle");
  fs.mkdirSync(configDir, { recursive: true });
  stripSensitiveEnv(process.env);
  publicDesktopEnv = {
    ORACLE_PUBLIC_DESKTOP: "1",
    ORACLE_REMOTE_COMPUTE_DISABLE: "1",
    ORACLE_CHAT_BACKEND: "standalone",
    ORACLE_FAKE_HOME: home,
    ORACLE_CONFIG_DIR: configDir,
    MAD_CONFIG_DIR: configDir,
    HERMES_HOME: path.join(home, ".hermes"),
    ORACLE_OPERATOR_BIN_DIR: "",
    ORACLE_EXECUTE_ENABLED: "0",
    MAD_EXECUTE_ENABLED: "0",
    MAD_VALUE_CAPS_ENABLED: "1",
    ORACLE_DATA_HOST: "127.0.0.1",
    MAD_DESK_HOST: "127.0.0.1",
  };
  Object.assign(process.env, publicDesktopEnv);
  return publicDesktopEnv;
}

function publicDesktopChildEnv() {
  const base = configurePublicDesktopRuntime();
  const env = {};
  for (const key of KEEP_ENV) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, base, {
    HOME: base.ORACLE_FAKE_HOME,
    USERPROFILE: base.ORACLE_FAKE_HOME,
    ELECTRON_RUN_AS_NODE: "1",
    ORACLE_DATA_PORT: process.env.ORACLE_DATA_PORT || "",
    MAD_DESK_PORT: process.env.MAD_DESK_PORT || "",
    ORACLE_DATA_URL: process.env.ORACLE_DATA_URL || "",
    ORACLE_API_URL: process.env.ORACLE_API_URL || process.env.ORACLE_DATA_URL || "",
  });
  return env;
}

function parseCliLine(line) {
  const text = String(line || "").trim();
  if (!text) return [];
  const out = [];
  let current = "";
  let quote = null;
  let escape = false;
  for (const ch of text) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote) throw new Error("unterminated quote");
  if (escape) current += "\\";
  if (current) out.push(current);
  if (out[0] === "oracle") return out.slice(1);
  if (out[0]?.startsWith("oracle")) throw new Error("command must start with oracle");
  return out;
}

function isHelpArg(arg) {
  return ["--help", "-h"].includes(arg);
}

function publicCliPolicy(args) {
  if (args.length > 48) return { ok: false, reason: "too many arguments" };
  for (const arg of args) {
    if (arg.length > 1200 || arg.includes("\0")) return { ok: false, reason: "invalid argument" };
  }
  if (args.length === 0 || args.every(isHelpArg) || args[0] === "--version" || args[0] === "-V") return { ok: true };
  const noun = args[0];
  const rest = args.slice(1);
  if (["help", "version", "doctor", "prepare", "scan"].includes(noun)) return { ok: true };
  if (noun === "chain") {
    const verb = rest.find((arg) => !arg.startsWith("-"));
    return !verb || ["list", "current", "show"].includes(verb) || rest.some(isHelpArg)
      ? { ok: true }
      : { ok: false, reason: "chain writes are disabled in the desktop CLI" };
  }
  if (noun === "data") {
    const verb = rest.find((arg) => !arg.startsWith("-"));
    return !verb || ["health", "catalog"].includes(verb) || rest.some(isHelpArg)
      ? { ok: true }
      : { ok: false, reason: "only data health/catalog are enabled in the desktop CLI" };
  }
  if (noun === "route") {
    const verb = rest.find((arg) => !arg.startsWith("-"));
    return !verb || ["swap", "bridge", "prepare", "prepare-bridge"].includes(verb) || rest.some(isHelpArg)
      ? { ok: true }
      : { ok: false, reason: "route command is prepare-only in the desktop CLI" };
  }
  if (noun === "gate") {
    const verb = rest.find((arg) => !arg.startsWith("-"));
    return !verb || ["status", "check"].includes(verb) || rest.some(isHelpArg)
      ? { ok: true }
      : { ok: false, reason: "gate command is status/check only in the desktop CLI" };
  }
  if (noun === "model") {
    return rest.length === 0 || rest.every((arg) => arg === "--show" || isHelpArg(arg))
      ? { ok: true }
      : { ok: false, reason: "model changes are disabled in the desktop CLI" };
  }
  if (noun === "mcp") {
    return rest[0] === "print" && !rest.includes("--with-control")
      ? { ok: true }
      : { ok: false, reason: "desktop CLI only supports mcp print" };
  }
  return { ok: false, reason: `${noun} is not enabled in the desktop CLI` };
}

function runPublicCli(line) {
  return new Promise((resolve) => {
    let args;
    try {
      args = parseCliLine(line || "oracle --help");
      const policy = publicCliPolicy(args);
      if (!policy.ok) {
        resolve({ code: 64, command: `oracle ${args.join(" ")}`.trim(), stdout: "", stderr: `blocked by public desktop policy: ${policy.reason}\n` });
        return;
      }
    } catch (error) {
      resolve({ code: 64, command: "oracle", stdout: "", stderr: `${error.message}\n` });
      return;
    }

    const bin = resolveOracleBin("oracle");
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: app.getPath("userData"),
      env: publicDesktopChildEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const cap = 64 * 1024;
    const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString()).slice(-cap); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-cap); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, command: `oracle ${args.join(" ")}`.trim(), stdout, stderr: stderr || `${error.message}\n` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? 124 : (typeof code === "number" ? code : 1), command: `oracle ${args.join(" ")}`.trim(), stdout, stderr: signal ? `${stderr}\nterminated: ${signal}\n` : stderr });
    });
  });
}

ipcMain.handle("oracle:cli:run", (_event, line) => runPublicCli(line));

function findPackageRoot(entry) {
  let dir = path.dirname(entry);
  for (let depth = 0; depth < 10; depth += 1) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (parsed.name === "@oracle-agent/oracle") return { dir, manifest: parsed };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not resolve @oracle-agent/oracle package root from ${entry}`);
}

function resolveOracleBin(name) {
  const entry = require.resolve("@oracle-agent/oracle");
  const { dir, manifest } = findPackageRoot(entry);
  const target = manifest.bin && manifest.bin[name];
  if (!target) throw new Error(`@oracle-agent/oracle does not expose bin ${name}`);
  const file = path.resolve(dir, target);
  if (!fs.existsSync(file)) throw new Error(`missing ${name} bin at ${file}`);
  return file;
}

function resolveBundledServer() {
  const suffix = path.join("oracle-app", "apps", "oracle-app", "server.js");
  const candidates = [
    process.env.ORACLE_DESKTOP_RUNTIME_DIR
      ? path.join(process.env.ORACLE_DESKTOP_RUNTIME_DIR, "apps", "oracle-app", "server.js")
      : null,
    process.resourcesPath ? path.join(process.resourcesPath, suffix) : null,
    path.resolve(__dirname, "..", "runtime", suffix),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`missing bundled Oracle app server, checked ${candidates.join(", ")}`);
}

async function startDataPlane() {
  configurePublicDesktopRuntime();
  const port = Number(process.env.ORACLE_DATA_PORT || (await reservePort()));
  process.env.ORACLE_DATA_HOST = process.env.ORACLE_DATA_HOST || "127.0.0.1";
  process.env.MAD_DESK_HOST = process.env.MAD_DESK_HOST || "127.0.0.1";
  process.env.ORACLE_DATA_PORT = String(port);
  process.env.MAD_DESK_PORT = String(port);
  process.env.ORACLE_DATA_URL = `http://127.0.0.1:${port}`;
  process.env.ORACLE_API_URL = process.env.ORACLE_API_URL || process.env.ORACLE_DATA_URL;

  const bin = resolveOracleBin("oracle-data");
  await import(pathToFileURL(bin).href);
  await waitForJson(
    `${process.env.ORACLE_DATA_URL}/health`,
    (response) => response.status === 200 && response.body && response.body.exec === false,
    "Oracle data plane",
  );

  // The desk IS the swap-prepare host. Without this the app reported
  // "Oracle desk is not configured" forever and no quote could be built.
  process.env.ORACLE_DESK_URL = process.env.ORACLE_DESK_URL || process.env.ORACLE_DATA_URL;

  return process.env.ORACLE_DATA_URL;
}

/**
 * Public read plane (portfolio / approvals / NFTs).
 *
 * Separate process from the desk and separately ported. It is started in-process
 * like the data plane so a packaged install has no external prerequisites: the
 * app previously defaulted to 127.0.0.1:8799, which nothing ever bound, so every
 * wallet read silently degraded to "add a public wallet address".
 */
async function startPublicPlane() {
  const port = Number(process.env.ORACLE_PUBLIC_PORT || (await reservePort()));
  process.env.ORACLE_PUBLIC_HOST = process.env.ORACLE_PUBLIC_HOST || "127.0.0.1";
  process.env.ORACLE_PUBLIC_PORT = String(port);
  const url = `http://127.0.0.1:${port}`;
  process.env.ORACLE_PUBLIC_URL = process.env.ORACLE_PUBLIC_URL || url;

  const bin = resolveOracleBin("oracle-public");
  await import(pathToFileURL(bin).href);
  await waitForJson(
    `${url}/public/health`,
    (response) => response.status === 200,
    "Oracle public plane",
  );
  return url;
}

async function startBundledApp() {
  if (process.env.ORACLE_DESKTOP_DEV_URL) return process.env.ORACLE_DESKTOP_DEV_URL;

  const port = Number(process.env.PORT || (await reservePort()));
  process.env.HOSTNAME = process.env.HOSTNAME || "127.0.0.1";
  process.env.ORACLE_APP_HOST = process.env.ORACLE_APP_HOST || "127.0.0.1";
  process.env.PORT = String(port);

  const serverPath = resolveBundledServer();
  const previousCwd = process.cwd();
  process.chdir(path.dirname(serverPath));
  require(serverPath);
  process.chdir(previousCwd);

  const url = `http://127.0.0.1:${port}`;
  await waitForJson(
    `${url}/api/health`,
    (response) => response.status === 200 && response.body && response.body.custody === "public-keyless-prepare-only",
    "Oracle app",
  );
  await waitForJson(
    `${url}/api/oracle/status`,
    (response) => response.status === 200 && response.body && response.body.reachable === true && response.body.readOnly === true,
    "Oracle app data bridge",
  );
  return url;
}

function safeExternal(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: "Oracle",
    backgroundColor: "#05070a",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (safeExternal(target)) shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (target !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (safeExternal(target)) shell.openExternal(target);
    }
  });
  mainWindow.loadURL(url);
  return mainWindow;
}

// Headless acceptance: boot the real shell, prove the renderer actually painted
// Oracle's own document, then exit. Without this the only desktop evidence is
// that two servers answered HTTP, which says nothing about the Electron app.
//
// This must NOT navigate. An earlier version called loadURL(url) here, which
// silently repaired a broken createWindow: pointing the window at about:blank
// still passed, because the smoke re-navigated it to the right place. Wait for
// whatever the shell itself loaded, then assert against that.
async function runSmoke(win, url) {
  if (win.webContents.isLoading()) {
    await new Promise((resolve, reject) => {
      win.webContents.once("did-finish-load", resolve);
      win.webContents.once("did-fail-load", (_event, code, description) =>
        reject(new Error(`shell failed to load: ${code} ${description}`)),
      );
    });
  }

  const loaded = win.webContents.getURL();
  const title = await win.webContents.executeJavaScript("document.title");
  const bodyLength = await win.webContents.executeJavaScript("document.body.innerText.length");
  const health = await win.webContents
    .executeJavaScript(`fetch("/api/health").then((r) => r.json()).then((j) => j.custody).catch(() => null)`)
    .catch(() => null);
  const cliHelp = await win.webContents
    .executeJavaScript(`window.oracleDesktop.runCli("oracle --help")`)
    .catch((error) => ({ code: 1, stderr: error.message || String(error) }));
  const cliBlocked = await win.webContents
    .executeJavaScript(`window.oracleDesktop.runCli("oracle sign doctor")`)
    .catch((error) => ({ code: 1, stderr: error.message || String(error) }));

  const ok =
    loaded.startsWith(url) &&
    health === "public-keyless-prepare-only" &&
    cliHelp.code === 0 &&
    /self-custody multichain agent control plane/i.test(cliHelp.stdout || "") &&
    cliBlocked.code === 64 &&
    /blocked by public desktop policy/i.test(cliBlocked.stderr || "") &&
    typeof title === "string" &&
    /oracle/i.test(title) &&
    bodyLength > 200;
  const receipt = { ok, expected: url, loaded, title, bodyLength, health, cli: { help: cliHelp.code, blocked: cliBlocked.code } };

  if (!ok) {
    console.error(JSON.stringify(receipt));
    app.exit(1);
    return;
  }
  console.log(JSON.stringify(receipt));
  app.exit(0);
}

app.whenReady().then(async () => {
  try {
    await startDataPlane();
    // Read plane must be up before the app boots: startBundledApp() waits on
    // /api/oracle/status, which reads through it.
    await startPublicPlane();
    const url = await startBundledApp();
    const win = createWindow(url);
    if (process.env.ORACLE_DESKTOP_SMOKE === "1") await runSmoke(win, url);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    startBundledApp().then(createWindow).catch((error) => {
      console.error(error);
      app.exit(1);
    });
  }
});
