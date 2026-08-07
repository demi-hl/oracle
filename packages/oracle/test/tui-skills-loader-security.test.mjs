import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-skills-security-"));
const configDir = path.join(root, "config");
const skillsDir = path.join(configDir, "skills");
const outsideDir = path.join(root, "outside");
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });
process.env.ORACLE_CONFIG_DIR = configDir;

const { createSkill, loadSkill } = await import("../src/tui/skills-loader.mjs");

test("valid skill names stay inside the Oracle skills directory", () => {
  createSkill("bridge-routing", "SAFE_SKILL");
  assert.equal(loadSkill("bridge-routing"), "SAFE_SKILL");
  assert.equal(fs.readFileSync(path.join(skillsDir, "bridge-routing.md"), "utf8"), "SAFE_SKILL");
});

test("skill names cannot traverse outside the skills directory", () => {
  const readTarget = path.join(outsideDir, "readme.md");
  const writeTarget = path.join(outsideDir, "overwrite.md");
  fs.writeFileSync(readTarget, "OUTSIDE_SECRET_MARKER");
  fs.writeFileSync(writeTarget, "ORIGINAL");

  assert.equal(loadSkill("../../outside/readme"), null);
  assert.throws(() => createSkill("../../outside/overwrite", "PWNED"), /invalid skill name/i);
  assert.equal(fs.readFileSync(writeTarget, "utf8"), "ORIGINAL");
});

test("skill reads and writes reject symbolic links", () => {
  const outsideTarget = path.join(outsideDir, "symlink-target.md");
  const symlink = path.join(skillsDir, "symlink.md");
  fs.writeFileSync(outsideTarget, "OUTSIDE_SYMLINK_MARKER");
  fs.symlinkSync(outsideTarget, symlink);

  assert.equal(loadSkill("symlink"), null);
  assert.throws(() => createSkill("symlink", "PWNED"), /regular file/i);
  assert.equal(fs.readFileSync(outsideTarget, "utf8"), "OUTSIDE_SYMLINK_MARKER");
});
