#!/usr/bin/env node
// Pre-publication secret scan. Fails CLOSED: any hit is an error.
//
// Checks the working tree and every blob reachable from HEAD. Set
// ORACLE_SCAN_ALL_REFS=1 for an explicit audit of every fetched ref.

import { execFileSync } from "node:child_process";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8" }).trim();

// Live values that must never appear. Sourced from the environment at scan
// time so the scanner itself contains no secrets.
function liveSecrets() {
  const out = [];
  const push = (label, value) => {
    const v = String(value || "").trim();
    if (v.length >= 8) out.push({ label, value: v });
  };
  for (const k of Object.keys(process.env)) {
    if (/(_KEY|_SECRET|_TOKEN|_PASSPHRASE|_WIF|PRIVATE_KEY)$/i.test(k)) {
      push(`env:${k}`, process.env[k]);
    }
  }
  return out;
}

function isBip39Mnemonic(match) {
  const words = match[0].trim().toLowerCase().split(/\s+/);
  if (words.length !== 12 && words.length !== 24) return false;
  return validateMnemonic(words.join(" "), wordlist);
}

const PATTERNS = [
  { name: "private key (hex 64)", re: /\b(?:0x)?[0-9a-fA-F]{64}\b/, refine: (m, line) =>
      /priv|secret|wif|seed|mnemonic|signer|wallet/i.test(line) && !/hash|digest|sha256|txid|commit|blob|sha1|0x0{40,}/i.test(line) },
  { name: "BTC WIF", re: /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/ },
  { name: "BIP39 seed phrase", re: /\b(?:[a-z]{3,8} ){11}(?:[a-z]{3,8})\b|\b(?:[a-z]{3,8} ){23}(?:[a-z]{3,8})\b/i, refine: isBip39Mnemonic },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "OpenAI key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Telegram bot token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { name: "PEM private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "Solana keypair array", re: /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/ },
];

// Paths whose matches are known-safe test fixtures.
const ALLOWED_PATHS = [
  /^scripts\/secret-scan\.mjs$/,
  /^package-lock\.json$/,
];

// Literal strings that are documented, synthetic, or public by nature.
const ALLOWED_VALUES = [
  "0x0123456789012345678901234567890123456789012345678901234567890123", // HL SDK public test vector
  "L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ",
  "/-----BEGIN[A-Z ]*PRIVATE KEY-----/",
  '{ value: "-----BEGIN EC PRIVATE KEY-----" }',
  "0x0000000000000000000000000000000000000000",
];

const PUBLIC_EMAIL_RE = /^(?:[0-9]+\+)?[a-z0-9_.-]+\[?bot\]?@users\.noreply\.github\.com$|^oracle@users\.noreply\.github\.com$|^noreply@github\.com$/i;
const PRIVATE_EMAIL_RE = /@(gmail|icloud|me|yahoo|outlook|hotmail|protonmail)\.com$|@(local|gmk)$|^fleet@|^agent@/i;
const HISTORY_SCOPE = process.env.ORACLE_SCAN_ALL_REFS === "1" ? "--all" : "HEAD";

function sh(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function redactSample(kind) {
  return kind.startsWith("LIVE SECRET") ? "[REDACTED — real credential]" : "[REDACTED]";
}

function scanText(text, origin, findings) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 4000) continue;
    for (const p of PATTERNS) {
      const m = p.re.exec(line);
      if (!m) continue;
      if (ALLOWED_VALUES.some((v) => line.includes(v))) continue;
      if (p.refine && !p.refine(m, line)) continue;
      findings.push({ origin, line: i + 1, kind: p.name, sample: redactSample(p.name) });
    }
    for (const s of LIVE) {
      if (line.includes(s.value)) {
        findings.push({ origin, line: i + 1, kind: `LIVE SECRET ${s.label}`, sample: redactSample("LIVE SECRET") });
      }
    }
  }
}

function parseEmail(identity) {
  const match = /<([^<>\s]+)>$/.exec(identity.trim());
  return match ? match[1].toLowerCase() : "";
}

function scanIdentities(findings) {
  const identities = new Set(sh("git", ["log", HISTORY_SCOPE, "--format=%an <%ae>|%cn <%ce>"]).split(/[\n|]/).filter(Boolean));
  for (const identity of identities) {
    const email = parseEmail(identity);
    if (!email) continue;
    if (PRIVATE_EMAIL_RE.test(email) || !PUBLIC_EMAIL_RE.test(email)) {
      findings.push({ origin: "git-history", line: 0, kind: "non-public git identity", sample: "[REDACTED]" });
    }
  }
  return identities;
}

const LIVE = liveSecrets();
const findings = [];

// --- 1. working tree (tracked files only) ---
const tracked = sh("git", ["ls-files"]).split("\n").filter(Boolean);
for (const rel of tracked) {
  if (ALLOWED_PATHS.some((r) => r.test(rel))) continue;
  let content;
  try {
    content = sh("git", ["show", `:${rel}`]);
  } catch {
    continue; // binary or unreadable
  }
  if (content.includes("\u0000")) continue;
  scanText(content, rel, findings);
}

// --- 2. every blob in history ---
const revs = sh("git", ["rev-list", HISTORY_SCOPE]).split("\n").filter(Boolean);
const seen = new Set();
let historyBlobs = 0;
for (const rev of revs) {
  const entries = sh("git", ["ls-tree", "-r", rev]).split("\n").filter(Boolean);
  for (const entry of entries) {
    const [meta, path] = entry.split("\t");
    const sha = meta.split(/\s+/)[2];
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);
    if (ALLOWED_PATHS.some((r) => r.test(path))) continue;
    let content;
    try {
      content = sh("git", ["cat-file", "-p", sha]);
    } catch {
      continue;
    }
    if (content.includes("\u0000")) continue;
    historyBlobs++;
    scanText(content, `history:${rev.slice(0, 8)}:${path}`, findings);
  }
}

// --- 3. author identity leakage ---
const identities = scanIdentities(findings);

console.log(`scanned ${tracked.length} tracked files, ${historyBlobs} historical blobs, ${revs.length} commits`);
console.log(`live env secrets checked: ${LIVE.length}`);
console.log(`git identities checked: ${identities.size}`);

if (findings.length) {
  console.error(`\nFAIL — ${findings.length} finding(s):`);
  for (const f of findings.slice(0, 40)) {
    console.error(`  ${f.origin}:${f.line}  [${f.kind}]  ${f.sample}`);
  }
  process.exit(1);
}
console.log("\nPASS — no secrets found in tree or history");
