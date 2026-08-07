// Oracle Console. Public frontend, Slice I.
//
// Single action UI: connect a wallet, then preview a proposed permission set.
// This file never installs a grant or session key and never claims on-chain
// enforcement. It never stores, logs, or transmits a private key, session
// secret, bearer token, or signer URL.
//
// Talks to two BFF routes only:
//   POST /public/connect/assemble  -> assembleUnsignedGrant(body)
//   POST /public/grants/active     -> listActiveGrants(body.store, body.opts)

(function () {
  "use strict";

  const CONNECT_ASSEMBLE_URL = "/public/connect/assemble";
  const GRANTS_ACTIVE_URL = "/public/grants/active";

  // Demo policy for the connected agent. Read only scopes, bounded caps,
  // one hour expiry. Nothing here is authorization.
  const DEMO_AGENT_ADDRESS = "0x1111111111111111111111111111111111111111";
  const DEMO_CHAIN_ID = 8453;
  const DEMO_ACTIONS = ["read:balance", "read:positions"];
  const DEMO_TARGETS = [];
  const DEMO_MAX_VALUE_WEI = "0";
  const DEMO_MAX_GAS_WEI = "0";
  const DEMO_MAX_SLIPPAGE_BPS = 0;
  const DEMO_TTL_SECONDS = 3600;

  const connectBtn = document.getElementById("connect-btn");
  const walletState = document.getElementById("wallet-state");
  const revokeBtn = document.getElementById("revoke-btn");
  const permissionPanel = document.getElementById("permission-panel");
  const panelStatus = document.getElementById("panel-status");

  const stepConnect = document.getElementById("step-connect");
  const stepBound = document.getElementById("step-bound");
  const stepEnforced = document.getElementById("step-enforced");

  const permChain = document.getElementById("perm-chain");
  const permActions = document.getElementById("perm-actions");
  const permTargets = document.getElementById("perm-targets");
  const permMaxValue = document.getElementById("perm-max-value");
  const permExpiry = document.getElementById("perm-expiry");

  // In-memory session state only. Never persisted, never logged.
  let session = {
    accountAddress: null,
    grant: null,
    grantId: null,
  };

  function setStep(stepEl, state) {
    stepEl.setAttribute("data-state", state);
  }

  function resetSteps() {
    setStep(stepConnect, "pending");
    setStep(stepBound, "pending");
    setStep(stepEnforced, "pending");
  }

  function hasInjectedWallet() {
    return typeof window !== "undefined" && typeof window.ethereum !== "undefined";
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const message = (data && data.error) || `request to ${url} failed with status ${res.status}`;
      throw new Error(message);
    }
    return data;
  }

  function nowUnixSeconds() {
    return Math.floor(Date.now() / 1000);
  }

  function formatExpiry(unixSeconds) {
    return new Date(unixSeconds * 1000).toISOString();
  }

  function renderPermissionPanel(grant) {
    permChain.textContent = String(grant.chainId);
    permActions.textContent = grant.actions.join(", ");
    permTargets.textContent = grant.targets.length ? grant.targets.join(", ") : "none, read and simulate only";
    permMaxValue.textContent = `${grant.maxValueWei} wei`;
    permExpiry.textContent = formatExpiry(grant.expiresAt);
    permissionPanel.hidden = false;
    revokeBtn.disabled = false;
    panelStatus.textContent = "";
  }

  async function requestAccount() {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    if (!accounts || !accounts[0]) {
      throw new Error("no account returned by wallet");
    }
    return accounts[0];
  }

  async function connectFlow() {
    if (!hasInjectedWallet()) {
      walletState.textContent = "Connect a wallet to continue.";
      return;
    }

    connectBtn.disabled = true;
    resetSteps();
    permissionPanel.hidden = true;

    try {
      walletState.textContent = "Requesting account.";
      const accountAddress = await requestAccount();
      session.accountAddress = accountAddress;
      setStep(stepConnect, "done");
      walletState.textContent = `Connected as ${accountAddress}.`;

      setStep(stepBound, "active");
      const assembled = await postJson(CONNECT_ASSEMBLE_URL, {
        chainId: DEMO_CHAIN_ID,
        agentAddress: DEMO_AGENT_ADDRESS,
        accountAddress: accountAddress,
        actions: DEMO_ACTIONS,
        targets: DEMO_TARGETS,
        maxValueWei: DEMO_MAX_VALUE_WEI,
        maxGasWei: DEMO_MAX_GAS_WEI,
        maxSlippageBps: DEMO_MAX_SLIPPAGE_BPS,
        ttlSeconds: DEMO_TTL_SECONDS,
        nonce: `console.${nowUnixSeconds()}`,
        revocationKey: `revoke.console.${nowUnixSeconds()}`,
      });

      const grant = assembled.payload.grant;
      const grantId = assembled.payload.grantId;
      session.grant = grant;
      session.grantId = grantId;
      setStep(stepBound, "done");
      walletState.textContent = "Permission set reviewed. Building local preview.";

      setStep(stepEnforced, "active");
      await refreshActiveGrants();
      setStep(stepEnforced, "done");
      walletState.textContent = "Permission preview ready. No session was installed.";
    } catch (err) {
      walletState.textContent = `Connect failed: ${err.message}`;
    } finally {
      connectBtn.disabled = false;
    }
  }

  async function refreshActiveGrants() {
    if (!session.grant || !session.accountAddress) return;

    const store = [
      {
        grant: session.grant,
        revoked: false,
      },
    ];

    const result = await postJson(GRANTS_ACTIVE_URL, {
      store: store,
      opts: {
        now: nowUnixSeconds(),
        accountAddress: session.accountAddress,
        agentAddress: DEMO_AGENT_ADDRESS,
        chainId: DEMO_CHAIN_ID,
      },
    });

    const active = Array.isArray(result) ? result : result.active || [];
    const match = active.find((entry) => entry.id === session.grantId);

    if (match) {
      renderPermissionPanel(match.grant);
    } else {
      permissionPanel.hidden = false;
      revokeBtn.disabled = true;
      panelStatus.textContent = "This permission preview is no longer active.";
    }
  }

  function clearPreviewFlow() {
    if (!session.grant) return;
    revokeBtn.disabled = true;
    session.grant = null;
    session.grantId = null;
    permissionPanel.hidden = true;
    resetSteps();
    setStep(stepConnect, "done");
    walletState.textContent = "Permission preview cleared. No on-chain revocation was required.";
  }

  connectBtn.addEventListener("click", () => {
    connectFlow();
  });

  revokeBtn.addEventListener("click", () => {
    clearPreviewFlow();
  });

  // ── Bitcoin multi-wallet lane (actual BTC L1) ───────────────────────────
  const btcConnectBtn = document.getElementById("btc-connect-btn");
  const btcWalletState = document.getElementById("btc-wallet-state");
  const btcPanel = document.getElementById("btc-panel");
  const btcWalletLabel = document.getElementById("btc-wallet-label");
  const btcAddressEl = document.getElementById("btc-address");
  const btcDetectedEl = document.getElementById("btc-detected");
  const btcPanelStatus = document.getElementById("btc-panel-status");

  let btcSession = null;

  function refreshBtcDetected() {
    const api = window.OracleBitcoinWallets;
    if (!api) {
      if (btcDetectedEl) btcDetectedEl.textContent = "wallet adapter missing";
      return [];
    }
    const detected = api.listDetected();
    if (btcDetectedEl) {
      btcDetectedEl.textContent = detected.length
        ? detected.map((d) => d.label).join(", ")
        : "none - install Xverse / UniSat / Leather / OKX / Phantom / Magic Eden";
    }
    return detected;
  }

  async function btcConnectFlow() {
    const api = window.OracleBitcoinWallets;
    if (!api) {
      btcWalletState.textContent = "Bitcoin wallet adapter failed to load.";
      return;
    }
    btcConnectBtn.disabled = true;
    btcWalletState.textContent = "Requesting Bitcoin wallet.";
    try {
      btcSession = await api.connect();
      btcWalletState.textContent = `BTC connected: ${btcSession.walletLabel}`;
      btcWalletLabel.textContent = btcSession.walletLabel;
      btcAddressEl.textContent = btcSession.address;
      btcPanel.hidden = false;
      btcPanelStatus.textContent =
        "Connected. Signing stays in your wallet (signPsbt). Oracle only reads + broadcasts user-signed hex.";
      refreshBtcDetected();
    } catch (err) {
      btcWalletState.textContent = `BTC connect failed: ${err.message}`;
      btcPanelStatus.textContent = err.message;
    } finally {
      btcConnectBtn.disabled = false;
    }
  }

  if (btcConnectBtn) {
    btcConnectBtn.addEventListener("click", () => {
      btcConnectFlow();
    });
    refreshBtcDetected();
    if (!refreshBtcDetected().length) {
      btcWalletState.textContent = "No Bitcoin wallet detected yet.";
    }
  }

  if (!hasInjectedWallet()) {
    walletState.textContent = "Connect an EVM wallet to continue.";
  }
})();
