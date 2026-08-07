#!/usr/bin/env node
// This is not Oracle. It is a pointer to the gate that distributes Oracle.
//
// The product moved to holder-gated distribution. The public registry copy
// cannot be unpublished (npm blocks it above 300 weekly downloads), so the
// next best thing is that `latest` carries no product code at all.
const GATE = "https://oracle.demi.la";
console.log(`
  Oracle is distributed to Locals Only holders.

  This npm package is a pointer, not the product. It contains no Oracle code.

  To get a build:
    1. Visit ${GATE}
    2. Prove your wallet holds a Locals Only NFT
    3. Install the artifact the gate returns:

       curl -fL -o oracle.tgz "<link-from-gate>" && npm i -g ./oracle.tgz

  Desktop app (no terminal required):  ${GATE}/downloads/

  Contract  0x62FCFAf7573AD8B41a0FBF347AfEb85e06599A75
  Chain     HyperEVM (999)
`);
process.exit(1);
