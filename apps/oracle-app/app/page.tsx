import { AppShell } from "@/components/shell/AppShell";

// Force dynamic render so the no-cache header from next.config applies. A
// statically-prerendered root gets Next's default s-maxage=31536000, which the
// iOS WKWebView caches for a year and never revalidates (stale build on
// refresh). The shell is a thin client wrapper — no SSR data cost.
export const dynamic = "force-dynamic";

export default function Page() {
  return <AppShell />;
}
