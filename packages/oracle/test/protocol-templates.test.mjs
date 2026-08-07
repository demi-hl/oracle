import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { listProtocolTemplates, runProtocolTemplateGate } from "../src/protocol-templates/gate.mjs";
import { prepareTemplateDeploy } from "../src/protocol-templates/prepare-deploy.mjs";

function hasForge() {
  const home = process.env.HOME || "";
  for (const c of ["forge", `${home}/.foundry/bin/forge`]) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return true;
  }
  return false;
}

const FORGE = hasForge() && process.env.RUN_PROTOCOL_TEMPLATE_TESTS === "1";

test("lists safe-erc20 template", () => {
  const list = listProtocolTemplates();
  assert.ok(list.some((t) => t.id === "safe-erc20"));
  assert.ok(String(list[0].disclaimer).includes("NOT a paid"));
});

test("gate passes forge tests for safe-erc20", { skip: !FORGE && "forge not installed" }, () => {
  const g = runProtocolTemplateGate("safe-erc20");
  assert.equal(g.ok, true);
  assert.equal(g.forgeTests.ok, true);
  assert.equal(g.firmAudit, false);
});

test("prepareTemplateDeploy stamps unsigned creation tx", { skip: !FORGE && "forge not installed" }, async () => {
  const holder = "0x1111111111111111111111111111111111111111";
  const owner = "0x2222222222222222222222222222222222222222";
  const prep = await prepareTemplateDeploy({
    templateId: "safe-erc20",
    chainId: 8453,
    args: ["Safe", "SAFE", 10n ** 24n, holder, owner],
  });
  assert.equal(prep.oraclePrepared, true);
  assert.equal(prep.kind, "template-deploy");
  assert.equal(prep.gate.firmAudit, false);
  assert.ok(prep.transaction.data.startsWith("0x"));
  assert.equal(prep.transaction.to, null);
});

test("prepare refuses unknown template", async () => {
  await assert.rejects(
    () => prepareTemplateDeploy({ templateId: "honeypot-tax", chainId: 1, args: [] }),
    /unknown template|forge not found/
  );
});
