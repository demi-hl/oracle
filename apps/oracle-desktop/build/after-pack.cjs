// Copy the staged Next runtime into the packaged app ourselves.
//
// electron-builder's extraResources copy strips node_modules out of the staged
// runtime no matter what `filter` says, so the packaged app shipped a server.js
// with no `next` to require. It built clean and died on the user's machine with
// MODULE_NOT_FOUND — the worst failure shape, because every upstream gate is
// green and only the installed artifact is broken.
//
// fs.cpSync is deterministic and has no opinion about node_modules.

const { cpSync, existsSync, readdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  const desktopDir = join(__dirname, "..");
  const source = join(desktopDir, "runtime", "oracle-app");
  if (!existsSync(source)) {
    throw new Error(`afterPack: staged runtime missing at ${source}; run build:runtime first`);
  }

  const resources =
    context.electronPlatformName === "darwin"
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : join(context.appOutDir, "resources");

  const destination = join(resources, "oracle-app");
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true, dereference: true });

  const modules = join(destination, "node_modules");
  if (!existsSync(modules)) {
    throw new Error("afterPack: node_modules did not land in the packaged runtime");
  }
  if (!existsSync(join(destination, "apps", "oracle-app", "server.js"))) {
    throw new Error("afterPack: packaged runtime has no server.js");
  }
  if (!existsSync(join(modules, "next"))) {
    throw new Error("afterPack: packaged runtime cannot resolve next");
  }

  console.log(`  • staged runtime copied  packages=${readdirSync(modules).length} dest=${destination}`);
};
