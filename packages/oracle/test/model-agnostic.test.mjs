// Oracle is model-agnostic at its package boundary: it ships no provider SDK and
// keeps all direct inference transport inside three audited standalone-runtime
// modules. Hermes remains optional, and custom providers remain configuration.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listSource(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      listSource(abs, out);
    } else if (/\.mjs$/.test(e.name)) {
      out.push(abs);
    }
  }
  return out;
}

const sources = [
  ...listSource(path.join(ROOT, "src")),
  ...listSource(path.join(ROOT, "bin")),
];

test("no LLM SDK is a runtime dependency", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const deps = Object.keys(pkg.dependencies || {});

  const llmish = deps.filter((d) =>
    /(^|\/)(openai|anthropic|@anthropic-ai|@google\/gen|cohere|replicate|langchain|llamaindex|ollama|groq-sdk|mistralai)/i.test(
      d,
    ),
  );

  assert.deepEqual(
    llmish,
    [],
    `Oracle must stay model-agnostic; found inference SDK(s): ${llmish.join(", ")}`,
  );
});

test("inference endpoints are confined to the audited standalone runtime", () => {
  const allowed = new Set([
    "src/auth/oauth.mjs",
    "src/tui/backend.mjs",
    "src/tui/standalone-client.mjs",
  ]);
  const endpoints = [
    /api\.openai\.com/i,
    /api\.anthropic\.com/i,
    /generativelanguage\.googleapis\.com/i,
    /api\.x\.ai/i,
    /api\.groq\.com/i,
    /api\.mistral\.ai/i,
    /openrouter\.ai/i,
    /\/v1\/chat\/completions/i,
  ];

  const outsideBoundary = [];
  const insideBoundary = new Set();
  for (const abs of sources) {
    const relative = path.relative(ROOT, abs);
    const body = fs.readFileSync(abs, "utf8");
    for (const re of endpoints) {
      if (!re.test(body)) continue;
      if (allowed.has(relative)) insideBoundary.add(relative);
      else outsideBoundary.push(`${relative}: ${re}`);
    }
  }

  assert.deepEqual(
    outsideBoundary,
    [],
    `Provider inference endpoints escaped the audited standalone boundary:\n  ${outsideBoundary.join("\n  ")}`,
  );
  assert.ok(insideBoundary.has("src/tui/backend.mjs"));
  assert.ok(insideBoundary.has("src/tui/standalone-client.mjs"));
});

test("no model API key is read from the environment", () => {
  const keyVars =
    /process\.env\.(OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|XAI_API_KEY|GROQ_API_KEY|MISTRAL_API_KEY|OPENROUTER_API_KEY|NOUS_API_KEY)/;

  const hits = sources
    .filter((abs) => keyVars.test(fs.readFileSync(abs, "utf8")))
    .map((abs) => path.relative(ROOT, abs));

  assert.deepEqual(
    hits,
    [],
    `Oracle must not require a model key:\n  ${hits.join("\n  ")}`,
  );
});
