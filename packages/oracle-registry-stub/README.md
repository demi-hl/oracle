# @oracle-agent/oracle

**This package is a pointer, not the product.**

Oracle is distributed to [Locals Only](https://opensea.io/collection/locals-only-hyperevm) holders.
Versions `<=0.12.0` on this registry are deprecated and unmaintained.

## Get a build

Visit **https://oracle.demi.la**, prove your wallet holds a Locals Only NFT, and install
the artifact the gate returns:

```
curl -fL -o oracle.tgz "<link-from-gate>" && npm i -g ./oracle.tgz
```

Prefer no terminal? The desktop app is at https://oracle.demi.la/downloads/

## Why

A holder check that runs on your machine can always be switched off. Serving the
artifact from a server that verifies ownership is the only version of this that means
anything. Keys and signing never live in the public package either way.
