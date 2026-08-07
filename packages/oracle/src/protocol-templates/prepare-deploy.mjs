// Prepare unsigned deploy for a gated protocol template.
// Never signs. Never broadcasts. Requires green forge tests first.

import { ContractFactory, isAddress } from "ethers";
import { stampPrepared } from "../prepare-envelope.mjs";
import { buildProtocolTemplate, listProtocolTemplates, TEMPLATE_AUDIT_DISCLAIMER } from "./gate.mjs";

export { listProtocolTemplates, TEMPLATE_AUDIT_DISCLAIMER };

/**
 * @param {object} args
 * @param {string} args.templateId - e.g. safe-erc20
 * @param {number} args.chainId
 * @param {string[]} [args.constructorArgs] - ABI-encoded via ethers from values
 * @param {any[]} [args.args] - constructor JS values (preferred)
 * @param {string} [args.contractName]
 */
export async function prepareTemplateDeploy(args = {}, opts = {}) {
  const templateId = String(args.templateId || "").trim();
  if (!templateId) throw new Error("prepareTemplateDeploy: templateId required");
  const chainId = Number(args.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error("prepareTemplateDeploy: chainId required");
  }

  const built = buildProtocolTemplate(templateId, {
    contractName: args.contractName,
    allowSkipStatic: opts.allowSkipStatic !== false,
    allowStaticFail: opts.allowStaticFail === true,
  });

  if (!built.bytecode || built.bytecode === "0x") {
    throw new Error("prepareTemplateDeploy: empty bytecode");
  }

  const bc = built.bytecode.startsWith("0x") ? built.bytecode : `0x${built.bytecode}`;
  const ctorArgs = args.args ?? args.constructorArgs ?? [];
  const factory = new ContractFactory(built.abi, bc);
  const deployTx = await factory.getDeployTransaction(...(Array.isArray(ctorArgs) ? ctorArgs : []));
  const data = deployTx.data;

  // validate SafeERC20 constructor shape if applicable
  if (templateId === "safe-erc20" && Array.isArray(ctorArgs)) {
    const [name, symbol, supply, holder, owner] = ctorArgs;
    if (!name || !symbol) throw new Error("safe-erc20: name/symbol required");
    if (supply == null || BigInt(supply) <= 0n) throw new Error("safe-erc20: supply must be > 0");
    if (!isAddress(String(holder))) throw new Error("safe-erc20: initialHolder must be address");
    if (!isAddress(String(owner))) throw new Error("safe-erc20: initialOwner must be address");
  }

  return stampPrepared(
    {
      provider: "protocol-templates",
      kind: "template-deploy",
      templateId,
      contractName: built.contractName,
      chainId,
      transaction: {
        chainId,
        to: null, // creation
        data,
        value: "0x0",
      },
      abi: built.abi,
      bytecodeHash: built.gate.sourceHash,
      gate: {
        forgeTests: built.gate.forgeTests,
        staticAnalysis: {
          tool: built.gate.staticAnalysis.tool,
          ok: built.gate.staticAnalysis.ok,
          skipped: built.gate.staticAnalysis.skipped,
        },
        firmAudit: false,
        disclaimer: TEMPLATE_AUDIT_DISCLAIMER,
      },
      requiresUserSignature: true,
      note: "Unsigned deploy. User wallet signs. Template tests passed; not a firm audit.",
    },
    { provider: "protocol-templates", kind: "template-deploy" }
  );
}
