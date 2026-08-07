#!/usr/bin/env node
/**
 * Oracle Exec MCP — sign and broadcast on the user's behalf.
 * Separate process, structured JSON-RPC over stdio.
 */
import { createExecMcp } from "../src/exec-mcp.mjs";
import { serveMcp } from "../src/mcp-serve.mjs";

serveMcp(createExecMcp()).catch((err) => {
  process.stderr.write(`oracle-exec-mcp: ${err.message}\n`);
  process.exit(1);
});