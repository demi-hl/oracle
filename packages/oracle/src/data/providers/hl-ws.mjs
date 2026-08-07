// Short-lived Hyperliquid WebSocket snapshots (subscribe → first payload → close).
// No long-running daemon; safe for desk HTTP handlers.

const HL_WS = process.env.HL_WS_URL || "wss://api.hyperliquid.xyz/ws";

/**
 * @param {object} subscription e.g. { type: 'allMids' } | { type: 'l2Book', coin: 'BTC' }
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxMessages] stop after N data messages (default 1)
 */
export async function hlWsSnapshot(subscription, opts = {}) {
  if (!subscription?.type) throw new Error("hlWsSnapshot requires subscription.type");
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const maxMessages = opts.maxMessages ?? 1;
  const WebSocketImpl = opts.WebSocket || globalThis.WebSocket;
  if (!WebSocketImpl) throw new Error("WebSocket not available in this runtime");

  const url = opts.url || HL_WS;
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
        if (messages.length) {
          resolve({ ok: true, partial: true, ms: Date.now() - started, messages });
        } else {
          reject(new Error(`hl ws timeout after ${timeoutMs}ms`));
        }
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
      ws.send(JSON.stringify({ method: "subscribe", subscription }));
    });

    ws.addEventListener("message", (ev) => {
      let data;
      try {
        data = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        data = { raw: String(ev.data).slice(0, 200) };
      }
      messages.push(data);
      // skip pure subscriptionResponse for counting "data"
      if (data.channel && data.channel !== "subscriptionResponse") {
        dataCount += 1;
      } else if (data.data && data.channel === "subscriptionResponse") {
        // ignore ack
      } else if (!data.channel) {
        dataCount += 1;
      }
      if (dataCount >= maxMessages) {
        cleanup();
        if (!settled) {
          settled = true;
          resolve({
            ok: true,
            ms: Date.now() - started,
            subscription,
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
        reject(new Error("hl ws error"));
      }
    });
  });
}

export async function hlWsHealth(opts = {}) {
  try {
    const snap = await hlWsSnapshot({ type: "allMids" }, { ...opts, maxMessages: 1 });
    const last = snap.last || {};
    const mids = last.data?.mids || last.data || {};
    const n = typeof mids === "object" ? Object.keys(mids).length : 0;
    return { ok: true, ms: snap.ms, midCount: n, channel: last.channel || null };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}

export async function hlWsAllMids(opts = {}) {
  const snap = await hlWsSnapshot({ type: "allMids" }, opts);
  const last = snap.last || {};
  return {
    ms: snap.ms,
    mids: last.data?.mids || last.data || {},
    channel: last.channel,
  };
}

export async function hlWsL2Book(coin, opts = {}) {
  if (!coin) throw new Error("coin required");
  const snap = await hlWsSnapshot({ type: "l2Book", coin: String(coin) }, opts);
  return { ms: snap.ms, book: snap.last?.data || snap.last, channel: snap.last?.channel };
}
