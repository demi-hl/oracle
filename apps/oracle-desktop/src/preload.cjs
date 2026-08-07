const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("oracleDesktop", {
  runCli(line) {
    return ipcRenderer.invoke("oracle:cli:run", String(line || ""));
  },
});
