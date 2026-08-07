#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TARGETS = ["app", "components", "lib", "public", "scripts", "package.json", "next.config.ts"];
const BINARY_EXT = new Set([".avif", ".ico", ".jpg", ".jpeg", ".png", ".svg", ".webm", ".webp", ".woff", ".woff2"]);
const FORBIDDEN = [
  { name: "legacy app brand", pattern: /\b(?:Hermes\s+)?Battlestation\b/gi },
  { name: "private cockpit", pattern: /\b(?:terminal|vault|kanban|fleet|sessions|skills|node-pty|electron|capacitor)\b/gi },
  { name: "local personal path", pattern: /\/home\/demi|~\/\.hermes/gi },
  { name: "credential shape", pattern: /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}/g },
];

function* walk(file) {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(file)) yield* walk(path.join(file, entry));
    return;
  }
  if (stat.size > 5 * 1024 * 1024) return;
  if (BINARY_EXT.has(path.extname(file).toLowerCase())) return;
  yield file;
}

const hits = [];
for (const target of TARGETS) {
  for (const file of walk(path.join(ROOT, target))) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    if (rel === "scripts/check-oracle-brand.cjs") continue;
    const text = fs.readFileSync(file, "utf8");
    for (const rule of FORBIDDEN) {
      rule.pattern.lastIndex = 0;
      for (const match of text.matchAll(rule.pattern)) {
        const line = text.slice(0, match.index).split("\n").length;
        hits.push(`${rel}:${line}: ${rule.name}: ${match[0]}`);
      }
    }
  }
}

if (hits.length) {
  console.error(`Oracle brand guard failed: ${hits.length} hit(s)`);
  for (const hit of hits.slice(0, 80)) console.error(hit);
  process.exit(1);
}
console.log("Oracle brand guard passed");
