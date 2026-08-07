#!/usr/bin/env node
import { listProtocolTemplates, runProtocolTemplateGate } from "../src/protocol-templates/gate.mjs";

const id = process.argv[2];
if (!id || id === "list") {
  console.log(JSON.stringify(listProtocolTemplates(), null, 2));
  process.exit(0);
}
try {
  const r = runProtocolTemplateGate(id, { allowSkipStatic: process.env.REQUIRE_SLITHER !== "1" });
  console.log(JSON.stringify(r, null, 2));
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
