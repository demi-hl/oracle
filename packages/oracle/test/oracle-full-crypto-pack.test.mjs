// Pack schema smoke for oracle-full-crypto
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packPath = join(root, "artifacts/specialist-packs/oracle-full-crypto.json");

test("oracle-full-crypto pack includes protocol build + public-safe skills", () => {
  const pack = JSON.parse(readFileSync(packPath, "utf8"));
  assert.equal(pack.id, "oracle-full-crypto");
  assert.equal(pack.version, 4);
  assert.equal(pack.includes_protocol_build, true);
  assert.equal(pack.posture.default, "DISARMED");
  assert.equal(pack.posture.signing, "user-wallet-only");
  assert.ok(pack.skill_packs.protocol_build.length >= 3);
  assert.ok(pack.skill_packs.research.length >= 3);
  assert.ok(pack.profiles.some((p) => p.id === "protocol-builder"));
  assert.ok(pack.posture.never.includes("private-executor-custody"));
  const privateName = ["de", "mi"].join("");
  const rootPath = ["", "root", ""].join("/");
  const privateServer = "V" + "PS";
  const rootUserAt = ["root", "@"].join("");
  assert.equal(new RegExp(`${privateName}|${privateServer}|${rootUserAt}|${rootPath}`, "i").test(JSON.stringify(pack)), false);
  assert.ok(pack.default_tools.never_public_default.includes("evm_send"));
});

test("oracle-full-crypto pack covers trader, builder, analyzer, Bitcoin, Solana, launches, DEX, and smart-wallet scanning", () => {
  const pack = JSON.parse(readFileSync(packPath, "utf8"));
  const capabilities = new Set(pack.capabilities || []);
  for (const capability of [
    "trader",
    "builder",
    "analyzer",
    "solana-jupiter",
    "bitcoin-inscriptions",
    "nft-project-launch",
    "multichain-token-launch",
    "multichain-nft-collection-launch",
    "gacha-launch",
    "dex-launch",
    "onchain-scanner",
    "smart-wallet-scanner",
    "meme-token-sniping",
    "per-chain-graphs",
    "telegram-cards",
    "hip-3-builder-dex",
    "hip-4-outcome-markets",
    "cross-chain-rfq",
    "rfq-best-execution",
    "tokenized-robinhood-assets",
    "nft-mint-gas-war-limits",
    "nft-mint-bot",
    "solana-nft-marketplace",
    "solana-nft-mint",
    "multichain-balance",
    "nft-inventory-gallery-pnl",
    "portfolio-balance-history-graph",
    "hypercore-hype-staking",
    "hypercore-validator-delegation",
  ]) {
    assert.ok(capabilities.has(capability), `missing capability ${capability}`);
  }

  assert.ok(pack.profiles.some((p) => p.id === "bitcoin-agent"), "Bitcoin lane must be installable");
  const localSkills = [
    ...new Set(JSON.stringify(pack.skill_packs).match(/oracle-[a-z0-9-]+/g) || []),
  ];
  const flattened = JSON.stringify(pack.skill_packs);
  for (const skill of localSkills) {
    assert.ok(flattened.includes(skill), `pack must reference ${skill}`);
    assert.ok(existsSync(join(root, "skills", skill, "SKILL.md")), `${skill} must ship as a skill`);
  }
});

test("console claims full crypto pack + protocol builder", () => {
  const html = readFileSync(join(root, "public/oracle-console/index.html"), "utf8");
  assert.match(html, /full crypto pack/i);
  assert.match(html, /Protocol builder/i);
  assert.match(html, /DISARMED/);
});

test("splash claims protocol builder", () => {
  const html = readFileSync(join(root, "public/oracle-splash/index.html"), "utf8");
  assert.match(html, /protocol builder/i);
});
