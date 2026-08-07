import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(appDir, "../..");

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Camera, microphone, and geolocation are all denied outright: nothing in the
  // public app uses them, so the browser should refuse at the platform level
  // rather than fall back to a permission prompt that injected script could
  // trigger. `microphone=()` was briefly relaxed to `(self)` for on-device
  // dictation; the feature was dropped rather than keep the weaker header on a
  // public surface.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  output: process.env.ORACLE_DESKTOP_BUILD === "1" ? "standalone" : undefined,
  transpilePackages: ["@oracle-agent/contract", "@oracle-agent/oracle"],
  turbopack: {
    root: monorepoRoot,
  },
  outputFileTracingRoot: monorepoRoot,
  outputFileTracingExcludes: {
    "*": [".next/**", "dist/**", "release/**"],
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] },
    ];
  },
};

export default nextConfig;
