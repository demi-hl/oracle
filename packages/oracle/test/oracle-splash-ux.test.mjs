import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "public/oracle-splash/index.html"), "utf8");
const variantHtml = ["ice.html", "ivory.html"].map((name) =>
  readFileSync(join(root, "public/oracle-splash/_variants", name), "utf8")
);
const downloads = readFileSync(join(root, "public/oracle-splash/downloads/index.html"), "utf8");
const cliImage = join(root, "public/oracle-splash/assets/cli-chain-hyperliquid.jpg");

test("hero leads with the product shot and the CLI section keeps its full treatment", () => {
  const homeStart = html.indexOf('id="home"');
  const heroEnd = html.indexOf("</section>", homeStart);
  const hero = html.slice(homeStart, heroEnd);
  const cliStart = html.indexOf('id="cli"');
  const cliEnd = html.indexOf("</section>", cliStart);
  const cli = html.slice(cliStart, cliEnd);
  const profilesStart = html.indexOf('id="orchestration"');

  // History: 4156299 put a small CLI preview CARD beside the centered orb, and
  // 5aae5ed removed it the same day because the hero was cramped holding both.
  // The rule was "no duplicate preview card crowding the orb", not "never show
  // the product". The hero now REPLACES the orb as subject with the real shot
  // (orb demoted to backdrop), so the crowding cause is gone. Keep the ban on
  // the old crowding pattern, and require the product-led hero instead.
  assert.doesNotMatch(html, /home-cli-preview/, "the old crowding preview card must not come back");
  // The hero leads with the real recorded CLI session (DEMI, 2026-08-05: "this
  // should be the cli"). That read was WRONG and this assertion is the correction.
  //
  // The hero subject is the rendered orb mark. This has now been decided twice:
  // once in d2476c7 ("orb is the hero mark again") and again on 2026-08-05 ("the
  // orb is supposed to be in the hero the render we had before"). A CLI hero has
  // displaced it both times, so treat this as settled: the recorded session is
  // proof material for the CLI section, the orb is the brand mark up top.
  assert.match(hero, /class="hero-shot hero-shot-orb"/, "hero must lead with the orb mark");
  assert.match(hero, /orb\.webm/, "hero orb must be the rendered orb loop");
  assert.match(hero, /id="orb-still"[^>]*orb-poster\.jpg[^>]*loading="eager"[^>]*fetchpriority="high"/,
    "hero poster must be eager + high priority since it is the LCP element");
  // The poster is the LCP element, so a missing file is a visible black hero,
  // not a cosmetic miss. It shipped broken once (markup referenced
  // orb-poster.jpg while only orb.avif existed) and only a live 404 caught it.
  {
    const poster = new URL("../public/oracle-splash/assets/hero/orb-poster.jpg", import.meta.url);
    const stat = statSync(poster);
    assert.ok(stat.size > 20_000, "orb poster must be a real rendered still, not a placeholder");
  }
  assert.doesNotMatch(hero, /cli-session\.webm/,
    "the CLI recording belongs in the CLI section, not the hero");
  assert.doesNotMatch(hero, /home-title[^>]*>\s*OR<em>ACLE<\/em>/,
    "hero must sell what Oracle does, not just render the wordmark");

  assert.ok(cliStart > heroEnd);
  assert.ok(profilesStart > heroEnd);
  assert.match(cli, /cli-chain-hyperliquid\.jpg/, "CLI section keeps its own full-size visual");
  // The still LEADS this section, not the recording. DEMI, 2026-08-05: "we had
  // that whole tree filled you removed something". The recorded session's
  // `/chain hyperliquid` output is only two lines, so overlaying it on the still
  // hid the `active surface` block -- chain, chain id, agent, HyperCore,
  // HyperEVM -- which is the actual substance of this section. The moving
  // recording lives in the hero, where it plays `scan chains`.
  assert.match(cli, /alt="[^"]*active surface[^"]*"/,
    "the still's alt text must describe the filled active-surface tree it shows");
  // REGRESSION GUARD, broken twice: 357f2fd, then again on 2026-08-05 when the
  // recording was moved into this section after the orb reclaimed the hero.
  // Both times the still was still in the DOM -- it was just covered by a video
  // whose /chain output is 4 lines, hiding the filled `active surface` block
  // (chain, chain id, agent, HyperCore, HyperEVM) that IS this section's proof.
  // Existence is not enough; assert nothing is layered over it.
  assert.doesNotMatch(cli, /<video[^>]*cli-session/,
    "no recording may cover the rich active-surface still in the CLI section");
  assert.match(cli, /cli-chain-hyperliquid\.jpg/,
    "the CLI section leads with the filled active-surface still");
  // The desktop apps now ship as real, published artifacts.
  // The invariant is unchanged in spirit: copy must match what can actually be
  // delivered, so all three platform artifacts must be linked.
  assert.match(html, /Oracle Desktop App/);
  assert.match(downloads, /Oracle-0\.2\.0-arm64\.dmg/);
  assert.match(downloads, /Oracle-0\.2\.0\.AppImage/);
  assert.match(downloads, /Oracle-Setup-0\.2\.0\.exe/);
  assert.doesNotMatch(html, /not yet downloadable/);
  assert.ok(statSync(cliImage).size > 50_000);
});

test("rejected lead and Solana venue wall are removed", () => {
  assert.doesNotMatch(html, /not.{0,24}(?:bot|chatbot)/i);
  assert.doesNotMatch(html, /solana venues routed/i);
  assert.doesNotMatch(html, /id="sol-venue-rail"/);
  assert.doesNotMatch(html, />1DEX</);
});

test("protocol marquee renders logo and version-free protocol name only", () => {
  const nameStart = html.indexOf("function protocolName");
  const renderer = html.slice(nameStart, html.indexOf('document.getElementById("proto-track-a")'));
  const nameSource = html.slice(nameStart, html.indexOf("function chipRow", nameStart));
  const { protocolName, uniqueProtocols } = Function(`${nameSource}; return { protocolName, uniqueProtocols };`)();
  assert.match(renderer, /class="wordmark"/);
  assert.match(renderer, /protocolName\(x\.n\)/);
  assert.doesNotMatch(renderer, /class="cap/);
  assert.doesNotMatch(html, /\.chip \.cap/);
  assert.doesNotMatch(html, /exact proven rungs/i);
  for (const [raw, expected] of [
    ["Uniswap V3", "Uniswap"], ["Aave V2", "Aave"], ["GMX V2", "GMX"],
    ["Pancake V3", "PancakeSwap"], ["NOXA DEX V2", "NOXA"],
    ["Morpho vaults", "Morpho"], ["Morpho Blue", "Morpho"],
    ["Aerodrome Slipstream", "Aerodrome"], ["Kinetiq kmHYPE", "Kinetiq"],
    ["Stable Swap V2", "Stable"]
  ]) {
    assert.equal(protocolName(raw), expected);
    assert.doesNotMatch(protocolName(raw), /\bV\d+\b/i);
  }
  for (const mark of ["uniswap.svg", "aerodrome.svg", "pancakeswap.svg", "morpho.svg", "balancer.svg", "hyperliquid.svg", "gmx.svg", "relay.svg", "odos.svg", "jupiter.svg", "stargate.svg", "velodrome.svg", "hyperswap.svg", "cowswap.svg", "across.svg", "pendle.png", "polymarket.png", "quickswap.png", "lifi.png"]) {
    assert.match(html, new RegExp(`wm: "${mark.replace(".", "\\.")}"`));
  }
  assert.match(html, /\.chip img\.wm\.tall\{[^}]*border-radius:50%/);
  const seen = Object.create(null);
  const rowA = uniqueProtocols([{ n: "Stable Swap V3" }, { n: "Stable Swap V2" }, { n: "Uniswap V3" }], seen);
  const rowB = uniqueProtocols([{ n: "Uniswap V2" }, { n: "Aave V3" }], seen);
  assert.deepEqual(rowA.map((x) => protocolName(x.n)), ["Stable", "Uniswap"]);
  assert.deepEqual(rowB.map((x) => protocolName(x.n)), ["Aave"]);
});

test("every marquee derives duration from one shared pixel velocity", () => {
  assert.match(html, /var MARQUEE_PX_PER_SECOND = 20;/);
  assert.match(html, /var distance = track\.scrollWidth \/ 2;/);
  assert.match(html, /--marquee-duration/);
  assert.doesNotMatch(html, /\.marquee\.rev \.track\{[^}]*animation-duration/);
});

test("every protocol logo reference resolves to a local asset", () => {
  const protocolData = html.slice(html.indexOf("var PROTOS_A"), html.indexOf('var LM = "assets/llms/"'));
  const slugs = [...protocolData.matchAll(/img:\s*"([^"]+)"/g)].map((match) => match[1]);
  const wordmarks = [...protocolData.matchAll(/wm:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(slugs.length > 0);
  assert.ok(wordmarks.length > 0);
  for (const slug of new Set(slugs)) {
    assert.ok(statSync(join(root, "public/oracle-splash/brand", `${slug}.webp`)).size > 0, `missing brand/${slug}.webp`);
  }
  for (const wordmark of new Set(wordmarks)) {
    assert.ok(statSync(join(root, "public/oracle-splash/assets/wordmarks", wordmark)).size > 0, `missing assets/wordmarks/${wordmark}`);
  }
});

test("NFT and Stable route cards remain", () => {
  assert.match(html, /Cross-chain NFTs/);
  assert.match(html, /class="route-card p-stable"/);
});

test("strategy cards are visible with honest posture", () => {
  const start = html.indexOf('id="strategies"');
  const end = html.indexOf('</section>', start);
  const strategies = html.slice(start, end);
  assert.ok(start > 0 && end > start);
  for (const title of [
    "LP rebalancing", "MEV", "Flash loans", "Staking", "Yield",
    "Farming methods", "Delta neutral", "TWAP accumulate &amp; distribute",
    "deBridge · ChangeNOW · LI.FI · revoke.cash", "Live farm discovery",
    "Custom alerts + shadow trading", "Paper-trade until you go live",
  ]) {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(strategies, new RegExp(`<h4>${escaped}</h4>`));
  }
  assert.equal((strategies.match(/class="strategy-card"/g) || []).length, 12);
  assert.doesNotMatch(strategies, /is-roadmap/);
  assert.match(strategies, /live third-party yield data/);
  assert.match(strategies, /Custom alerts and shadow loops notify or simulate first/);
  assert.match(strategies, /live execution still requires arming and a user signature/);
  assert.match(strategies, /Public mode is shadow analysis, not autonomous execution\./);
  assert.match(strategies, /Public live execution remains disabled\./);
  assert.match(strategies, /unsigned preparation/);
  assert.match(html, /href="#strategies">Strategies</);
  assert.doesNotMatch(html, /\+ add agent/i);
});

test("fee section explains builder codes without publishing the builder address", () => {
  const start = html.indexOf('id="fees"');
  const end = html.indexOf("</section>", start);
  const fees = html.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(fees, /builder codes/i);
  assert.match(fees, /Hyperliquid builder fees/);
  assert.match(fees, /wallet approves a 2 bps maximum/i);
  assert.match(fees, /Core perps use 2 bps/i);
  assert.match(fees, /HIP-3 and HIP-4 use 1 bps/i);
  assert.match(fees, /Spot is set to 1 bps but remains inactive/i);
  assert.match(fees, /separate from the 5 bps routed-swap fee/i);
  assert.doesNotMatch(fees, /0x[a-fA-F0-9]{40}/);
});

test("CLI omits the holder banner and route-tree labels stay legible", () => {
  const cliStart = html.indexOf('id="cli"');
  const cliEnd = html.indexOf("</section>", cliStart);
  const cli = html.slice(cliStart, cliEnd);
  assert.doesNotMatch(cli, /cli-install-gate/);
  assert.doesNotMatch(cli, /Holders get 0% Oracle fees/);
  assert.match(html, /\.route-tree text \{ fill:#f4f8fc;/);
  assert.match(html, /\.route-tree rect \{ fill:#111d2b;/);
});

test("inline scripts compile and profile-tree wires retain their reveal animation", () => {
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    assert.doesNotThrow(() => new Function(match[1]));
  }
  assert.match(html, /class="wires multi"/);
  assert.match(html, /\.wires\.in path\{animation:lane-flow/);
  assert.match(html, /querySelectorAll\("\.rv, \.wires"\)/);
});

test("airdrop EV calculator stays removed from the splash", () => {
  assert.doesNotMatch(html, /id="evcalc"/);
  assert.doesNotMatch(html, /Airdrop EV calculator/);
  assert.doesNotMatch(html, /ev-wallets|ev-tasks|ev-hours|ev-rate|ev-gas|ev-bridge|ev-reward|ev-prob|ev-sybil|ev-lockup/);
  assert.doesNotMatch(html, /not a payout promise/i);
  assert.doesNotMatch(html, /No calculator can tell you what an airdrop will pay/);
});

test("the desktop screenshot is a real captured asset with correct intrinsics", () => {
  assert.match(html, /assets\/desktop-app\.jpg/);
  // Intrinsic width/height must match the file on disk or the layout shifts
  // when the lazy image finally loads.
  assert.match(html, /width="1736" height="959"/);
  assert.match(html, /loading="lazy"/);
  // Alt text has to describe the actual product surface, not say "screenshot".
  assert.match(html, /alt="Oracle desktop app showing[^"]+"/);
});

test("holder copy stays fee/rate scoped and does not claim custody enforcement", () => {
  assert.doesNotMatch(html, /Oracle unlocks when/);
  assert.doesNotMatch(html, /Holders get 0% Oracle fees/);
  assert.doesNotMatch(html, /The CLI recognises your agent wallet and applies the holder rate automatically/);
  assert.match(html, /0% for NFT holders/);
  assert.doesNotMatch(html, /security boundary/i);
});

test("the agent section shows prompts, not a CLI recording", () => {
  // The old risk-session video rendered as an almost-empty terminal: one prompt
  // line and dead space. The differentiator is not that Oracle has a CLI --
  // it is that an agent you already use can drive the chain through it.
  assert.doesNotMatch(html, /id="risk-session"/);
  assert.match(html, /class="agent-prompts/);
  // Composers are rebuilt 1:1 in DOM rather than pasted in as screenshots: a
  // 1474px PNG can only ever be downscaled (it rendered at 2.6x shrink, so
  // app-accurate text landed under 6px), while real elements stay crisp at any
  // width. Each panel carries the chrome that identifies its app.
  assert.match(html, /class="agent-panel is-claude"/);
  assert.match(html, /class="agent-panel is-codex"/);
  assert.doesNotMatch(html, /assets\/agents\/\w+\.png/);
  // Claude-specific chrome.
  assert.match(html, /Full access/);
  assert.match(html, /5\.6 Sol/);
  // Codex-specific chrome.
  assert.match(html, /clawd-local/);
  assert.match(html, /Fable 5/);
  assert.match(html, /oracle mcp install/);
  // The headline itself must name the agents. Burying "works in Claude and
  // Codex" in caption text under the cards is how the point got missed.
  const heading = html.slice(html.indexOf('class="section-label rv">Works in any harness'),
                             html.indexOf('class="agent-prompts'));
  assert.match(heading, /Works in any harness/i);
  assert.match(heading, /oracle mcp install/);
  // The install buttons must expose the supported MCP targets directly.
  assert.match(heading, /oracle mcp install claude-code/);
  assert.match(heading, /oracle mcp install chatgpt/);
  assert.match(heading, /oracle mcp install cursor/);
  assert.match(heading, /oracle mcp install claude-desktop/);
  assert.match(heading, /oracle mcp install codex/);
  assert.equal((html.match(/class="agent-panel /g) || []).length, 2);
});

test("the agent cards do not pin live market numbers", () => {
  // A quoted amount is stale the moment it ships: a live check returned 2.624
  // WETH via Curve where a drafted card claimed 2.611 via uniswap-v3. Show the
  // shape of the answer, never a number the page cannot keep true.
  const start = html.indexOf('class="agent-prompts');
  const section = html.slice(start, html.indexOf('class="agent-caption', start));
  assert.doesNotMatch(section, /receive \d+\.\d+ WETH/);
  assert.doesNotMatch(section, /\$\d+(\.\d+)?M/);
  // The custody claim must survive the rewrite.
  assert.match(section, /unsigned/);
  assert.match(section, /your wallet signs/);
});

test("the hero stat row has no dead cells at any width", () => {
  const stats = (html.match(/class="home-stat"/g) || []).length;
  assert.equal(stats, 4);
  assert.match(html, /\.home-stats\{[^}]*grid-template-columns:repeat\(4,/);
  assert.match(html, /@media \(max-width:960px\)\{[^}]*\.home-stats\{grid-template-columns:repeat\(2,/);
});

test("the agent cards animate rather than sitting static", () => {
  // Static text does not read as an agent working. Verified live by sampling
  // the typed length over 30 frames: 0 0 0 6 13 20 27 34 ... with the result
  // revealing at frame 9. The oracle_cli row (and its data-cmd) was removed --
  // the sequence is ask -> result now.
  assert.match(html, /data-agent-seq/);
  assert.match(html, /data-ask=/);
  assert.doesNotMatch(html, /data-cmd=/);
  assert.match(html, /class="agent-caret"/);
  assert.match(html, /class="agent-typed"/);
  assert.match(html, /IntersectionObserver/);
  // Content must survive no-JS and reduced-motion, or the section renders blank.
  assert.match(html, /<noscript>/);
  assert.match(html, /prefers-reduced-motion: reduce/);
});

test("the hero stats match the current catalog and public chain framing", () => {
  const stats = html.slice(html.indexOf('class="home-stats'), html.indexOf('</div>', html.indexOf('hero-chain-count')) + 6);
  assert.match(stats, /id="hero-protocol-count" data-count="110">110</);
  assert.match(stats, /id="hero-provider-count" data-count="70">70</);
  assert.match(stats, /id="hero-op-count" data-count="322">322</);
  assert.match(stats, /id="hero-chain-count">13 \+ EVM</);
  assert.match(stats, /data providers/);
  assert.match(stats, /data operations/);
  assert.doesNotMatch(stats, />49</);
});

test("profile copy names only providers the catalog really has", () => {
  // Naming a provider the repo does not ship is the exact drift the docs gate
  // exists to catch. Verified against listProviders() on 2026-08-06.
  for (const name of ["Babylon", "Lightning", "Sanctum", "Solend", "Kamino", "Meteora", "Jito", "Pyth", "Aave", "Spark", "Beefy", "Symbiotic", "CoW"]) {
    assert.ok(html.includes(name), `splash names ${name} but it must exist in the catalog`);
  }
  // Live API values that cannot be proven from the repo must stay out.
  assert.doesNotMatch(html, /245 liquid-staking/);
  assert.doesNotMatch(html, /Aave across 22 chains/);
});

test("the profile lanes animate rather than sitting as a static diagram", () => {
  // A control plane that never moves reads as a picture of one.
  assert.match(html, /@keyframes lane-flow/);
  assert.match(html, /\.wires\.in path\{animation:lane-flow/);
  assert.match(html, /@keyframes lane-node/);
  // Reduced motion must stop it dead, not just slow it.
  const rm = html.slice(html.indexOf("@keyframes lane-node"));
  assert.match(rm, /prefers-reduced-motion:reduce/);
});

test("every splash variant keeps product access public and omits the removed custody strip", () => {
  for (const surface of [html, ...variantHtml]) {
    assert.doesNotMatch(surface, /holder-gated|Locals Only access|oracle gate status|id="custody"|You keep custody|Multi-wallet|Per-wallet limits|Revoke anytime/i);
    assert.match(surface, /desktop app or public CLI/i);
  }
});
