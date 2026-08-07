// Raster-only NFT contact sheets returned as SVG image content.

import { timed } from "../http.mjs";

const ALLOWED_IMAGE_HOSTS = Object.freeze([
  "i.seadn.io",
  "openseauserdata.com",
  "arweave.net",
  "ipfs.io",
  "nftstorage.link",
  "dweb.link",
  "cloudflare-ipfs.com",
  "ordinals.com",
  "ordinals.g.com",
  "cdn.helius-rpc.com",
  "shdw-drive.genesysgo.net",
]);

const RASTER_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

function allowedHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return ALLOWED_IMAGE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function gatewayUrl(value) {
  const text = String(value || "").trim();
  if (text.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${text.slice(7).replace(/^ipfs\//, "")}`;
  if (text.startsWith("ar://")) return `https://arweave.net/${text.slice(5)}`;
  return text;
}

function safeImageUrl(value) {
  const text = gatewayUrl(value);
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || !allowedHost(url.hostname)) return null;
  return url;
}

async function fetchRaster(value, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("gallery fetch unavailable");
  let url = safeImageUrl(value);
  if (!url) throw new Error("image host is not on the raster gallery allowlist");
  const maxBytes = Math.min(Math.max(Number(opts.maxImageBytes ?? 1_500_000), 50_000), 4_000_000);

  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const attempt = await timed(() => fetchImpl(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { accept: "image/jpeg,image/png,image/webp" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
    }));
    if (!attempt.ok) throw new Error(attempt.error);
    const response = attempt.data;
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get?.("location");
      if (!location) throw new Error("image redirect missing location");
      const next = safeImageUrl(new URL(location, url).toString());
      if (!next) throw new Error("image redirect left the host allowlist");
      url = next;
      continue;
    }
    if (!response.ok) throw new Error(`image HTTP ${response.status}`);
    const mimeType = String(response.headers?.get?.("content-type") || "").split(";", 1)[0].toLowerCase();
    if (!RASTER_MIME.has(mimeType)) throw new Error(`unsafe or unsupported image type ${mimeType || "unknown"}`);
    const length = Number(response.headers?.get?.("content-length") || 0);
    if (length > maxBytes) throw new Error("image exceeds gallery byte cap");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > maxBytes) throw new Error("image exceeds gallery byte cap");
    return { mimeType, data: bytes.toString("base64"), sourceUrl: url.toString(), bytes: bytes.length };
  }
  throw new Error("too many image redirects");
}

function xml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function label(item, index) {
  return item.name || item.collection || item.tokenId || `NFT ${index + 1}`;
}

export async function nftGallery(args = {}, opts = {}) {
  const allItems = Array.isArray(args.items) ? args.items : [];
  if (!allItems.length) throw new Error("nft gallery requires inventory items");
  const pageSize = Math.min(Math.max(Number(args.pageSize ?? 12) || 12, 1), 12);
  const page = Math.max(Number(args.page ?? 1) || 1, 1);
  const totalPages = Math.max(Math.ceil(allItems.length / pageSize), 1);
  if (page > totalPages) throw new Error(`nft gallery page ${page} exceeds ${totalPages}`);
  const items = allItems.slice((page - 1) * pageSize, page * pageSize);
  const loaded = [];
  let totalBytes = 0;
  const maxTotalBytes = Math.min(Math.max(Number(args.maxTotalBytes ?? 8_000_000), 250_000), 12_000_000);

  for (const item of items) {
    if (totalBytes >= maxTotalBytes) {
      loaded.push({ item, image: null, error: "gallery page byte cap reached" });
      continue;
    }
    try {
      const image = await fetchRaster(item.imageUrl || item.originalImageUrl, {
        ...opts,
        maxImageBytes: Math.min(Number(args.maxImageBytes ?? 1_500_000), maxTotalBytes - totalBytes),
      });
      totalBytes += image.bytes;
      loaded.push({ item, image, error: null });
    } catch (error) {
      loaded.push({ item, image: null, error: String(error?.message || error).slice(0, 180) });
    }
  }

  const columns = 3;
  const tileWidth = 340;
  const tileHeight = 400;
  const headerHeight = 76;
  const rows = Math.ceil(items.length / columns);
  const width = columns * tileWidth;
  const height = headerHeight + rows * tileHeight;
  const body = loaded.map(({ item, image, error }, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = column * tileWidth;
    const y = headerHeight + row * tileHeight;
    const art = image
      ? `<image x="${x + 14}" y="${y + 14}" width="312" height="312" preserveAspectRatio="xMidYMid slice" href="data:${image.mimeType};base64,${image.data}"/>`
      : `<rect x="${x + 14}" y="${y + 14}" width="312" height="312" rx="14" fill="#151820"/><text x="${x + 170}" y="${y + 165}" text-anchor="middle" fill="#76808f" font-size="16">image unavailable</text>`;
    const title = xml(label(item, index).slice(0, 34));
    const chain = xml(item.chain || "unknown chain");
    return `${art}<text x="${x + 16}" y="${y + 350}" fill="#f3f5f7" font-size="17" font-weight="600">${title}</text><text x="${x + 16}" y="${y + 376}" fill="#8d98a8" font-size="13">${chain}${error ? " · placeholder" : ""}</text>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#090b10"/><text x="24" y="34" fill="#ffffff" font-size="24" font-weight="700">NFT INVENTORY</text><text x="24" y="58" fill="#8d98a8" font-size="14">page ${page} of ${totalPages} · ${allItems.length} assets · generated ${xml(new Date().toISOString())}</text>${body}</svg>`;

  return {
    provider: "nft-portfolio",
    operation: "gallery",
    mimeType: "image/svg+xml",
    dataBase64: Buffer.from(svg).toString("base64"),
    page,
    pageSize,
    totalPages,
    totalItems: allItems.length,
    renderedItems: loaded.filter((row) => row.image).length,
    placeholders: loaded.filter((row) => !row.image).map((row) => ({
      assetKey: row.item.assetKey || null,
      name: row.item.name || null,
      sourceUrl: row.item.imageUrl || null,
      error: row.error,
    })),
    rasterOnly: true,
    externalScripts: false,
  };
}
