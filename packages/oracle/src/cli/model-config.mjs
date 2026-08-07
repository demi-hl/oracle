import fs from "node:fs";
import path from "node:path";

import { ensureDir, oracleConfigDir } from "./paths.mjs";

const BACKENDS = new Set(["auto", "standalone", "hermes", "remote", "arch"]);
const PROVIDERS = new Set([
  "openrouter", "openai", "xai", "deepseek", "gemini", "custom",
  "anthropic-oauth", "openai-codex", "xai-oauth",
]);

export function modelConfigPath() {
  return path.join(oracleConfigDir(), "model.json");
}

function optionalString(value) {
  const text = String(value || "").trim();
  return text || undefined;
}

function normalize(config = {}) {
  const backend = optionalString(config.backend)?.toLowerCase() || "auto";
  const provider = optionalString(config.provider)?.toLowerCase();
  const model = optionalString(config.model);
  const baseUrl = optionalString(config.baseUrl)?.replace(/\/+$/, "");
  const apiKeyEnv = optionalString(config.apiKeyEnv);
  const contextLength = Number.parseInt(String(config.contextLength || ""), 10);
  const reasoningEffort = optionalString(config.reasoningEffort);
  const computeHost = optionalString(config.computeHost || config.remoteHost);
  const computeUser = optionalString(config.computeUser || config.remoteUser);
  const computePath = optionalString(config.computePath || config.remotePath);

  if (!BACKENDS.has(backend)) throw new Error(`unsupported backend: ${backend}`);
  if (process.env.ORACLE_PUBLIC_DESKTOP === "1" && ["remote", "arch"].includes(backend)) throw new Error("remote compute backends are disabled in the public desktop");
  if (provider && !PROVIDERS.has(provider)) throw new Error(`unsupported provider: ${provider}`);
  if (baseUrl && provider !== "custom") throw new Error("baseUrl is only supported for the custom provider");
  if (apiKeyEnv && !/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv)) throw new Error("api key env must be an uppercase environment variable name");
  if (provider === "custom" && !baseUrl) throw new Error("custom provider requires baseUrl");
  if (backend === "standalone" && !model) throw new Error("standalone backend requires a model");
  if (backend === "remote" && !computeHost) throw new Error("remote backend requires computeHost");

  return {
    backend,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(Number.isFinite(contextLength) && contextLength > 0 ? { contextLength } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(computeHost ? { computeHost } : {}),
    ...(computeUser ? { computeUser } : {}),
    ...(computePath ? { computePath } : {}),
  };
}

export function readModelConfig() {
  const file = modelConfigPath();
  if (!fs.existsSync(file)) return null;
  try {
    return normalize(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export function writeModelConfig(config) {
  const normalized = normalize(config);
  const file = modelConfigPath();
  ensureDir(path.dirname(file));
  if (process.platform !== "win32") fs.chmodSync(path.dirname(file), 0o700);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  return normalized;
}

export default { modelConfigPath, readModelConfig, writeModelConfig };
