export const NEXT_STEPS_AFTER_INIT = [
  "oracle data serve          # loopback read/prepare plane on 127.0.0.1:8787",
  "oracle doctor              # verify",
  "oracle chat                # premium oracle chat surface",
  "oracle chain list          # pick hyperliquid/base/solana/...",
  "oracle setup               # telegram/discord/slack messaging",
  "oracle mcp install claude-code",
  "# optional, explicit second step — signing stays a separate local package:",
  "npm i -g @oracle-agent/operator",
  "oracle sign init",
];

export function renderNextSteps() {
  return [
    "",
    "Next:",
    ...NEXT_STEPS_AFTER_INIT.map((l) => "  " + l),
    "",
  ].join("\n");
}

export const DOCTOR_SIGNING_OPTIONAL =
  "signing: not installed (optional) — npm i -g @oracle-agent/operator";
