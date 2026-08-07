import test from "node:test";
import assert from "node:assert/strict";

// The router passes the user's raw CLI token argument through to lifiPrepare, so
// q.fromToken is frequently a SYMBOL. LI.FI's API accepts that, but the approval
// block must name a real 20-byte token or the whole prepare throws and the
// winning route is unreachable.
test("lifi approval prefers the resolved token address over a symbol input", async () => {
  const mod = await import("../src/data/providers/lifi.mjs");
  const src = await import("node:fs").then((fs) =>
    fs.promises.readFile(new URL("../src/data/providers/lifi.mjs", import.meta.url), "utf8"));

  assert.match(src, /action\?\.fromToken\?\.address/,
    "must read the resolved token address LI.FI echoes back");
  assert.doesNotMatch(src, /token: address\(q\.fromToken, "approval token"\)/,
    "must not pass the raw (possibly symbolic) input as the approval token");
  assert.equal(typeof mod.lifiPrepare, "function");
});
