// Multi-wallet Bitcoin connector for Oracle Console.
// Injected providers only - no npm wallet SDK required in the static console.
// Supported: Xverse, UniSat, Leather, OKX, Phantom, Magic Eden, generic.
// Signing: PSBT stays in the wallet. Oracle never sees private keys.

(function (root) {
  "use strict";

  const WALLETS = [
    {
      id: "unisat",
      label: "UniSat",
      detect: () => window.unisat,
      async connect(provider) {
        const accounts = await provider.requestAccounts();
        const address = accounts && accounts[0];
        if (!address) throw new Error("UniSat returned no address");
        const network = (await provider.getNetwork?.()) || "livenet";
        return { address, network, provider };
      },
      async signPsbt(provider, psbtHex, options = {}) {
        return provider.signPsbt(psbtHex, options);
      },
      async pushPsbt(provider, psbtHex) {
        if (typeof provider.pushPsbt === "function") return provider.pushPsbt(psbtHex);
        throw new Error("UniSat pushPsbt unavailable - use Oracle broadcast with raw hex");
      },
    },
    {
      id: "okx",
      label: "OKX",
      detect: () => window.okxwallet && window.okxwallet.bitcoin,
      async connect(provider) {
        const result = await provider.connect();
        const address = result?.address || result?.addresses?.[0] || (Array.isArray(result) && result[0]);
        if (!address) throw new Error("OKX returned no address");
        return { address, network: result?.network || "livenet", provider };
      },
      async signPsbt(provider, psbtHex, options = {}) {
        return provider.signPsbt(psbtHex, options);
      },
      async pushPsbt(provider, psbtHex) {
        if (typeof provider.pushPsbt === "function") return provider.pushPsbt(psbtHex);
        throw new Error("OKX pushPsbt unavailable - use Oracle broadcast with raw hex");
      },
    },
    {
      id: "xverse",
      label: "Xverse",
      detect: () =>
        window.XverseProviders?.BitcoinProvider ||
        window.BitcoinProvider ||
        (window.xverse && window.xverse.bitcoin),
      async connect(provider) {
        // Sats Connect request shape when provider.request exists
        if (typeof provider.request === "function") {
          const res = await provider.request("getAccounts", {
            purposes: ["payment", "ordinals"],
            message: "Connect to Oracle",
          });
          const arr = res?.result || res;
          const payment = Array.isArray(arr) ? arr.find((a) => a.purpose === "payment") || arr[0] : null;
          const address = payment?.address || payment;
          if (!address) throw new Error("Xverse returned no address");
          return { address, network: payment?.network || "Mainnet", provider };
        }
        if (typeof provider.connect === "function") {
          const res = await provider.connect("Oracle");
          const address = res?.addresses?.payment?.address || res?.paymentAddress || res?.address;
          if (!address) throw new Error("Xverse returned no address");
          return { address, network: res?.network || "Mainnet", provider };
        }
        throw new Error("Xverse provider has no connect/request method");
      },
      async signPsbt(provider, psbtBase64, options = {}) {
        if (typeof provider.request === "function") {
          const res = await provider.request("signPsbt", {
            psbt: psbtBase64,
            allowedSignHash: options.allowedSignHash,
            signInputs: options.signInputs,
            broadcast: false,
          });
          return res?.result?.psbt || res?.psbt || res;
        }
        if (typeof provider.signPsbt === "function") {
          return provider.signPsbt(psbtBase64, options);
        }
        throw new Error("Xverse signPsbt unavailable");
      },
      async pushPsbt() {
        throw new Error("Xverse: finalize in wallet or broadcast raw hex via Oracle");
      },
    },
    {
      id: "leather",
      label: "Leather",
      detect: () => window.LeatherProvider || window.HiroWalletProvider || window.btc,
      async connect(provider) {
        if (typeof provider.request === "function") {
          const res = await provider.request("getAddresses");
          const addrs = res?.result?.addresses || res?.addresses || [];
          const payment = addrs.find((a) => a.type === "p2wpkh" || a.symbol === "BTC") || addrs[0];
          const address = payment?.address;
          if (!address) throw new Error("Leather returned no address");
          return { address, network: payment?.network || "mainnet", provider };
        }
        throw new Error("Leather provider has no request method");
      },
      async signPsbt(provider, psbtBase64, options = {}) {
        const res = await provider.request("signPsbt", {
          hex: options.hex || undefined,
          base64: psbtBase64,
          broadcast: false,
          ...options,
        });
        return res?.result?.hex || res?.result?.base64 || res?.hex || res;
      },
      async pushPsbt() {
        throw new Error("Leather: broadcast raw hex via Oracle");
      },
    },
    {
      id: "phantom",
      label: "Phantom",
      detect: () => window.phantom && window.phantom.bitcoin,
      async connect(provider) {
        const res = await provider.requestAccounts();
        const address = res?.[0]?.address || res?.[0];
        if (!address) throw new Error("Phantom returned no BTC address");
        return { address, network: "mainnet", provider };
      },
      async signPsbt(provider, psbtHex, options = {}) {
        const res = await provider.signPSBT(Buffer.from(psbtHex, "hex"), options);
        return res;
      },
      async pushPsbt() {
        throw new Error("Phantom: broadcast raw hex via Oracle");
      },
    },
    {
      id: "magic-eden",
      label: "Magic Eden",
      detect: () => window.magicEden && window.magicEden.bitcoin,
      async connect(provider) {
        const res = await provider.connect();
        const address = res?.address || res?.ordinals?.address || res?.payment?.address;
        if (!address) throw new Error("Magic Eden returned no address");
        return { address, network: "mainnet", provider };
      },
      async signPsbt(provider, psbt, options = {}) {
        return provider.signPsbt(psbt, options);
      },
      async pushPsbt() {
        throw new Error("Magic Eden: broadcast raw hex via Oracle");
      },
    },
  ];

  function listDetected() {
    return WALLETS.filter((w) => {
      try {
        return !!w.detect();
      } catch {
        return false;
      }
    }).map((w) => ({ id: w.id, label: w.label }));
  }

  async function connect(preferredId) {
    const detected = WALLETS.filter((w) => {
      try {
        return !!w.detect();
      } catch {
        return false;
      }
    });
    if (!detected.length) {
      throw new Error(
        "No Bitcoin wallet detected. Install Xverse, UniSat, Leather, OKX, Phantom, or Magic Eden."
      );
    }
    const wallet = (preferredId && detected.find((w) => w.id === preferredId)) || detected[0];
    const provider = wallet.detect();
    const session = await wallet.connect(provider);
    return {
      walletId: wallet.id,
      walletLabel: wallet.label,
      address: session.address,
      network: session.network,
      provider: session.provider,
      wallet,
    };
  }

  async function signPsbt(session, psbt, options = {}) {
    if (!session?.wallet || !session?.provider) throw new Error("Bitcoin wallet not connected");
    return session.wallet.signPsbt(session.provider, psbt, options);
  }

  root.OracleBitcoinWallets = {
    listDetected,
    connect,
    signPsbt,
    supported: WALLETS.map((w) => ({ id: w.id, label: w.label })),
  };
})(typeof window !== "undefined" ? window : globalThis);
