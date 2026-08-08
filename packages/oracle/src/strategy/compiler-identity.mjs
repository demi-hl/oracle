import { createHash } from "node:crypto";

export const COMPILER_VERSION = 2;

const compilerSourceHash = "93f9c998260e73756c13871dc1a84dd6cdb26ec6113bd1941f023519939db440";
const indicatorsSourceHash = "68f5b412a9975f04024cf9b9b6209b4bccedd52f176e95f34f786b3f53479c6a";
const schemaSourceHash = "d2d75085cb3ab02724cd173abfa2bcad99cd7966a69bcaf80312f13e5b7aaa50";

export const COMPILER_HASH = createHash("sha256")
  .update(JSON.stringify({
    version: COMPILER_VERSION,
    compilerSourceHash,
    indicatorsSourceHash,
    schemaSourceHash,
  }))
  .digest("hex");
