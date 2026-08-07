// Public scanner package subpath.
//
// Keep this as the stable API for README examples. `contract.mjs` defines the
// scanner contract/registry; `chains.config.mjs` defines built-in and custom EVM
// registration helpers. Export both here so package consumers do not need to know
// the internal file split.

export * from "./contract.mjs";
export { CHAIN_CONFIGS, registerBuiltinScanners, registerCustomChain } from "./chains.config.mjs";
