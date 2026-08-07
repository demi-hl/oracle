import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createOAuthStore,
  loginOAuth,
  oauthProviderId,
  oauthRuntimeConfig,
  refreshOAuthCredentials,
  resolveOAuthCredentials,
} from "../src/auth/oauth.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-oauth-test-"));
  const file = path.join(root, "oauth.json");
  return {
    root,
    file,
    store: createOAuthStore({ file, keychain: false }),
  };
}

test("OAuth store falls back to a private atomic file and status never exposes tokens", () => {
  const { root, file, store } = tempStore();
  try {
    store.set("anthropic-oauth", {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: 4_000_000_000_000,
      source: "oracle",
    });
    assert.equal(store.get("anthropic-oauth").refreshToken, "synthetic-refresh");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const status = store.status();
    assert.deepEqual(status.providers["anthropic-oauth"], {
      loggedIn: true,
      expiresAt: 4_000_000_000_000,
      source: "oracle",
      storage: "private-file",
    });
    assert.doesNotMatch(JSON.stringify(status), /synthetic-access|synthetic-refresh/);

    store.setApiKey("openrouter", "synthetic-api-key");
    assert.equal(store.getApiKey("openrouter"), "synthetic-api-key");
    const apiStatus = store.status();
    assert.deepEqual(apiStatus.apiKeys.openrouter, {
      configured: true,
      storage: "private-file",
    });
    assert.doesNotMatch(JSON.stringify(apiStatus), /synthetic-api-key/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt private credential store fails closed without overwriting it", () => {
  const { root, file, store } = tempStore();
  try {
    fs.writeFileSync(file, "{corrupt", { mode: 0o600 });
    assert.throws(() => store.setApiKey("openrouter", "synthetic-api-key"), /corrupt/);
    assert.equal(fs.readFileSync(file, "utf8"), "{corrupt");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("OAuth runtime defaults target the current provider models", () => {
  assert.equal(oauthRuntimeConfig("claude").model, "claude-sonnet-4-6");
  assert.equal(oauthRuntimeConfig("codex").model, "gpt-5.6-sol");
  assert.equal(oauthRuntimeConfig("grok").model, "grok-4.5");
});

test("OAuth provider aliases are stable", () => {
  assert.equal(oauthProviderId("claude"), "anthropic-oauth");
  assert.equal(oauthProviderId("codex"), "openai-codex");
  assert.equal(oauthProviderId("grok"), "xai-oauth");
  assert.throws(() => oauthProviderId("unknown"), /unsupported OAuth provider/);
});

test("Claude OAuth uses PKCE and validates returned state", async () => {
  const calls = [];
  const result = await loginOAuth("claude", {
    fetchFn: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return jsonResponse({
        access_token: "claude-access",
        refresh_token: "claude-refresh",
        expires_in: 3600,
      });
    },
    inputFn: async () => "authorization-code#fixed-state",
    openFn: () => true,
    output: () => {},
    pkce: {
      verifier: "fixed-verifier",
      challenge: "fixed-challenge",
      state: "fixed-state",
    },
    now: () => 1_000,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://platform.claude.com/v1/oauth/token");
  assert.equal(calls[0].body.code_verifier, "fixed-verifier");
  assert.equal(calls[0].body.state, "fixed-state");
  assert.equal(result.accessToken, "claude-access");
  assert.equal(result.expiresAt, 3_601_000);
});

test("Codex OAuth completes the OpenAI device flow", async () => {
  const calls = [];
  const responses = [
    jsonResponse({ user_code: "ABCD-EFGH", device_auth_id: "device-id", interval: 0 }),
    jsonResponse({ authorization_code: "authorization-code", code_verifier: "device-verifier" }),
    jsonResponse({ access_token: "codex-access", refresh_token: "codex-refresh", expires_in: 7200 }),
  ];
  const result = await loginOAuth("codex", {
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
    sleepFn: async () => {},
    openFn: () => true,
    output: () => {},
    now: () => 2_000,
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "https://auth.openai.com/api/accounts/deviceauth/usercode",
    "https://auth.openai.com/api/accounts/deviceauth/token",
    "https://auth.openai.com/oauth/token",
  ]);
  assert.equal(result.accessToken, "codex-access");
  assert.equal(result.refreshToken, "codex-refresh");
  assert.equal(result.expiresAt, 7_202_000);
});

test("Grok OAuth discovers pinned xAI endpoints and completes device flow", async () => {
  const calls = [];
  const responses = [
    jsonResponse({
      authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
      token_endpoint: "https://auth.x.ai/oauth2/token",
    }),
    jsonResponse({
      device_code: "device-code",
      user_code: "GROK-CODE",
      verification_uri: "https://auth.x.ai/device",
      verification_uri_complete: "https://auth.x.ai/device?code=GROK-CODE",
      expires_in: 600,
      interval: 0,
    }),
    jsonResponse({
      access_token: "grok-access",
      refresh_token: "grok-refresh",
      expires_in: 3600,
      token_type: "Bearer",
    }),
  ];
  const result = await loginOAuth("grok", {
    fetchFn: async (url, options = {}) => {
      calls.push({ url, options });
      return responses.shift();
    },
    sleepFn: async () => {},
    openFn: () => true,
    output: () => {},
    now: () => 3_000,
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "https://auth.x.ai/.well-known/openid-configuration",
    "https://auth.x.ai/oauth2/device/code",
    "https://auth.x.ai/oauth2/token",
  ]);
  assert.equal(result.accessToken, "grok-access");
  assert.equal(result.discovery.token_endpoint, "https://auth.x.ai/oauth2/token");
});

test("Grok OAuth refuses an untrusted browser verification URL", async () => {
  const responses = [
    jsonResponse({
      authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
      token_endpoint: "https://auth.x.ai/oauth2/token",
    }),
    jsonResponse({
      device_code: "device-code",
      user_code: "GROK-CODE",
      verification_uri: "https://auth.x.ai/device",
      verification_uri_complete: "file:///tmp/untrusted",
      expires_in: 600,
    }),
  ];
  let opened = false;
  await assert.rejects(
    loginOAuth("grok", {
      fetchFn: async () => responses.shift(),
      sleepFn: async () => {},
      openFn: () => { opened = true; },
      output: () => {},
    }),
    /untrusted endpoint/,
  );
  assert.equal(opened, false);
});

test("refreshOAuthCredentials preserves rotating refresh-token chains", async () => {
  for (const [provider, endpoint] of [
    ["anthropic-oauth", "https://platform.claude.com/v1/oauth/token"],
    ["openai-codex", "https://auth.openai.com/oauth/token"],
    ["xai-oauth", "https://auth.x.ai/oauth2/token"],
  ]) {
    const calls = [];
    const refreshed = await refreshOAuthCredentials(provider, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 1,
      ...(provider === "xai-oauth" ? { discovery: { token_endpoint: endpoint } } : {}),
    }, {
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({
          access_token: `${provider}-access`,
          refresh_token: `${provider}-refresh`,
          expires_in: 1800,
        });
      },
      now: () => 5_000,
    });
    assert.equal(calls[0].url, endpoint);
    assert.equal(refreshed.refreshToken, `${provider}-refresh`);
    assert.equal(refreshed.expiresAt, 1_805_000);
  }
});

test("xAI refresh discovers the token endpoint when legacy credentials omit it", async () => {
  const calls = [];
  const refreshed = await refreshOAuthCredentials("xai-oauth", {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1,
  }, {
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) {
        return jsonResponse({ token_endpoint: "https://auth.x.ai/oauth2/token" });
      }
      return jsonResponse({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 1800,
      });
    },
    now: () => 5_000,
  });
  assert.equal(calls[0].url, "https://auth.x.ai/.well-known/openid-configuration");
  assert.equal(calls[0].options, undefined);
  assert.equal(calls[1].url, "https://auth.x.ai/oauth2/token");
  assert.match(calls[1].options.body, /grant_type=refresh_token/);
  assert.equal(refreshed.discovery.token_endpoint, "https://auth.x.ai/oauth2/token");
});

test("concurrent OAuth resolution refreshes a rotating token once", async () => {
  const { root, store } = tempStore();
  try {
    store.set("openai-codex", {
      accessToken: "expired-access",
      refreshToken: "live-refresh",
      expiresAt: 1,
      source: "oracle",
    });
    let refreshes = 0;
    const resolve = () => resolveOAuthCredentials("codex", {
      store,
      now: () => 10_000,
      fetchFn: async () => {
        refreshes += 1;
        await new Promise((done) => setTimeout(done, 10));
        return jsonResponse({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        });
      },
    });
    const [first, second] = await Promise.all([resolve(), resolve()]);
    assert.equal(refreshes, 1);
    assert.equal(first.accessToken, "fresh-access");
    assert.equal(second.accessToken, "fresh-access");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveOAuthCredentials atomically persists refreshed credentials", async () => {
  const { root, store } = tempStore();
  try {
    store.set("openai-codex", {
      accessToken: "expired-access",
      refreshToken: "live-refresh",
      expiresAt: 1,
      source: "oracle",
    });
    const resolved = await resolveOAuthCredentials("codex", {
      store,
      now: () => 10_000,
      fetchFn: async () => jsonResponse({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 3600,
      }),
    });
    assert.equal(resolved.accessToken, "fresh-access");
    assert.equal(store.get("openai-codex").refreshToken, "fresh-refresh");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
