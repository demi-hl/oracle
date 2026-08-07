// Oracle service worker — PUSH ONLY, NO CACHING.
//
// The app is a THIN REMOTE SHELL that always loads the live UI from the server
// (:9443 tailscale → :9119). A caching SW adds nothing and actively HARMS: it
// served its own stale cache, surviving HTTP no-cache headers AND app
// reinstalls — that's what made deploys "do nothing" on the phone for hours.
//
// So: no fetch handler at all → every request goes straight to the network.
// On activate we purge any caches a previous (caching) SW left behind. Push
// notification handling is kept intact.

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      // Purge ALL caches from previous caching versions (locals-only-v*).
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

// NOTE: intentionally NO "fetch" listener — the browser fetches everything from
// the network directly, so the UI is always live and never stale.

/** ── Push notifications ── */
self.addEventListener("push", (e) => {
  if (!e.data) return;
  let data;
  try {
    data = e.data.json();
  } catch {
    data = { title: "Oracle", body: e.data.text() };
  }
  const {
    title = "Oracle",
    body = "",
    tag = "default",
    icon = "/icon-192.png",
    data: extra = {},
  } = data;
  e.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((wins) => {
        const focused = wins.some(
          (c) => c.focused || c.visibilityState === "visible",
        );
        if (focused) return;
        return self.registration.showNotification(title, {
          body,
          icon,
          tag,
          badge: "/icon-192.png",
          renotify: true,
          vibrate: [100, 50, 100],
          data: extra,
          requireInteraction: true,
        });
      }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const extra = e.notification.data || {};
  const threadId = extra.threadId || extra.thread || null;
  const target =
    extra.url || (threadId ? "/?thread=" + encodeURIComponent(threadId) : "/");
  e.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((wins) => {
        for (const c of wins) {
          if (c.url.startsWith(self.location.origin) && "focus" in c) {
            c.postMessage({ type: "lo-push-open", threadId, url: target });
            return c.focus();
          }
        }
        if (clients.openWindow) return clients.openWindow(target);
      }),
  );
});
