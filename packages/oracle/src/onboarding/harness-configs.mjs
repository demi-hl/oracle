const PACKAGE = "@oracle-agent/oracle";
const COMMAND = "npx";
const ARGS = ["-y", "--package", PACKAGE, "oracle-data-mcp"];
const FORBIDDEN_NAME = /(?:^|_)(?:PRIVATE_KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|MNEMONIC|SEED)(?:_|$)/i;

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  if (/\r|\n|\0/.test(value)) throw new TypeError(`${name} must be a single-line string`);
  return value.trim();
}

function validateUrl(value) {
  const text = requiredText(value, "url");
  let parsed;
  try { parsed = new URL(text); } catch { throw new TypeError("url must be a valid http(s) URL"); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new TypeError("url must be a credential-free http(s) URL");
  }
  for (const name of parsed.searchParams.keys()) {
    if (FORBIDDEN_NAME.test(name) || /^(?:key|api[_-]?key|auth)$/i.test(name)) {
      throw new TypeError(`url must not contain secret-shaped query parameter: ${name}`);
    }
  }
  return parsed.href;
}

function validateKey(value) {
  const text = requiredText(value, "key");
  if (/^[A-Z][A-Z0-9_]*\s*=/.test(text) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
    throw new TypeError("key must be an Oracle agent key, not an environment assignment or private key");
  }
  if (/^(?:0x)?[0-9a-f]{64}$/i.test(text) || text.trim().split(/\s+/).length >= 12) {
    throw new TypeError("key looks like private signing material");
  }
  return text;
}

function validateLabel(value) {
  const label = requiredText(value, "label");
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(label)) {
    throw new TypeError("label must contain only letters, digits, underscores, and hyphens");
  }
  if (FORBIDDEN_NAME.test(label)) throw new TypeError("label must not be a secret-shaped environment name");
  return label;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function yamlString(value) {
  return JSON.stringify(value);
}

function tomlString(value) {
  return JSON.stringify(value);
}

/**
 * Return deterministic, copy-pasteable MCP configuration snippets.
 * This function performs no I/O and never reads from process.env.
 */
export function emitHarnessConfigs({ url, key, label = "oracle-data" } = {}) {
  const endpoint = validateUrl(url);
  const agentKey = validateKey(key);
  const name = validateLabel(label);
  const server = {
    command: COMMAND,
    args: [...ARGS],
    env: { ORACLE_DATA_URL: endpoint, ORACLE_AGENT_KEY: agentKey },
  };
  const mcp = { mcpServers: { [name]: server } };

  return {
    hermes: [
      "mcp_servers:",
      `  ${name}:`,
      `    command: ${yamlString(COMMAND)}`,
      "    args:",
      ...ARGS.map((arg) => `      - ${yamlString(arg)}`),
      "    env:",
      `      ORACLE_DATA_URL: ${yamlString(endpoint)}`,
      `      ORACLE_AGENT_KEY: ${yamlString(agentKey)}`,
      "",
    ].join("\n"),
    claudeCode: json(mcp),
    codex: [
      `[mcp_servers.${tomlString(name)}]`,
      `command = ${tomlString(COMMAND)}`,
      `args = [${ARGS.map(tomlString).join(", ")}]`,
      "",
      `[mcp_servers.${tomlString(name)}.env]`,
      `ORACLE_DATA_URL = ${tomlString(endpoint)}`,
      `ORACLE_AGENT_KEY = ${tomlString(agentKey)}`,
      "",
    ].join("\n"),
    cursor: json(mcp),
    genericMcp: json(mcp),
  };
}

export const createHarnessConfigs = emitHarnessConfigs;
