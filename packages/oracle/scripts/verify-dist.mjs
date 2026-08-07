// Smoke-test the bundled dist against the real package surface.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const rows = [];

for (const [name, target] of Object.entries(pkg.exports || {})) {
  if (typeof target !== "string" || !target.startsWith("./src/")) continue;
  const distPath = "../dist/" + target.replace(/^\.\/src\//, "");
  try {
    const srcMod = await import(new URL(target.replace("./", "../"), import.meta.url).href);
    const dstMod = await import(new URL(distPath, import.meta.url).href);
    const s = Object.keys(srcMod).sort();
    const d = Object.keys(dstMod).sort();
    const missing = s.filter((k) => !d.includes(k));
    rows.push({ name, src: s.length, dist: d.length, missing });
  } catch (e) {
    rows.push({ name, error: String(e.message).slice(0, 80) });
  }
}

let bad = 0;
for (const r of rows) {
  if (r.error) { bad++; console.log(`  FAIL ${r.name.padEnd(20)} ${r.error}`); continue; }
  if (r.missing.length) { bad++; console.log(`  FAIL ${r.name.padEnd(20)} missing: ${r.missing.join(",")}`); continue; }
  console.log(`  OK   ${r.name.padEnd(20)} ${r.dist} exports match`);
}
console.log(`\n${rows.length} entry points, ${bad} broken`);
process.exitCode = bad ? 1 : 0;
