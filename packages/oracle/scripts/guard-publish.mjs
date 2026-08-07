#!/usr/bin/env node
// prepublishOnly guard.
//
// `npm publish` run directly in packages/oracle would ship src/ — 36k lines of
// readable source. Publishing must go through scripts/publish-dist.mjs, which
// packs the bundled stage instead. That script sets ORACLE_PUBLISH_STAGED=1.
//
// This is a guard, not a policy decision: it fails closed on the accident.

if (process.env.ORACLE_PUBLISH_STAGED === "1") process.exit(0);

console.error(`
REFUSING to publish from the source tree.

  Publishing here would ship src/ (readable source) to npm.

  Use:  npm run publish:dist -- --publish

  That builds the bundle, verifies export parity, stages a clean directory
  with a rewritten manifest, and publishes that instead.
`);
process.exit(1);
