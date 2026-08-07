"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type State<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  updatedAt: string | null;
  reload: () => void;
};

// Fetch an ApiEnvelope route and re-poll on an interval. Honest about errors:
// surfaces the route's own `error` field even when partial `data` is present.
export function usePolling<T>(url: string, intervalMs = 30_000): State<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(
    async (signal?: AbortSignal, force = false) => {
      if (mounted.current) setLoading(true);
      try {
        // A manual refresh appends refresh=1 so a route that server-caches can
        // bust its entry and recompute; interval polls keep the cached value.
        const u = force ? url + (url.includes("?") ? "&" : "?") + "refresh=1" : url;
        const res = await fetch(u, { cache: "no-store", signal });
        const json = (await res.json()) as Record<string, unknown>;
        if (!mounted.current) return;
        // Tolerate both shapes: the ApiEnvelope `{data, fetchedAt}` wrapper and
        // routes that return the payload bare at the top level.
        const enveloped =
          json && typeof json === "object" && "data" in json && "fetchedAt" in json;
        const payload = enveloped ? (json.data as T) : (json as unknown as T);
        setData(payload ?? null);
        setError((json?.error as string | undefined) ?? null);
        setUpdatedAt((json?.fetchedAt as string | undefined) ?? null);
      } catch (e) {
        if (!mounted.current || (e instanceof Error && e.name === "AbortError"))
          return;
        setError("request failed");
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [url],
  );

  useEffect(() => {
    mounted.current = true;
    const ctrl = new AbortController();
    load(ctrl.signal);
    const id = setInterval(() => load(), intervalMs);
    // iOS/Safari freezes setInterval while the WebView is backgrounded, so a
    // returning user can stare at stale data until a hard reload. Re-fetch the
    // instant the tab/app becomes visible or regains focus.
    const onWake = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      mounted.current = false;
      ctrl.abort();
      clearInterval(id);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [load, intervalMs]);

  return { data, error, loading, updatedAt, reload: () => load(undefined, true) };
}

// Optional SSE companion to usePolling. Opens an EventSource and fires `onEvent`
// for each named server event (default "changed"), so a pane can refresh the
// instant the server pushes instead of on the next poll tick. Purely additive:
// usePolling's interval keeps running untouched, so if the browser lacks
// EventSource or the stream errors, the poll still carries the pane. The
// connection is opened once per url and torn down on unmount; EventSource
// auto-reconnects on transient drops, and any gap is covered by the poll.
export function useEventStream(
  url: string,
  onEvent: () => void,
  eventName = "changed",
): void {
  const cb = useRef(onEvent);

  useEffect(() => {
    cb.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    try {
      es = new EventSource(url); // same-origin → bs_token cookie rides along
    } catch {
      return; // no stream available — poll fallback carries the pane
    }
    const handler = () => cb.current();
    es.addEventListener(eventName, handler);
    return () => {
      es?.removeEventListener(eventName, handler);
      es?.close();
    };
  }, [url, eventName]);
}
