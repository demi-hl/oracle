#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const INJECTION_RULES = [
  ["instruction-override", /\b(?:ignore|disregard|override)\b.{0,48}\b(?:previous|prior|system|developer|instructions?)\b/i],
  ["secret-exfiltration", /\b(?:reveal|print|return|exfiltrate|send)\b.{0,48}\b(?:private\s*key|seed\s*phrase|mnemonic|secret|credentials?|system\s*prompt)\b/i],
  ["transaction-coercion", /\b(?:sign|send|broadcast|execute)\b.{0,32}\b(?:transaction|transfer|approval|trade)\b/i],
  ["tool-coercion", /\b(?:call|invoke|use|run)\b.{0,24}\b(?:tool|function|shell|command)\b/i],
];

const FORBIDDEN_EXPORT = /^(?:signer|sign|signMessage|signTransaction|sendTransaction|broadcastTransaction|submitTransaction|executeTransaction|privateKey|secretKey|mnemonic|seedPhrase|wallet)$/i;

function finding(code, path, message) {
  return { code, path, message };
}

function scanStrings(value, path, findings, seen) {
  if (typeof value === "string") {
    for (const [rule, pattern] of INJECTION_RULES) {
      if (pattern.test(value)) {
        findings.push(finding("prompt-injection", path, `metadata matches ${rule}`));
        break;
      }
    }
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanStrings(item, `${path}[${index}]`, findings, seen));
    return;
  }
  for (const key of Object.keys(value).sort()) {
    scanStrings(value[key], path ? `${path}.${key}` : key, findings, seen);
  }
}

/** Validate one loaded Oracle protocol pack without calling provider code. */
export function benchmarkPack(moduleValue, { name = "pack" } = {}) {
  const namespace = moduleValue && typeof moduleValue === "object" ? moduleValue : {};
  const pack = namespace.default && typeof namespace.default === "object" ? namespace.default : namespace;
  const findings = [];

  for (const key of Object.keys(namespace).sort()) {
    if (key !== "default" && FORBIDDEN_EXPORT.test(key)) {
      findings.push(finding("forbidden-signer-export", `exports.${key}`, `pack exports custody capability ${key}`));
    }
  }
  for (const key of Object.keys(pack).sort()) {
    if (FORBIDDEN_EXPORT.test(key)) {
      findings.push(finding("forbidden-signer-export", `pack.${key}`, `pack exports custody capability ${key}`));
    }
  }

  if (!pack.provider || typeof pack.provider !== "object") {
    findings.push(finding("missing-provider", "pack.provider", "provider metadata is required"));
  }
  if (typeof pack.prepare !== "function") {
    findings.push(finding("missing-prepare", "pack.prepare", "prepare must be a function"));
  }
  if (typeof pack.decode !== "function") {
    findings.push(finding("missing-decoder", "pack.decode", "decode must be a function"));
  }
  if (!(Array.isArray(pack.riskRules) || typeof pack.riskRules === "function")) {
    findings.push(finding("missing-risk-rules", "pack.riskRules", "riskRules must be an array or function"));
  }
  if (!pack.tests || typeof pack.tests !== "object" || Array.isArray(pack.tests) || Object.keys(pack.tests).length === 0) {
    findings.push(finding("missing-tests", "pack.tests", "non-empty tests metadata is required"));
  }

  // Metadata is untrusted even when nested below token/NFT records. Scan data only;
  // functions are deliberately never invoked by this local harness.
  scanStrings(pack.metadata, "pack.metadata", findings, new Set());
  scanStrings(pack.provider, "pack.provider", findings, new Set());

  findings.sort((a, b) => `${a.code}\0${a.path}\0${a.message}`.localeCompare(`${b.code}\0${b.path}\0${b.message}`));
  return { name, ok: findings.length === 0, findings };
}

/** Run a stable summary over already-loaded fixture/module records. */
export function runAdversarialBenchmark(entries) {
  const results = entries
    .map((entry, index) => benchmarkPack(entry.module ?? entry, { name: entry.name ?? `pack-${index + 1}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    ok: results.every((result) => result.ok),
    packs: results.length,
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    findings: results.reduce((count, result) => count + result.findings.length, 0),
    results,
  };
}

async function main(paths) {
  if (paths.length === 0) throw new Error("usage: node scripts/adversarial-bench.mjs <pack.mjs> [...]");
  const entries = [];
  for (const input of paths) {
    const absolute = resolve(input);
    entries.push({ name: input, module: await import(pathToFileURL(absolute).href) });
  }
  const summary = runAdversarialBenchmark(entries);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error.message || error) }, null, 2)}\n`);
    process.exitCode = 2;
  });
}
