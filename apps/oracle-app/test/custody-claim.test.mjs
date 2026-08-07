import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");

const HOME = readFileSync(
  join(appRoot, "components/oracle/OracleHomePane.tsx"),
  "utf8",
);

/**
 * The custody badge drifted once already: the home surface advertised
 * "READ ONLY" while the same app shipped two prepare routes that build unsigned
 * calldata, and while the header chip and /api/health both said
 * prepare-only. An inaccuracy in the SAFE direction is still an inaccuracy —
 * a user who notices the app preparing transactions under a read-only banner
 * has no reason to keep believing the keyless claim, which is true and is the
 * one that matters.
 *
 * These tests pin the claim to what the code actually does.
 */

test("the access badge does not claim the app is read-only", () => {
  assert.ok(
    !/>\s*READ[\s-]?ONLY\s*</i.test(HOME),
    "home surface advertises READ ONLY, but the app prepares unsigned transactions",
  );
});

test("the access badge states the prepare-only posture", () => {
  assert.match(HOME, /PREPARE-ONLY/);
});

test("the app still disclaims signing and broadcasting", () => {
  assert.match(HOME, /never signs or broadcasts/i);
});

/**
 * The swap prepare route used to substitute `?? 50` when the desk omitted a
 * slippage cap, and SwapPane rendered it as "Slippage cap 0.50%" — a protection
 * level no route had quoted, shown in the one field a user reads to decide how
 * much a trade can move against them. The same view already prints "unknown"
 * for a missing price impact, so the fabricated default was also internally
 * inconsistent.
 *
 * Absent quote facts must stay absent all the way to the pixel.
 */
const SWAP_ROUTE = readFileSync(
  join(appRoot, "app/api/oracle/swap/prepare/route.ts"),
  "utf8",
);
const SWAP_PANE = readFileSync(
  join(appRoot, "components/oracle/SwapPane.tsx"),
  "utf8",
);

test("the swap route does not invent a slippage cap", () => {
  assert.ok(
    !/slippageBps[^\n]*\?\?\s*\d/.test(SWAP_ROUTE),
    "swap prepare route substitutes a numeric default for a missing slippage cap",
  );
});

test("a missing slippage cap renders as words, not a number", () => {
  // The guard's intent is that an absent cap must never render as a numeric
  // percentage. Routes report "no cap quoted" as 0, not null, and 0 rendered
  // as "0.00%" reads as a guarantee of zero slippage on the exact field a user
  // checks to judge downside. Both absences must degrade to words.
  assert.match(SWAP_PANE, /slippageBps === null \|\| quote\.slippageBps === 0/);
  assert.match(SWAP_PANE, /"not quoted by route"/);
  assert.ok(
    !/slippageBps === 0[\s\S]{0,60}toFixed/.test(SWAP_PANE),
    "a zero slippage cap still reaches the numeric formatter",
  );
});

test("quote facts the desk may omit are all nullable", () => {
  // If any of these loses `| null`, some surface is free to invent a value.
  for (const field of ["priceImpactPct", "slippageBps", "intentHash", "routeLabel"]) {
    assert.match(
      SWAP_PANE,
      new RegExp(`${field}:\\s*[A-Za-z]+\\s*\\|\\s*null`),
      `${field} must stay nullable so a missing value cannot be fabricated`,
    );
  }
});

/**
 * Findings from the multi-lineage claims audit. Each of these was a case of a
 * surface asserting more than the code knew — the same defect class as the
 * original READ ONLY badge, found in four more places.
 */

test("the desk URL is loopback-bound like the signer", () => {
  // The UI frames swap prepare as a local topology. An off-box desk would ship
  // wallet address, chain, and size to a remote host under that framing.
  assert.match(SWAP_ROUTE, /127\.0\.0\.1/);
  assert.match(SWAP_ROUTE, /localhost/);
  assert.ok(
    !/return new URL\(raw\)\.origin/.test(SWAP_ROUTE),
    "desk URL accepted without a loopback check",
  );
});

test("the brand posture constant matches the rendered posture", () => {
  // Not rendered today, but it is the seed of the exact bug already fixed once.
  const BRAND = readFileSync(join(appRoot, "lib/oracle/brand.ts"), "utf8");
  assert.ok(
    !/posture:\s*"READ[\s-]?ONLY"/i.test(BRAND),
    "brand.ts still carries the READ ONLY posture",
  );
  assert.match(BRAND, /posture:\s*"PREPARE-ONLY"/);
});

test("market health chips do not report yes without evidence", () => {
  const MARKETS = readFileSync(
    join(appRoot, "components/oracle/MarketsPane.tsx"),
    "utf8",
  );
  // The old form defaulted an absent payload to "yes"; only an explicit false
  // showed a problem, so an unreachable service looked reachable on first paint.
  assert.ok(
    !/===\s*false\s*\?\s*"no"\s*:\s*"yes"/.test(MARKETS),
    "an absent health payload still renders as yes",
  );
  assert.match(MARKETS, /"unknown"/);
});

test("an empty approval scan is not labelled Clear", () => {
  const APPROVALS = readFileSync(
    join(appRoot, "components/oracle/ApprovalsPane.tsx"),
    "utf8",
  );
  // Empty means "nothing found in the scanned scope", not "this wallet is safe".
  assert.ok(
    !/return\s+"Clear"/.test(APPROVALS),
    "empty scan state reads as Clear, implying a clean bill of health",
  );
});

test("the home posture line does not overstate what is prepared", () => {
  // Swap prepare returns quote fields; only revoke returns calldata. Saying
  // "prepares unsigned transactions" flatly overclaimed the swap path.
  assert.ok(
    !/prepares unsigned transactions/i.test(HOME),
    "home claims to prepare unsigned transactions, but swap prepare returns a quote",
  );
});

test("receipts are not presented as evaluated policy", () => {
  const RECEIPTS = readFileSync(
    join(appRoot, "components/oracle/ReceiptsPane.tsx"),
    "utf8",
  );
  // Three of the four stamps are architectural constants. "policy pass" invited
  // a user to read a per-intent risk evaluation into a header that ran none.
  assert.ok(
    !/"policy pass"/.test(RECEIPTS),
    "receipt cards still summarise constant stamps as a policy pass",
  );
  assert.ok(
    !/Policy checks/.test(RECEIPTS),
    "receipt detail still labels boundary stamps as policy checks",
  );
  assert.match(RECEIPTS, /Boundary stamps/);
  // The distinction only survives if the kind is actually shown.
  assert.match(RECEIPTS, /check\.kind/);
});

test("the receipts pane does not claim to trail every prepared action", () => {
  const RECEIPTS = readFileSync(
    join(appRoot, "components/oracle/ReceiptsPane.tsx"),
    "utf8",
  );
  // Revoke prepare writes no receipt, and storage caps at MAX_RECEIPTS, so
  // "every prepared action gets a trail" was false on both counts.
  assert.ok(
    !/every prepared action gets a trail/.test(RECEIPTS),
    "receipts claim a complete trail while revoke prepares are never recorded",
  );
  assert.match(RECEIPTS, /revoke prepares are not/i);
});

/**
 * Campaigns are the surface most likely to make someone walk away expecting to
 * be told something. This app has no scheduler, no watcher, and no Notification
 * path, so nothing here can ever fire an alert.
 */
test("campaigns do not promise notifications this app cannot deliver", () => {
  const CAMPAIGNS = readFileSync(
    join(appRoot, "components/oracle/CampaignsPane.tsx"),
    "utf8",
  );
  assert.ok(
    !/Notify when the trigger matches/.test(CAMPAIGNS),
    "campaign builder promises a notification with no notifier behind it",
  );
  assert.match(CAMPAIGNS, /does not watch or notify/i);
});

test("a stored campaign is not displayed as actively watching", () => {
  const CAMPAIGNS = readFileSync(
    join(appRoot, "components/oracle/CampaignsPane.tsx"),
    "utf8",
  );
  // The stored enum stays `watching` for downstream runtimes; the UI must not
  // render that word, because nothing in this app watches anything.
  assert.match(CAMPAIGNS, /function statusLabel/);
  assert.match(CAMPAIGNS, /statusLabel\(status\)/);
});

test("no app surface tells the user to arm from chat", () => {
  const SWAP = readFileSync(join(appRoot, "components/oracle/SwapPane.tsx"), "utf8");
  // Arming happens on the signer host. On a chat-shaped product, "arm it from
  // chat" reads as though this surface could do it.
  assert.ok(
    !/Arm it from chat/i.test(SWAP),
    "swap pane implies the app can arm the signer",
  );
});

test("the home approval count does not double-count operator grants", () => {
  // operatorCount is a subset of unlimitedCount, so summing them inflated the
  // exposure figure by one per blanket NFT operator.
  assert.ok(
    !/operators\s*\+\s*unlimited/.test(HOME),
    "home strip sums operatorCount and unlimitedCount, double-counting NFT operators",
  );
});

/**
 * Findings from the GPT lane. Each is a surface presenting a partial or
 * unverified result as a settled one.
 */

test("a truncated or screened portfolio is not reported as complete", () => {
  const ROUTE = readFileSync(
    join(appRoot, "app/api/oracle/portfolio/route.ts"),
    "utf8",
  );
  // The route drops rows over a per-chain cap and excludes implausible rows,
  // then reported complete:true anyway, so the pane could say "All positions
  // priced" about a total that omitted real positions.
  //
  // Assert against the `complete:` expression itself. `capped.truncated`
  // appears elsewhere in the file (it is also reported under `pruning`), so a
  // whole-file match would still pass with the clause deleted from the flag.
  const completeExpr = ROUTE.match(
    /valueUsd:\s*knownValue\(rows\),\s*complete:\s*([\s\S]*?),\n\s*assetCount:/,
  );
  assert.ok(completeExpr, "could not locate the totals.complete expression");
  assert.match(completeExpr[1], /capped\.truncated === 0/);
  assert.match(completeExpr[1], /screened\.suspectCount === 0/);
});

test("the portfolio pane can render the omissions the route discloses", () => {
  const PANE = readFileSync(
    join(appRoot, "components/oracle/PortfolioPane.tsx"),
    "utf8",
  );
  // The payload type omitted these, so the disclosures were unreachable.
  assert.match(PANE, /pruning\?:/);
  assert.match(PANE, /integrity\?:/);
  assert.match(PANE, /per-chain cap/);
  assert.match(PANE, /suspect excluded/);
});

test("the signer bridge demands a named service, not a shaped body", () => {
  const SIGNER = readFileSync(
    join(appRoot, "app/api/oracle/signer/route.ts"),
    "utf8",
  );
  // Accepting any loopback JSON with an `armed` boolean let an unrelated local
  // service be displayed as a reachable, ARMED signer.
  assert.ok(
    !/typeof body\.armed === "boolean"/.test(SIGNER),
    "signer identity still accepts any body carrying an armed flag",
  );
  assert.match(SIGNER, /oracle-signer/);
});

test("the swap desk has no default that cannot serve prepare", () => {
  // 8799 is the shipped public server; its route table has no /swap/prepare,
  // so defaulting there 404s every quote behind a working-looking UI.
  assert.ok(
    !/DEFAULT_DESK_URL/.test(SWAP_ROUTE),
    "swap route still defaults to a desk that does not implement prepare",
  );
  assert.match(SWAP_ROUTE, /not configured/i);
});

test("receipts do not label hardcoded planes as allowlist hits", () => {
  const RECEIPTS = readFileSync(
    join(appRoot, "components/oracle/ReceiptsPane.tsx"),
    "utf8",
  );
  assert.ok(
    !/>Allowlist hits</.test(RECEIPTS),
    "receipt detail still calls two constant strings allowlist hits",
  );
  assert.match(RECEIPTS, /Architecture planes/);
});

/**
 * The badge is only honest while the app has no route that signs, broadcasts,
 * or arms. If someone adds one, the wording has to be revisited — so assert the
 * shape of the API surface rather than trusting the copy to stay true.
 */
test("the app exposes no signing, broadcast, or arm route", () => {
  const apiRoot = join(appRoot, "app/api");

  const routes = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts") routes.push(full);
    }
  };
  walk(apiRoot);

  const mutating = routes.filter((path) =>
    /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)/.test(
      readFileSync(path, "utf8"),
    ),
  );

  // Every mutating route must be a /prepare endpoint. Prepare returns an
  // unsigned artifact; it never moves value on its own.
  for (const path of mutating) {
    assert.ok(
      path.includes(`${"/"}prepare${"/"}`),
      `unexpected mutating route outside prepare: ${path}`,
    );
  }

  // Name-based gating is not enough on its own: a route called /prepare/ could
  // still sign or broadcast. Assert the prepare routes emit the keyless
  // contract and never reference a signing/broadcast primitive.
  for (const path of mutating) {
    const src = readFileSync(path, "utf8");
    assert.match(src, /backendSigner:\s*false/, `${path} omits backendSigner:false`);
    assert.match(
      src,
      /requiresWalletSignature:\s*true/,
      `${path} omits requiresWalletSignature:true`,
    );
    assert.ok(
      !/\b(sendTransaction|signTransaction|signTypedData|eth_sendRawTransaction|privateKey|PRIVATE_KEY|Wallet\.fromPhrase|mnemonic)\b/.test(src),
      `${path} references a signing or broadcast primitive`,
    );
  }
});

test("the signer bridge is read-only and loopback-bound", () => {
  const signer = readFileSync(
    join(appRoot, "app/api/oracle/signer/route.ts"),
    "utf8",
  );

  // Status only. A POST here would turn the public app into an arm surface.
  assert.ok(
    !/export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)/.test(signer),
    "signer route must expose status only, never a mutating call",
  );

  // A signer reachable off-box is a different product with a different claim.
  assert.match(signer, /127\.0\.0\.1/);
  assert.match(signer, /localhost/);
});

test("the pane prefers the formatted buy amount over raw base units", () => {
  assert.match(SWAP_PANE, /quote\.buyAmountFormatted \?\? formatAmount\(quote\.buyAmount\)/);
});
