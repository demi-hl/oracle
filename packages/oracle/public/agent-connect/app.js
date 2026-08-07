(() => {
  "use strict";

  const PACKAGE = "@oracle-agent/oracle";
  const COMMAND = "npx";
  const ARGS = ["-y", "--package", PACKAGE, "oracle-data-mcp"];
  const INIT_COMMAND = "npx -y --package @oracle-agent/oracle oracle-init";

  const apiUrl = document.querySelector("#api-url");
  const apiKey = document.querySelector("#api-key");
  const walletAddress = document.querySelector("#wallet-address");
  const output = document.querySelector("#config-output");
  const label = document.querySelector("#config-label");
  const status = document.querySelector("#copy-status");
  const tabs = [...document.querySelectorAll("[data-harness]")];
  let selected = "hermes";

  const cleanUrl = () => apiUrl.value.trim().replace(/\/+$/, "");
  const env = () => {
    const values = {
      ORACLE_DATA_URL: cleanUrl() || "https://api.oracle-agent.dev",
      ORACLE_AGENT_KEY: apiKey.value.trim() || "YOUR_AGENT_KEY"
    };
    if (walletAddress.value.trim()) values.ORACLE_WALLET_ADDRESS = walletAddress.value.trim();
    return values;
  };

  const server = () => ({ command: COMMAND, args: [...ARGS], env: env() });

  const configs = {
    hermes: () => ({
      mcpServers: { oracle: server() }
    }),
    claude: () => ({
      mcpServers: { oracle: server() }
    }),
    codex: () => {
      const values = env();
      const lines = [
        "[mcp_servers.oracle]",
        `command = ${JSON.stringify(COMMAND)}`,
        `args = [${ARGS.map((arg) => JSON.stringify(arg)).join(", ")}]`,
        "",
        "[mcp_servers.oracle.env]",
        ...Object.entries(values).map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
      ];
      return lines.join("\n");
    },
    cursor: () => ({
      mcpServers: { oracle: server() }
    }),
    mcp: () => ({
      mcpServers: { oracle: server() }
    })
  };

  const names = { hermes: "Hermes", claude: "Claude Code", codex: "Codex", cursor: "Cursor", mcp: "Generic MCP" };

  function render() {
    const config = configs[selected]();
    output.textContent = typeof config === "string" ? config : JSON.stringify(config, null, 2);
    label.textContent = `${names[selected]} config`;
    status.textContent = "";
  }

  async function copy(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = message;
    } catch {
      status.textContent = "Copy was blocked. Select the text and copy it manually.";
    }
  }

  tabs.forEach((tab) => tab.addEventListener("click", () => {
    selected = tab.dataset.harness;
    tabs.forEach((item) => item.setAttribute("aria-selected", String(item === tab)));
    render();
  }));
  [apiUrl, apiKey, walletAddress].forEach((input) => input.addEventListener("input", render));
  document.querySelector("#copy-button").addEventListener("click", () => copy(output.textContent, `${names[selected]} config copied.`));
  document.querySelector("#copy-install").addEventListener("click", () => copy(INIT_COMMAND, "Local operator install command copied."));
  render();
})();
