// Short-lived Polymarket CLOB WebSocket market snapshots.

const POLY_WS = process.env.POLY_WS_URL || "wss://ws-subscriptions-clob.polymarket.com/ws/market";

/**
 * Subscribe to asset_ids (token ids) and return first book-like payload.
 */
export async function polyWsSnapshot(assetIds = [], opts = {}) {
  const ids = Array.isArray(assetIds) ? assetIds.map(String) : [String(assetIds)];
  if (!ids.length || !ids[0]) throw new Error("polyWsSnapshot requires assetIds");
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const maxMessages = opts.maxMessages ?? 1;
  const WebSocketImpl = opts.WebSocket || globalThis.WebSocket;
  if (!WebSocketImpl) throw new Error("WebSocket not available");

  const url = opts.url || POLY_WS;
  const started = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    const messages = [];
    let dataCount = 0;
    const ws = new WebSocketImpl(url);
    const timer = setTimeout(() => {
      cleanup();
      if (!settled) {
        settled = true;
        if (messages.length) resolve({ ok: true, partial: true, ms: Date.now() - started, messages });
        else reject(new Error(`poly ws timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }

    ws.addEventListener("open", () => {
      // CLOB market channel: assets_ids
      ws.send(
        JSON.stringify({
          assets_ids: ids,
          type: "market",
        })
      );
    });

    ws.addEventListener("message", (ev) => {
      let data;
      try {
        data = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        data = { raw: String(ev.data).slice(0, 300) };
      }
      messages.push(data);
      dataCount += 1;
      if (dataCount >= maxMessages) {
        cleanup();
        if (!settled) {
          settled = true;
          resolve({
            ok: true,
            ms: Date.now() - started,
            assetIds: ids,
            messages,
            last: messages[messages.length - 1],
          });
        }
      }
    });

    ws.addEventListener("error", () => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(new Error("poly ws error"));
      }
    });
  });
}

export async function polyWsHealth(opts = {}) {
  // Use a well-known active token if none provided — caller can pass assetId
  const assetId =
    opts.assetId ||
    "98022490269692409998126496127597032490334070080325855126491859374983463996227";
  try {
    const snap = await polyWsSnapshot([assetId], { ...opts, maxMessages: 1 });
    return { ok: true, ms: snap.ms, got: Boolean(snap.last), partial: snap.partial || false };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}

export async function polyWsBook(assetId, opts = {}) {
  if (!assetId) throw new Error("assetId required");
  const snap = await polyWsSnapshot([assetId], opts);
  return { ms: snap.ms, assetId: String(assetId), data: snap.last, messages: snap.messages };
}
