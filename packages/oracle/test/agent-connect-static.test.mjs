import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const paths = ["index.html", "app.js", "styles.css"].map((file) => path.join(root, "public/agent-connect", file));
const read = (file) => readFileSync(file, "utf8");
const PACKAGE = "@oracle-agent/oracle";
const CANONICAL_ARGS = `["-y", "--package", "${PACKAGE}", "oracle-data-mcp"]`;
const INIT_COMMAND = `npx -y --package ${PACKAGE} oracle-init`;

test("agent connect ships as three static package assets", () => {
  paths.forEach((file) => assert.equal(existsSync(file), true, `${file} must exist`));
});

test("page supports every requested harness", () => {
  const source = paths.map(read).join("\n");
  const js = read(paths[1]);
  for (const name of ["Hermes", "Claude Code", "Codex", "Cursor", "Generic MCP"]) {
    assert.ok(source.includes(name), `page must include ${name}`);
  }
  assert.match(js, /const ARGS = \["-y", "--package", PACKAGE, "oracle-data-mcp"\]/);
  assert.equal(js.includes(CANONICAL_ARGS) || /ARGS\.map/.test(js), true);
  for (const harness of ["hermes", "claude", "codex", "cursor", "mcp"]) {
    assert.match(js, new RegExp(`${harness}\\s*:`), `must define ${harness} harness`);
  }
  assert.match(js, /mcpServers/);
  assert.equal(js.includes("@oracle-agent/oracle-data-mcp"), false, "must not reference nonexistent package");
});

test("page collects only the read connection fields", () => {
  const html = read(paths[0]);
  const js = read(paths[1]);
  assert.match(html, /Agent API URL/);
  assert.match(html, /Read API key/);
  assert.match(html, /Public wallet address/);
  assert.match(html, /read-only/i);
  assert.match(html, /No wallet connection or signature/);
  assert.match(js, /ORACLE_DATA_URL/);
  assert.match(js, /ORACLE_AGENT_KEY/);
  assert.equal(js.includes("ORACLE_API_URL"), false);
  assert.equal(js.includes("ORACLE_READ_API_KEY"), false);
});

test("static assets contain no forbidden custody credential prompts", () => {
  const source = paths.map(read).join("\n");
  const forbidden = ["private" + "Key", "mnemo" + "nic", "seed" + " phrase", "personal_sign", "eth_sign"];
  for (const term of forbidden) assert.equal(source.toLowerCase().includes(term.toLowerCase()), false, `must not contain ${term}`);
  assert.equal(/chatgpt/i.test(source), false);
  assert.equal(/\bsigning\b/i.test(source), false);
  assert.equal(/\b(?:sse|streamableHttp|streamable-http)\b/i.test(source), false);
  assert.equal(/\burl\s*:\s*["']https?:\/\//i.test(source), false);
});

test("page has no external scripts or network requests", () => {
  const html = read(paths[0]);
  const js = read(paths[1]);
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((match) => match[1]);
  assert.deepEqual(scripts, ["app.js"]);
  assert.equal(/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/.test(js), false);
  assert.equal(/<script\b[^>]*\bsrc=["'](?:https?:)?\/\//i.test(html), false);
});

test("copy explains the split between read MCP and local custody", () => {
  const html = read(paths[0]);
  const js = read(paths[1]);
  assert.match(html, /cloud\/read MCP/i);
  assert.match(html, /Custody stays local/);
  assert.match(html, /model proposes; the owner authorizes/i);
  assert.match(html, /separate local process/i);
  assert.ok(js.includes(INIT_COMMAND), `must copy ${INIT_COMMAND}`);
  assert.equal(js.includes("npx @oracle-agent/oracle init"), false);
  assert.equal(/\bnpx\s+@oracle-agent\/oracle\s+init\b/.test(js), false);
});

test("document references only package-relative style and script assets", () => {
  const html = read(paths[0]);
  assert.match(html, /href="styles\.css"/);
  assert.match(html, /src="app\.js"/);
  assert.equal(/<(?:script|link)\b[^>]+(?:src|href)=["']https?:/i.test(html), false);
});