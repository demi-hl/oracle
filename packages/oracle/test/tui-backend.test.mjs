import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveChatBackend,
  standaloneConfigFromEnv,
} from "../src/tui/backend.mjs";

test("standaloneConfigFromEnv resolves OpenRouter without Hermes", () => {
  const config = standaloneConfigFromEnv({
    OPENROUTER_API_KEY: "test-openrouter-key",
    ORACLE_MODEL: "openrouter/auto",
  });

  assert.deepEqual(config, {
    kind: "standalone",
    provider: "openrouter",
    model: "openrouter/auto",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "test-openrouter-key",
    contextLength: 128000,
    reasoningEffort: "high",
  });
});

test("auto backend prefers Oracle-native standalone when provider auth exists", () => {
  const backend = resolveChatBackend({
    env: {
      OPENROUTER_API_KEY: "test-openrouter-key",
      ORACLE_MODEL: "openrouter/auto",
    },
    hermes: { ok: true, bin: "/usr/bin/hermes" },
  });

  assert.equal(backend.kind, "standalone");
  assert.equal(backend.config.provider, "openrouter");
  assert.equal(backend.config.baseUrl, "https://openrouter.ai/api/v1");
});

test("auto backend reuses Hermes when standalone is not configured", () => {
  const backend = resolveChatBackend({
    env: {},
    hermes: { ok: true, bin: "/usr/bin/hermes" },
  });

  assert.deepEqual(backend, {
    kind: "hermes",
    bin: "/usr/bin/hermes",
  });
});

test("fresh machine without Hermes returns an actionable standalone setup error", () => {
  const backend = resolveChatBackend({
    env: {},
    hermes: { ok: false, reason: "not installed" },
  });

  assert.equal(backend.kind, "unconfigured");
  assert.match(backend.reason, /no Hermes or external agent required/i);
  assert.match(backend.reason, /OPENROUTER_API_KEY/);
});

test("stored OAuth provider config selects standalone without an API key", () => {
  const backend = resolveChatBackend({
    env: {},
    hermes: { ok: false },
    storedConfig: {
      backend: "standalone",
      provider: "openai-codex",
      model: "gpt-5.4",
    },
    oauthAvailable: (provider) => provider === "openai-codex",
  });
  assert.equal(backend.kind, "standalone");
  assert.equal(backend.config.authType, "oauth");
  assert.equal(backend.config.provider, "openai-codex");
});

test("OAuth providers ignore custom and stale base URLs", () => {
  const cases = [
    ["anthropic-oauth", "https://api.anthropic.com/v1"],
    ["openai-codex", "https://chatgpt.com/backend-api/codex"],
    ["xai-oauth", "https://api.x.ai/v1"],
  ];
  for (const [provider, expected] of cases) {
    const config = standaloneConfigFromEnv(
      { ORACLE_PROVIDER: provider, ORACLE_BASE_URL: "https://attacker.example/v1" },
      { provider, model: "test-model", baseUrl: "https://stale.example/v1" },
      (candidate) => candidate === provider,
    );
    assert.equal(config.baseUrl, expected);
  }
});

test("named API-key providers ignore custom and stale base URLs", () => {
  const config = standaloneConfigFromEnv(
    {
      ORACLE_PROVIDER: "openrouter",
      ORACLE_BASE_URL: "https://attacker.example/v1",
      OPENROUTER_API_KEY: "synthetic-key",
    },
    { provider: "openrouter", model: "openrouter/auto", baseUrl: "https://stale.example/v1" },
  );
  assert.equal(config.baseUrl, "https://openrouter.ai/api/v1");
});

test("stored API key provider config resolves from the secure auth store", () => {
  const backend = resolveChatBackend({
    env: {},
    hermes: { ok: false },
    storedConfig: {
      backend: "standalone",
      provider: "openrouter",
      model: "anthropic/claude-opus-4.8",
    },
    apiKeyResolver: (provider) => provider === "openrouter" ? "stored-api-key" : "",
  });
  assert.equal(backend.kind, "standalone");
  assert.equal(backend.config.apiKey, "stored-api-key");
  assert.equal(backend.config.model, "anthropic/claude-opus-4.8");
});

test("forced backend selection is deterministic", () => {
  const standalone = resolveChatBackend({
    env: {
      ORACLE_CHAT_BACKEND: "standalone",
      OPENAI_API_KEY: "test-openai-key",
      ORACLE_MODEL: "gpt-test",
    },
    hermes: { ok: true, bin: "/usr/bin/hermes" },
  });
  assert.equal(standalone.kind, "standalone");
  assert.equal(standalone.config.provider, "openai");

  const hermes = resolveChatBackend({
    env: { ORACLE_CHAT_BACKEND: "hermes" },
    hermes: { ok: true, bin: "/usr/bin/hermes" },
  });
  assert.equal(hermes.kind, "hermes");
});


test("public desktop mode refuses remote compute even when configured", () => {
  const explicit = resolveChatBackend({
    env: {
      ORACLE_PUBLIC_DESKTOP: "1",
      ORACLE_CHAT_BACKEND: "remote",
      ORACLE_COMPUTE_HOST: "gpu-box",
    },
    hermes: { ok: false },
  });
  assert.equal(explicit.kind, "unconfigured");
  assert.match(explicit.reason, /remote compute backend was requested/i);

  const auto = resolveChatBackend({
    env: {
      ORACLE_PUBLIC_DESKTOP: "1",
      ORACLE_COMPUTE_HOST: "gpu-box",
      OPENROUTER_API_KEY: "test-openrouter-key",
    },
    hermes: { ok: false },
  });
  assert.equal(auto.kind, "standalone");
  assert.equal(auto.config.provider, "openrouter");
});
