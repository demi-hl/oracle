/**
 * Oracle Exec MCP server — sign + broadcast for the user's operator wallet.
 * Route: exec_evm_sign, exec_evm_send, exec_evm_simulate, exec_evm_verify, exec_status.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { resolveExecClient } from "./exec-client.mjs";

const TOOLS = [
  {
    name: "exec_evm_sign",
    description:
      "Sign a prepared EVM transaction with the operator wallet. Returns the signed raw transaction.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["chainId", "tx"],
      properties: {
        chainId: { type: "integer", description: "EVM chain ID" },
        tx: { type: "object", description: "Prepared unsigned transaction" },
      },
    },
  },
  {
    name: "exec_evm_send",
    description: "Broadcast a signed EVM transaction and return the receipt.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["chainId", "signedTx"],
      properties: {
        chainId: { type: "integer" },
        signedTx: { type: "string", description: "0x-prefixed signed raw transaction" },
      },
    },
  },
  {
    name: "exec_evm_simulate",
    description: "Simulate an unsigned EVM transaction via eth_call before signing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["chainId", "tx"],
      properties: {
        chainId: { type: "integer" },
        tx: { type: "object" },
      },
    },
  },
  {
    name: "exec_evm_verify",
    description: "Verify a broadcast transaction: receipt status, confirmations.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["chainId", "hash"],
      properties: {
        chainId: { type: "integer" },
        hash: { type: "string" },
      },
    },
  },
  {
    name: "exec_status",
    description: "Exec plane status: whether signing is armed and operator is configured.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
];

function loadOperator() {
  const dir = process.env.ORACLE_CONFIG_DIR || join(homedir(), ".config", "oracle");
  const p = join(dir, "operator.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function fail(msg) {
  const e = new Error(msg);
  e.code = "ORACLE_EXEC_ERROR";
  throw e;
}

function only(obj, allowed) {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length) fail(`unknown fields: ${extra.join(", ")}`);
}

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

export function createExecMcp(options = {}) {
  const operator = options.operator ?? loadOperator();
  if (!operator) {
    return Object.freeze({
      tools: TOOLS,
      async call(name, _rawArgs) {
        if (name === "exec_status") {
          return result({ armed: false, operator: null, setup: "run 'oracle init --apply' to create your wallet" });
        }
        throw new Error("No wallet configured. Run 'oracle init --apply' in your terminal to create one. It generates a local key at ~/.config/oracle/keys/evm.json — never leaves your machine.");
      },
    });
  }
  const execClient = options.execClient ?? resolveExecClient(operator);

  return Object.freeze({
    tools: TOOLS,
    async call(name, rawArgs = {}) {
      const args = typeof rawArgs === "object" && rawArgs !== null ? rawArgs : {};

      if (name === "exec_evm_sign") {
        only(args, ["chainId", "tx"]);
        return result(await execClient.sign(Number(args.chainId), args.tx));
      }
      if (name === "exec_evm_send") {
        only(args, ["chainId", "signedTx"]);
        return result(await execClient.send(Number(args.chainId), String(args.signedTx)));
      }
      if (name === "exec_evm_simulate") {
        only(args, ["chainId", "tx"]);
        return result(await execClient.simulate(Number(args.chainId), args.tx));
      }
      if (name === "exec_evm_verify") {
        only(args, ["chainId", "hash"]);
        return result(await execClient.verify(Number(args.chainId), String(args.hash)));
      }
      if (name === "exec_status") {
        only(args, []);
        return result({
          armed: !!process.env.ORACLE_EXEC_ENABLED || operator.armed === true,
          operator: operator.address || null,
          chains: operator.chains || ["ethereum", "base", "arbitrum", "optimism", "polygon", "bsc", "avalanche"],
        });
      }
      fail(`unknown tool ${name}`);
    },
  });
}