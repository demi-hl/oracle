# Registry stub

This is what `npm i @oracle-agent/oracle` installs. It is **not** Oracle.

## Why this exists

Oracle moved to holder-gated distribution. The public registry copy cannot be
removed: npm's unpublish policy blocks it above 300 weekly downloads, and this
package was at **5,181/week** when the cutover happened. Versions `<=0.12.0`
therefore stay on the registry permanently and remain fully functional for
anyone who names an explicit version.

What could be done was make `latest` inert. This stub carries no product code,
so the default install path (`npm i @oracle-agent/oracle`) lands on a pointer to
the gate instead of the CLI.

## Honest scope

- Default install path: gated.
- `npm i @oracle-agent/oracle@0.12.0`: still the full package, forever.
- Neither matters much for custody: no published artifact has ever held keys.
  Signing lives in the operator package, which is never published.

## Publishing a new stub

```
cd packages/oracle-registry-stub
npm version patch --no-git-tag-version
npm publish --access public
```

Keep `files` minimal. If this package ever grows a dependency or an import of
`@oracle-agent/oracle`, it has stopped being a stub.
