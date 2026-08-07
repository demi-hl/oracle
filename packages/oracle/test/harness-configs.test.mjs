import test from "node:test";
import assert from "node:assert/strict";
import { emitHarnessConfigs } from "../src/onboarding/harness-configs.mjs";

const INPUT = { url: "https://data.oracle.example/mcp", key: "mad_agent_test_key", label: "oracle" };

test("emits the exact supported harness set deterministically", () => {
  const first = emitHarnessConfigs(INPUT);
  const second = emitHarnessConfigs({ ...INPUT });
  assert.deepEqual(Object.keys(first), ["hermes", "claudeCode", "codex", "cursor", "genericMcp"]);
  assert.deepEqual(first, second);
});

test("JSON harnesses spawn the public binary with only the intended environment", () => {
  const configs = emitHarnessConfigs(INPUT);
  for (const harness of ["claudeCode", "cursor", "genericMcp"]) {
    const parsed = JSON.parse(configs[harness]);
    assert.deepEqual(parsed, {
      mcpServers: {
        oracle: {
          command: "npx",
          args: ["-y", "--package", "@oracle-agent/oracle", "oracle-data-mcp"],
          env: { ORACLE_DATA_URL: "https://data.oracle.example/mcp", ORACLE_AGENT_KEY: "mad_agent_test_key" },
        },
      },
    });
  }
});

test("all snippets are portable and contain the required spawn settings", () => {
  const configs = emitHarnessConfigs(INPUT);
  for (const snippet of Object.values(configs)) {
    assert.match(snippet, /oracle-data-mcp/);
    assert.match(snippet, /ORACLE_DATA_URL/);
    assert.match(snippet, /ORACLE_AGENT_KEY/);
    assert.doesNotMatch(snippet, /(?:\/home\/|\/Users\/|[A-Z]:\\\\|fleet-work|bin\/oracle-data-mcp\.mjs)/);
  }
});

test("validates URLs and rejects secret-shaped names and values", () => {
  for (const url of ["not a url", "file:///tmp/socket", "https://user:pass@example.com", "https://example.com/?api_key=oops"]) {
    assert.throws(() => emitHarnessConfigs({ ...INPUT, url }), /url/);
  }
  assert.throws(() => emitHarnessConfigs({ ...INPUT, label: "PRIVATE_KEY" }), /secret-shaped/);
  assert.throws(() => emitHarnessConfigs({ ...INPUT, key: `PRIVATE_KEY=${"a".repeat(64)}` }), /private key/);
  assert.throws(() => emitHarnessConfigs({ ...INPUT, key: `0x${"a".repeat(64)}` }), /signing material/);
});
