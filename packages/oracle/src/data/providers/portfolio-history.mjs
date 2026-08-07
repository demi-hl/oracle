import { constants } from "node:fs";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { portfolioBalance, resolvePortfolioAddresses } from "./portfolio.mjs";
import { nftInventory } from "./nft-portfolio.mjs";

const MAX_HISTORY_BYTES = 10 * 1024 * 1024;
const MAX_HISTORY_LIMIT = 1000;

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundedUsd(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function isoDate(value, label) {
  if (value == null || value === "") return null;
  const time = Date.parse(String(value));
  if (!Number.isFinite(time)) throw new Error(`${label} must be an ISO 8601 timestamp`);
  return new Date(time).toISOString();
}

function boundedInteger(value, fallback, min, max, label) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function canonicalAddresses(addresses = {}) {
  return ["evm", "solana", "bitcoin", "hyperliquid"]
    .map((family) => `${family}:${String(addresses[family] || "").trim().toLowerCase()}`)
    .join("|");
}

export function portfolioIdForAddresses(addresses = {}) {
  const digest = createHash("sha256").update(canonicalAddresses(addresses)).digest("hex").slice(0, 20);
  return `portfolio_${digest}`;
}

export function resolvePortfolioHistoryFile(opts = {}) {
  if (opts.historyFile) return path.resolve(String(opts.historyFile));
  const env = opts.env || process.env;
  if (env.ORACLE_PORTFOLIO_HISTORY_FILE) {
    return path.resolve(String(env.ORACLE_PORTFOLIO_HISTORY_FILE));
  }
  const hermesHome = String(env.HERMES_HOME || "").trim() || path.join(os.homedir(), ".hermes");
  return path.join(path.resolve(hermesHome), "state", "oracle", "portfolio-history.jsonl");
}

function knownLiquidValue(balance) {
  const value = finiteNumber(balance?.valuation?.knownUsd);
  if (value == null) return null;
  if (Number(balance?.valuation?.pricedItems || 0) > 0 || balance?.valuation?.complete === true) {
    return roundedUsd(value);
  }
  return null;
}

function knownNftValue(nfts) {
  if (!nfts || nfts.status === "unavailable" || nfts.status === "not-requested") return null;
  const value = finiteNumber(nfts?.valuation?.estimatedCurrentValueUsd);
  if (value == null) return null;
  if (Number(nfts?.valuation?.valuedItems || 0) > 0 || nfts?.valuation?.complete === true) {
    return roundedUsd(value);
  }
  return null;
}

function liquidBreakdown(balance) {
  const rows = [];
  for (const chain of balance?.chains || []) {
    if (chain.family === "hyperliquid") {
      const spot = (chain.spot?.balances || []).reduce((sum, item) => {
        const value = finiteNumber(item.usdValue);
        return value == null ? sum : sum + value;
      }, 0);
      const perps = finiteNumber(chain.perps?.accountValueUsd);
      const knownUsd = roundedUsd(spot + (perps ?? 0));
      if (knownUsd !== 0 || perps != null || (chain.spot?.balances || []).some((item) => finiteNumber(item.usdValue) != null)) {
        rows.push({ family: "hyperliquid", chainId: null, name: chain.name || "Hyperliquid", knownUsd });
      }
      continue;
    }
    const value = finiteNumber(chain.native?.usdValue);
    if (value == null) continue;
    rows.push({
      family: chain.family || "evm",
      chainId: chain.chainId ?? null,
      name: chain.name || chain.native?.symbol || "Unknown",
      knownUsd: roundedUsd(value),
    });
  }
  return rows;
}

function coverageSummary(balance, nfts, includeNfts) {
  const nftRows = Array.isArray(nfts?.coverage) ? nfts.coverage : [];
  return {
    balances: balance?.coverage || null,
    nfts: {
      requested: includeNfts,
      ok: nftRows.filter((row) => row.status === "ok").length,
      partial: nftRows.filter((row) => row.status === "partial").length,
      unavailable: nftRows.filter((row) => row.status === "unavailable").length,
      notConfigured: nftRows.filter((row) => row.status === "not-configured").length,
      status: !includeNfts
        ? "not-requested"
        : nfts?.status === "unavailable"
          ? "unavailable"
          : nfts?.valuation?.complete
            ? "ok"
            : "partial",
    },
  };
}

async function appendSnapshot(snapshot, opts) {
  const file = resolvePortfolioHistoryFile(opts);
  const line = `${JSON.stringify(snapshot)}\n`;
  if (Buffer.byteLength(line) > 32 * 1024) throw new Error("portfolio history snapshot exceeds 32 KiB");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW || 0);
  const handle = await open(file, flags, 0o600);
  try {
    await handle.writeFile(line, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(file, 0o600);
  return file;
}

export async function portfolioSnapshot(args = {}, opts = {}) {
  const includeNfts = args.includeNfts !== false;
  const balanceImpl = opts.portfolioBalanceImpl || portfolioBalance;
  const nftImpl = opts.nftInventoryImpl || nftInventory;
  const balancePromise = balanceImpl(args, opts);
  const nftsPromise = includeNfts
    ? nftImpl({ ...args, includePnl: false }, opts).catch((error) => ({
        status: "unavailable",
        error: String(error?.message || error).slice(0, 300),
      }))
    : Promise.resolve({ status: "not-requested" });
  const [balance, nfts] = await Promise.all([balancePromise, nftsPromise]);
  const liquidKnownUsd = knownLiquidValue(balance);
  const nftEstimatedValueUsd = knownNftValue(nfts);
  const components = [liquidKnownUsd, nftEstimatedValueUsd].filter((value) => value != null);
  const knownUsd = components.length ? roundedUsd(components.reduce((sum, value) => sum + value, 0)) : null;
  const complete = Boolean(
    balance?.valuation?.complete &&
    (!includeNfts || nfts?.valuation?.complete === true),
  );
  const nowValue = typeof opts.now === "function" ? opts.now() : new Date();
  const recordedAt = new Date(nowValue).toISOString();
  const addresses = balance?.addresses || resolvePortfolioAddresses(args, opts.env || process.env);
  const portfolioId = portfolioIdForAddresses(addresses);
  const warnings = [...(balance?.warnings || [])];
  if (includeNfts && nfts?.status === "unavailable") warnings.push(`NFT inventory unavailable: ${nfts.error}`);
  if (includeNfts && nfts?.valuation && nfts.valuation.complete !== true) {
    warnings.push("NFT estimated value is incomplete and is not an executable bid.");
  }
  const snapshot = {
    schemaVersion: 1,
    id: `snapshot_${randomUUID()}`,
    portfolioId,
    recordedAt,
    sourceQueriedAt: {
      balances: balance?.queriedAt || null,
      nfts: nfts?.generatedAt || null,
    },
    configuredFamilies: Object.fromEntries(
      ["evm", "solana", "bitcoin", "hyperliquid"].map((family) => [family, Boolean(addresses?.[family])]),
    ),
    valuation: {
      knownUsd,
      liquidKnownUsd,
      nftEstimatedValueUsd,
      complete,
      label: complete
        ? "complete known portfolio value"
        : "known priced value, including provider-estimated NFTs when available, not a complete portfolio total",
      liquidPricedItems: Number(balance?.valuation?.pricedItems || 0),
      liquidUnpricedNonzeroItems: Number(balance?.valuation?.unpricedNonzeroItems || 0),
      nftValuedItems: Number(nfts?.valuation?.valuedItems || 0),
      nftUnvaluedItems: Number(nfts?.valuation?.unvaluedItems || 0),
    },
    breakdown: {
      liquid: liquidBreakdown(balance),
      nfts: {
        knownUsd: nftEstimatedValueUsd,
        visibleItems: Number(nfts?.inventory?.visibleCount || 0),
        flaggedItems: Number(nfts?.inventory?.flaggedCount || 0),
      },
    },
    coverage: coverageSummary(balance, nfts, includeNfts),
    warnings: [...new Set(warnings)].slice(0, 50),
  };
  const historyFile = await appendSnapshot(snapshot, opts);
  return {
    provider: "portfolio",
    operation: "snapshot",
    readOnly: true,
    localObservationRecorded: true,
    historyFile,
    snapshot,
    balance,
    nfts,
  };
}

async function readSnapshots(opts) {
  const file = resolvePortfolioHistoryFile(opts);
  try {
    const data = await readFile(file);
    if (data.byteLength > MAX_HISTORY_BYTES) {
      throw new Error(`portfolio history exceeds ${MAX_HISTORY_BYTES} bytes`);
    }
    const snapshots = [];
    let corruptLines = 0;
    for (const line of data.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row?.schemaVersion === 1 && row?.portfolioId && row?.recordedAt) snapshots.push(row);
        else corruptLines += 1;
      } catch {
        corruptLines += 1;
      }
    }
    return { file, snapshots, corruptLines };
  } catch (error) {
    if (error?.code === "ENOENT") return { file, snapshots: [], corruptLines: 0 };
    throw error;
  }
}

function requestedPortfolioId(args, opts) {
  if (args.allPortfolios === true) return null;
  if (args.portfolioId) return String(args.portfolioId);
  const addresses = resolvePortfolioAddresses(args, opts.env || process.env);
  return Object.values(addresses).some(Boolean) ? portfolioIdForAddresses(addresses) : null;
}

export async function portfolioHistory(args = {}, opts = {}) {
  const limit = boundedInteger(args.limit, 100, 1, MAX_HISTORY_LIMIT, "portfolio history limit");
  const order = String(args.order || "desc").toLowerCase();
  if (!new Set(["asc", "desc"]).has(order)) throw new Error("portfolio history order must be asc or desc");
  const since = isoDate(args.since, "portfolio history since");
  const until = isoDate(args.until, "portfolio history until");
  const portfolioId = requestedPortfolioId(args, opts);
  const stored = await readSnapshots(opts);
  let matched = stored.snapshots.filter((row) => {
    if (portfolioId && row.portfolioId !== portfolioId) return false;
    if (since && row.recordedAt < since) return false;
    if (until && row.recordedAt > until) return false;
    return true;
  });
  matched.sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)));
  const totalMatching = matched.length;
  matched = matched.slice(-limit);
  if (order === "desc") matched.reverse();
  const valued = matched.filter((row) => finiteNumber(row?.valuation?.knownUsd) != null);
  return {
    provider: "portfolio",
    operation: "history",
    readOnly: true,
    historyFile: stored.file,
    portfolioId,
    order,
    totalStored: stored.snapshots.length,
    totalMatching,
    corruptLines: stored.corruptLines,
    snapshots: matched,
    stats: {
      returned: matched.length,
      valuedSnapshots: valued.length,
      unpricedSnapshots: matched.length - valued.length,
      firstRecordedAt: matched.length ? [...matched].sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)))[0].recordedAt : null,
      lastRecordedAt: matched.length ? [...matched].sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt))).at(-1).recordedAt : null,
    },
  };
}

function money(value) {
  return `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function sampled(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const output = [];
  for (let i = 0; i < maxPoints; i += 1) {
    output.push(points[Math.round((i * (points.length - 1)) / (maxPoints - 1))]);
  }
  return output;
}

function graphSvg(points, portfolioId) {
  const width = 1200;
  const height = 675;
  const left = 100;
  const right = 1140;
  const top = 100;
  const bottom = 570;
  const values = points.map((point) => point.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const padding = Math.max(1, Math.abs(min) * 0.05);
    min -= padding;
    max += padding;
  } else {
    const padding = (max - min) * 0.1;
    min = Math.max(0, min - padding);
    max += padding;
  }
  const x = (index) => points.length === 1 ? (left + right) / 2 : left + ((right - left) * index) / (points.length - 1);
  const y = (value) => bottom - ((value - min) / (max - min)) * (bottom - top);
  const pathData = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
  const grids = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const yy = top + ratio * (bottom - top);
    const value = max - ratio * (max - min);
    return `<line x1="${left}" y1="${yy}" x2="${right}" y2="${yy}" stroke="#26313c" stroke-width="1"/><text x="${left - 14}" y="${yy + 5}" text-anchor="end" fill="#8795a5" font-size="15">${money(value)}</text>`;
  }).join("");
  const circles = points.map((point, index) => `<circle cx="${x(index)}" cy="${y(point.value)}" r="5" fill="#b8f0ff"><title>${xml(point.recordedAt)}: ${money(point.value)}</title></circle>`).join("");
  const firstDate = xml(points[0].recordedAt.slice(0, 10));
  const lastDate = xml(points.at(-1).recordedAt.slice(0, 10));
  const portfolioLabel = xml(portfolioId || "configured portfolio");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="1200" height="675" fill="#0b1016"/><text x="60" y="50" fill="#f4f7fa" font-size="28" font-family="Inter,Arial,sans-serif" font-weight="700">Oracle Portfolio Value</text><text x="60" y="78" fill="#8795a5" font-size="15" font-family="Inter,Arial,sans-serif">Known priced value, not a complete total unless every snapshot says complete · ${portfolioLabel}</text>${grids}<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="#526171" stroke-width="1"/><path d="${pathData}" fill="none" stroke="#b8f0ff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>${circles}<text x="${left}" y="610" fill="#8795a5" font-size="15">${firstDate}</text><text x="${right}" y="610" text-anchor="end" fill="#8795a5" font-size="15">${lastDate}</text><text x="60" y="650" fill="#526171" font-size="13">NFT values are provider estimates, not executable bids. Unavailable values are omitted, never plotted as zero.</text></svg>`;
}

export async function portfolioValueGraph(args = {}, opts = {}) {
  if (args.allPortfolios === true) {
    throw new Error("portfolio value graph requires one portfolioId or configured public-address portfolio");
  }
  const maxPoints = boundedInteger(args.maxPoints, 200, 2, 500, "portfolio graph maxPoints");
  const history = await portfolioHistory({ ...args, order: "asc", limit: args.limit ?? MAX_HISTORY_LIMIT }, opts);
  if (!history.portfolioId) {
    throw new Error("portfolio value graph requires one portfolioId or configured public-address portfolio");
  }
  const known = history.snapshots
    .map((snapshot) => ({
      recordedAt: snapshot.recordedAt,
      value: finiteNumber(snapshot?.valuation?.knownUsd),
      complete: snapshot?.valuation?.complete === true,
    }))
    .filter((point) => point.value != null);
  if (!known.length) throw new Error("portfolio value graph requires at least one snapshot with known priced value");
  const points = sampled(known, maxPoints);
  const start = points[0].value;
  const end = points.at(-1).value;
  const changeUsd = roundedUsd(end - start);
  const changePct = start === 0 ? null : Number((((end - start) / start) * 100).toFixed(2));
  const svg = graphSvg(points, history.portfolioId);
  return {
    provider: "portfolio",
    operation: "valueGraph",
    readOnly: true,
    portfolioId: history.portfolioId,
    mimeType: "image/svg+xml",
    dataBase64: Buffer.from(svg).toString("base64"),
    byteLength: Buffer.byteLength(svg),
    summary: {
      points: points.length,
      omittedUnavailablePoints: history.snapshots.length - known.length,
      startRecordedAt: points[0].recordedAt,
      endRecordedAt: points.at(-1).recordedAt,
      startKnownUsd: start,
      endKnownUsd: end,
      changeUsd,
      changePct,
      completeSnapshots: points.filter((point) => point.complete).length,
      label: "known priced value history; incomplete snapshots are not complete portfolio totals",
    },
  };
}
