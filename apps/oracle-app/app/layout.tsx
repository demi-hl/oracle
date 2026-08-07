import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "@/components/shell/Providers";
import { Backdrop } from "@/components/shell/Backdrop";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_ORACLE_SITE_URL ?? "https://oracle.demi.la"),
  title: "Oracle",
  description:
    "A keyless public Oracle app for multichain reads, route intelligence, and prepare-only actions.",
  applicationName: "Oracle",
  manifest: "/manifest.webmanifest",
  openGraph: {
    title: "Oracle",
    description:
      "A keyless public Oracle app for multichain reads, route intelligence, and prepare-only actions.",
    siteName: "Oracle",
    type: "website",
    images: [{ url: "/icon-512.png", width: 512, height: 512, alt: "Oracle" }],
  },
  twitter: {
    card: "summary",
    title: "Oracle",
    description:
      "A keyless public Oracle app for multichain reads, route intelligence, and prepare-only actions.",
    images: ["/icon-512.png"],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Oracle",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0B1018",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * Pre-mount theme boot. Runs synchronously before first paint (first child of
 * <body>) so a non-default stored theme paints its canvas + text immediately
 * with no flash of Oracle navy. ThemeProvider applies the full theme on mount.
 * Keep the palette map in sync with lib/themes/presets.ts.
 */
const THEME_BOOT = `(function(){try{
var alias={"lens-5i":"nous-blue"};
var k=localStorage.getItem("oracle-theme")||"default";k=alias[k]||k;
var P={
"default":["#0B1018","#7CC4FF","#ffffff",0],
"default-large":["#0B1018","#7CC4FF","#ffffff",0],
"nous-blue":["#170d02","#FFAC02","#FFFFFF",1],
"midnight":["#0a0a1f","#d4c8ff","#ffffff",0],
"ember":["#1a0a06","#ffd8b0","#ffffff",0],
"mono":["#0e0e0e","#eaeaea","#ffffff",0],
"cyberpunk":["#040608","#9bffcf","#ffffff",0],
"rose":["#1a0f15","#ffd4e1","#ffffff",0]};
var p=P[k]||P["default"];var r=document.documentElement,s=r.style;
s.setProperty("--background-base",p[0]);
s.setProperty("--background","color-mix(in srgb, "+p[0]+" 100%, transparent)");
s.setProperty("--midground-base",p[1]);
s.setProperty("--midground","color-mix(in srgb, "+p[1]+" 100%, transparent)");
s.setProperty("--foreground-base",p[2]);
s.setProperty("--foreground","color-mix(in srgb, "+p[2]+" "+(p[3]*100)+"%, transparent)");
s.setProperty("--foreground-alpha",String(p[3]));
var bg=(localStorage.getItem("oracle-bg")||"").trim();
if(bg){s.setProperty("--background-base",bg);s.setProperty("--background","color-mix(in srgb, "+bg+" 100%, transparent)");s.setProperty("--background-alpha","1");}
}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <Providers>
          <Backdrop />
          {children}
        </Providers>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
