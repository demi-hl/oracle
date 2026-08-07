import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";

import { ensureDir, oracleConfigDir } from "../cli/paths.mjs";

const PROVIDERS = Object.freeze({
  "anthropic-oauth": {
    aliases: ["anthropic-oauth", "anthropic", "claude", "claude-oauth"],
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    redirectUri: "https://console.anthropic.com/oauth/code/callback",
    scope: "org:create_api_key user:profile user:inference",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-6",
    protocol: "anthropic-messages",
  },
  "openai-codex": {
    aliases: ["openai-codex", "openai-oauth", "codex", "codex-oauth"],
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    issuer: "https://auth.openai.com",
    tokenUrl: "https://auth.openai.com/oauth/token",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    model: "gpt-5.6-sol",
    protocol: "responses",
  },
  "xai-oauth": {
    aliases: ["xai-oauth", "xai", "grok", "grok-oauth"],
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    issuer: "https://auth.x.ai",
    discoveryUrl: "https://auth.x.ai/.well-known/openid-configuration",
    deviceUrl: "https://auth.x.ai/oauth2/device/code",
    scope: "openid profile email offline_access grok-cli:access api:access",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4.5",
    protocol: "responses",
  },
});

const REFRESH_SKEW_MS = 120_000;

function nowMs(options = {}) {
  return typeof options.now === "function" ? Number(options.now()) : Date.now();
}

function providerConfig(value) {
  return PROVIDERS[oauthProviderId(value)];
}

export function oauthProviderId(value) {
  const needle = String(value || "").trim().toLowerCase();
  for (const [id, config] of Object.entries(PROVIDERS)) {
    if (config.aliases.includes(needle)) return id;
  }
  throw new Error(`unsupported OAuth provider: ${value || "(empty)"}`);
}

export function oauthProviderConfig(value) {
  const id = oauthProviderId(value);
  return { id, ...PROVIDERS[id] };
}

function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid object");
    return parsed;
  } catch {
    throw new Error(`credential store is unreadable or corrupt: ${path.basename(file)}`);
  }
}

function ensurePrivateDir(dir) {
  ensureDir(dir);
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

function atomicJsonWrite(file, value) {
  ensurePrivateDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

function linuxSecretToolAvailable(spawnFn) {
  if (process.platform !== "linux") return false;
  const result = spawnFn("secret-tool", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return !result.error && result.status === 0;
}

function normalizeApiKeyProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(provider)) throw new Error(`invalid API-key provider: ${value || "(empty)"}`);
  return provider;
}

function normalizeCredential(credential = {}) {
  const accessToken = String(credential.accessToken || credential.access_token || "").trim();
  const refreshToken = String(credential.refreshToken || credential.refresh_token || "").trim();
  const expiresAt = Number(credential.expiresAt || credential.expires_at || 0);
  if (!accessToken) throw new Error("OAuth credential is missing access token");
  return {
    accessToken,
    refreshToken,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    tokenType: String(credential.tokenType || credential.token_type || "Bearer"),
    source: String(credential.source || "oracle"),
    ...(credential.discovery ? { discovery: credential.discovery } : {}),
    ...(credential.scope ? { scope: credential.scope } : {}),
    ...(credential.idToken || credential.id_token ? { idToken: String(credential.idToken || credential.id_token) } : {}),
  };
}

export function createOAuthStore(options = {}) {
  const file = options.file || path.join(oracleConfigDir(), "oauth.json");
  const metadataFile = options.metadataFile || path.join(path.dirname(file), "oauth-meta.json");
  const spawnFn = options.spawnFn || spawnSync;
  const useSecretTool = options.keychain !== false &&
    process.env.ORACLE_AUTH_FILE_STORE !== "1" &&
    linuxSecretToolAvailable(spawnFn);
  const storage = useSecretTool ? "linux-secret-service" : "private-file";
  const lockFile = `${file}.lock`;

  async function withLock(fn) {
    ensurePrivateDir(path.dirname(lockFile));
    let descriptor;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      try {
        descriptor = fs.openSync(lockFile, "wx", 0o600);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          if (Date.now() - fs.statSync(lockFile).mtimeMs > 300_000) fs.unlinkSync(lockFile);
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (descriptor === undefined) throw new Error("timed out waiting for OAuth credential lock");
    try {
      return await fn();
    } finally {
      try { fs.closeSync(descriptor); } catch {}
      try { fs.unlinkSync(lockFile); } catch {}
    }
  }

  function secretArgs(provider, kind = "oauth") {
    return ["application", "oracle", "kind", kind, "provider", provider];
  }

  function get(providerValue) {
    const provider = oauthProviderId(providerValue);
    if (useSecretTool) {
      const result = spawnFn("secret-tool", ["lookup", ...secretArgs(provider)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (result.error || result.status !== 0 || !String(result.stdout || "").trim()) return null;
      try {
        return normalizeCredential(JSON.parse(String(result.stdout).trim()));
      } catch {
        return null;
      }
    }
    const state = readJson(file, { providers: {} });
    const value = state.providers?.[provider];
    if (!value) return null;
    try {
      return normalizeCredential(value);
    } catch {
      return null;
    }
  }

  function set(providerValue, credential) {
    const provider = oauthProviderId(providerValue);
    const normalized = normalizeCredential(credential);
    if (useSecretTool) {
      const result = spawnFn("secret-tool", ["store", `--label=Oracle ${provider} OAuth`, ...secretArgs(provider)], {
        input: JSON.stringify(normalized),
        encoding: "utf8",
        stdio: ["pipe", "ignore", "pipe"],
      });
      if (result.error || result.status !== 0) throw new Error("OS credential store rejected OAuth credential");
      const metadata = readJson(metadataFile, { providers: {} });
      metadata.providers ||= {};
      metadata.providers[provider] = {
        expiresAt: normalized.expiresAt,
        source: normalized.source,
      };
      atomicJsonWrite(metadataFile, metadata);
      return normalized;
    }
    const state = readJson(file, { providers: {} });
    state.providers ||= {};
    state.providers[provider] = normalized;
    atomicJsonWrite(file, state);
    return normalized;
  }

  function remove(providerValue) {
    const provider = oauthProviderId(providerValue);
    if (useSecretTool) {
      const result = spawnFn("secret-tool", ["clear", ...secretArgs(provider)], {
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
      });
      const metadata = readJson(metadataFile, { providers: {} });
      if (metadata.providers) delete metadata.providers[provider];
      atomicJsonWrite(metadataFile, metadata);
      return !result.error && result.status === 0;
    }
    const state = readJson(file, { providers: {} });
    const existed = Boolean(state.providers?.[provider]);
    if (state.providers) delete state.providers[provider];
    atomicJsonWrite(file, state);
    return existed;
  }

  function getApiKey(providerValue) {
    const provider = normalizeApiKeyProvider(providerValue);
    if (useSecretTool) {
      const result = spawnFn("secret-tool", ["lookup", ...secretArgs(provider, "api-key")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return result.error || result.status !== 0 ? "" : String(result.stdout || "").trim();
    }
    return String(readJson(file, { apiKeys: {} }).apiKeys?.[provider] || "").trim();
  }

  function setApiKey(providerValue, apiKeyValue) {
    const provider = normalizeApiKeyProvider(providerValue);
    const apiKey = String(apiKeyValue || "").trim();
    if (!apiKey) throw new Error("API key is empty");
    if (useSecretTool) {
      const result = spawnFn("secret-tool", ["store", `--label=Oracle ${provider} API key`, ...secretArgs(provider, "api-key")], {
        input: apiKey,
        encoding: "utf8",
        stdio: ["pipe", "ignore", "pipe"],
      });
      if (result.error || result.status !== 0) throw new Error("OS credential store rejected API key");
      const metadata = readJson(metadataFile, { providers: {}, apiKeys: {} });
      metadata.apiKeys ||= {};
      metadata.apiKeys[provider] = { configured: true };
      atomicJsonWrite(metadataFile, metadata);
      return true;
    }
    const state = readJson(file, { providers: {}, apiKeys: {} });
    state.apiKeys ||= {};
    state.apiKeys[provider] = apiKey;
    atomicJsonWrite(file, state);
    return true;
  }

  function removeApiKey(providerValue) {
    const provider = normalizeApiKeyProvider(providerValue);
    if (useSecretTool) {
      const result = spawnFn("secret-tool", ["clear", ...secretArgs(provider, "api-key")], {
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
      });
      const metadata = readJson(metadataFile, { providers: {}, apiKeys: {} });
      if (metadata.apiKeys) delete metadata.apiKeys[provider];
      atomicJsonWrite(metadataFile, metadata);
      return !result.error && result.status === 0;
    }
    const state = readJson(file, { providers: {}, apiKeys: {} });
    const existed = Boolean(state.apiKeys?.[provider]);
    if (state.apiKeys) delete state.apiKeys[provider];
    atomicJsonWrite(file, state);
    return existed;
  }

  function status() {
    const providers = {};
    const apiKeys = {};
    if (useSecretTool) {
      const metadata = readJson(metadataFile, { providers: {}, apiKeys: {} });
      for (const [provider, value] of Object.entries(metadata.providers || {})) {
        providers[provider] = {
          loggedIn: Boolean(get(provider)),
          expiresAt: Number(value.expiresAt || 0),
          source: String(value.source || "oracle"),
          storage,
        };
      }
      for (const provider of Object.keys(metadata.apiKeys || {})) {
        apiKeys[provider] = { configured: Boolean(getApiKey(provider)), storage };
      }
    } else {
      const state = readJson(file, { providers: {}, apiKeys: {} });
      for (const [provider, value] of Object.entries(state.providers || {})) {
        providers[provider] = {
          loggedIn: Boolean(value?.accessToken),
          expiresAt: Number(value?.expiresAt || 0),
          source: String(value?.source || "oracle"),
          storage,
        };
      }
      for (const [provider, value] of Object.entries(state.apiKeys || {})) {
        apiKeys[provider] = { configured: Boolean(value), storage };
      }
    }
    return { storage, providers, apiKeys };
  }

  return Object.freeze({
    file,
    storage,
    get,
    set,
    remove,
    getApiKey,
    setApiKey,
    removeApiKey,
    status,
    withLock,
  });
}

let defaultStore;
export function getOAuthStore() {
  defaultStore ||= createOAuthStore();
  return defaultStore;
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function generatePkce() {
  const verifier = base64url(randomBytes(32));
  return {
    verifier,
    challenge: base64url(createHash("sha256").update(verifier).digest()),
    state: base64url(randomBytes(24)),
  };
}

function sameState(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function openBrowser(url) {
  const target = String(url);
  const spec = process.platform === "darwin"
    ? ["open", [target]]
    : process.platform === "win32"
      ? ["cmd.exe", ["/d", "/s", "/c", "start", "", target]]
      : ["xdg-open", [target]];
  try {
    const child = spawn(spec[0], spec[1], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function formBody(value) {
  return new URLSearchParams(value).toString();
}

async function responseJson(response, label) {
  if (!response?.ok) {
    let code = "";
    try {
      code = String((await response.json())?.error || "");
    } catch {}
    throw new Error(`${label} failed (HTTP ${response?.status || "unknown"}${code ? `, ${code}` : ""})`);
  }
  const payload = await response.json();
  if (!payload || typeof payload !== "object") throw new Error(`${label} returned invalid JSON`);
  return payload;
}

async function readAuthorizationCode(inputFn) {
  if (inputFn) return String(await inputFn()).trim();
  const io = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return String(await io.question("Authorization code: ")).trim();
  } finally {
    io.close();
  }
}

function credentialFromTokenPayload(payload, options = {}) {
  const accessToken = String(payload.access_token || "").trim();
  const refreshToken = String(payload.refresh_token || options.refreshToken || "").trim();
  if (!accessToken) throw new Error("OAuth token response is missing access token");
  const ttlSeconds = Number(payload.expires_in || 3600);
  return normalizeCredential({
    accessToken,
    refreshToken,
    expiresAt: nowMs(options) + Math.max(1, ttlSeconds) * 1000,
    tokenType: payload.token_type || "Bearer",
    idToken: payload.id_token,
    source: "oracle",
    ...(options.discovery ? { discovery: options.discovery } : {}),
    ...(payload.scope ? { scope: payload.scope } : {}),
  });
}

async function loginClaude(options) {
  const config = PROVIDERS["anthropic-oauth"];
  const pkce = options.pkce || generatePkce();
  const params = new URLSearchParams({
    code: "true",
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    scope: config.scope,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: pkce.state,
  });
  const authorizeUrl = `${config.authorizeUrl}?${params}`;
  options.output(`Open: ${authorizeUrl}`);
  options.openFn(authorizeUrl);
  const returned = await readAuthorizationCode(options.inputFn);
  const [code, state] = returned.split("#", 2);
  if (!code || !sameState(state, pkce.state)) throw new Error("Claude OAuth state mismatch");
  const response = await options.fetchFn(config.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "axios/1.7.9",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      state,
      redirect_uri: config.redirectUri,
      code_verifier: pkce.verifier,
    }),
  });
  return credentialFromTokenPayload(await responseJson(response, "Claude OAuth token exchange"), options);
}

async function loginCodex(options) {
  const config = PROVIDERS["openai-codex"];
  const device = await responseJson(await options.fetchFn(`${config.issuer}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: config.clientId }),
  }), "Codex device authorization");
  if (!device.user_code || !device.device_auth_id) throw new Error("Codex device authorization returned incomplete data");
  const verifyUrl = `${config.issuer}/codex/device`;
  options.output(`Open: ${verifyUrl}`);
  options.output(`Code: ${device.user_code}`);
  options.openFn(verifyUrl);
  const interval = Math.max(3, Number(device.interval || 5));
  let authorization;
  for (let attempt = 0; attempt < Math.ceil(900 / interval); attempt += 1) {
    await options.sleepFn(interval * 1000);
    const response = await options.fetchFn(`${config.issuer}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
    });
    if (response.ok) {
      authorization = await responseJson(response, "Codex device authorization");
      break;
    }
    if (![403, 404].includes(response.status)) throw new Error(`Codex device authorization failed (HTTP ${response.status})`);
  }
  if (!authorization) throw new Error("Codex device authorization timed out");
  const response = await options.fetchFn(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({
      grant_type: "authorization_code",
      code: authorization.authorization_code,
      redirect_uri: `${config.issuer}/deviceauth/callback`,
      client_id: config.clientId,
      code_verifier: authorization.code_verifier,
    }),
  });
  return credentialFromTokenPayload(await responseJson(response, "Codex OAuth token exchange"), options);
}

function validateXaiUrl(value) {
  const url = new URL(String(value));
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
    throw new Error("xAI OAuth discovery returned an untrusted endpoint");
  }
  return url.toString();
}

async function loginGrok(options) {
  const config = PROVIDERS["xai-oauth"];
  const discovery = await responseJson(await options.fetchFn(config.discoveryUrl, {
    headers: { accept: "application/json" },
  }), "xAI OAuth discovery");
  validateXaiUrl(discovery.authorization_endpoint);
  const tokenEndpoint = validateXaiUrl(discovery.token_endpoint);
  const device = await responseJson(await options.fetchFn(config.deviceUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: formBody({ client_id: config.clientId, scope: config.scope }),
  }), "xAI device authorization");
  if (!device.device_code || !device.user_code || !device.verification_uri) {
    throw new Error("xAI device authorization returned incomplete data");
  }
  const verifyUrl = validateXaiUrl(device.verification_uri_complete || device.verification_uri);
  options.output(`Open: ${verifyUrl}`);
  options.output(`Code: ${device.user_code}`);
  options.openFn(verifyUrl);
  const interval = Math.max(1, Number(device.interval || 5));
  const attempts = Math.ceil(Math.max(1, Number(device.expires_in || 600)) / interval);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await options.fetchFn(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: formBody({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: config.clientId,
        device_code: device.device_code,
      }),
    });
    if (response.ok) {
      const payload = await responseJson(response, "xAI OAuth token exchange");
      return credentialFromTokenPayload(payload, {
        ...options,
        discovery: {
          authorization_endpoint: validateXaiUrl(discovery.authorization_endpoint),
          token_endpoint: tokenEndpoint,
        },
      });
    }
    let code = "";
    try {
      code = String((await response.json())?.error || "");
    } catch {}
    if (code === "slow_down") await options.sleepFn((interval + 1) * 1000);
    else if (code === "authorization_pending") await options.sleepFn(interval * 1000);
    else throw new Error(`xAI OAuth token exchange failed (HTTP ${response.status}${code ? `, ${code}` : ""})`);
  }
  throw new Error("xAI device authorization timed out");
}

export async function loginOAuth(providerValue, options = {}) {
  const provider = oauthProviderId(providerValue);
  const normalized = {
    fetchFn: options.fetchFn || globalThis.fetch,
    inputFn: options.inputFn,
    sleepFn: options.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    openFn: options.openFn || openBrowser,
    output: options.output || ((line) => process.stdout.write(`${line}\n`)),
    now: options.now,
    pkce: options.pkce,
  };
  if (provider === "anthropic-oauth") return loginClaude(normalized);
  if (provider === "openai-codex") return loginCodex(normalized);
  return loginGrok(normalized);
}

export async function refreshOAuthCredentials(providerValue, credential, options = {}) {
  const provider = oauthProviderId(providerValue);
  const config = PROVIDERS[provider];
  const current = normalizeCredential(credential);
  if (!current.refreshToken) throw new Error(`${provider} OAuth credential cannot refresh; run oracle auth login`);
  let discovery = current.discovery;
  let endpoint;
  const fetchFn = options.fetchFn || globalThis.fetch;
  if (provider === "xai-oauth") {
    if (!discovery?.token_endpoint) {
      const discoveryResponse = await fetchFn(config.discoveryUrl);
      const discovered = await responseJson(discoveryResponse, "xAI OAuth discovery");
      discovery = {
        ...(discovered.authorization_endpoint
          ? { authorization_endpoint: validateXaiUrl(discovered.authorization_endpoint) }
          : {}),
        token_endpoint: validateXaiUrl(discovered.token_endpoint),
      };
    }
    endpoint = validateXaiUrl(discovery.token_endpoint);
  } else {
    endpoint = config.tokenUrl;
  }
  const response = await fetchFn(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      ...(provider === "anthropic-oauth" ? { "user-agent": "axios/1.7.9" } : {}),
    },
    body: formBody({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: config.clientId,
    }),
  });
  const payload = await responseJson(response, `${provider} OAuth refresh`);
  return credentialFromTokenPayload(payload, {
    ...options,
    refreshToken: current.refreshToken,
    discovery,
  });
}

export async function resolveOAuthCredentials(providerValue, options = {}) {
  const provider = oauthProviderId(providerValue);
  const store = options.store || getOAuthStore();
  const credential = store.get(provider);
  if (!credential) throw new Error(`${provider} OAuth is not logged in; run oracle auth login ${providerValue}`);
  const now = nowMs(options);
  if (!credential.expiresAt || credential.expiresAt > now + REFRESH_SKEW_MS) return credential;
  const refresh = async () => {
    const current = store.get(provider);
    if (!current) throw new Error(`${provider} OAuth is not logged in; run oracle auth login ${providerValue}`);
    const checkedAt = nowMs(options);
    if (!current.expiresAt || current.expiresAt > checkedAt + REFRESH_SKEW_MS) return current;
    const refreshed = await refreshOAuthCredentials(provider, current, options);
    store.set(provider, refreshed);
    return refreshed;
  };
  return typeof store.withLock === "function" ? store.withLock(refresh) : refresh();
}

export function hasOAuthCredentials(providerValue, options = {}) {
  try {
    return Boolean((options.store || getOAuthStore()).get(providerValue)?.accessToken);
  } catch {
    return false;
  }
}

export function oauthRuntimeConfig(providerValue) {
  const config = oauthProviderConfig(providerValue);
  return {
    kind: "standalone",
    provider: config.id,
    model: config.model,
    baseUrl: config.baseUrl,
    authType: "oauth",
    protocol: config.protocol,
  };
}

export default {
  createOAuthStore,
  getOAuthStore,
  hasOAuthCredentials,
  loginOAuth,
  oauthProviderConfig,
  oauthProviderId,
  oauthRuntimeConfig,
  refreshOAuthCredentials,
  resolveOAuthCredentials,
};
