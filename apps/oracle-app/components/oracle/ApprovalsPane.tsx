"use client";

import { useEffect, useMemo, useState } from "react";
import { usePolling } from "@/components/usePolling";
import { RefreshIcon } from "@/components/panes/parts";
import { haptic } from "@/components/shell/haptics";
import {
  ORACLE_CHAIN_BY_ID,
  ORACLE_DATA_PLANE,
  ORACLE_SIGNER_CONTRACT,
  type OracleApproval,
  type OracleApprovalRisk,
  type OracleRevokePrepareResponse,
} from "@oracle-agent/contract";
import { OracleMark } from "./OracleMark";
import { decodeCalldata, describesRevoke } from "./calldataDecode.mjs";

type ScanState = "available" | "empty" | "degraded" | "unavailable" | "unconfigured";

interface ApprovalChain {
  id: string;
  label: string;
  shortLabel: string;
  accent: string;
  chainId: number | null;
  state: ScanState;
  approvalCount: number;
}

interface ApprovalsPayload {
  configured: boolean;
  reachable: boolean;
  error: string | null;
  fetchedAt: string;
  owner: string | null;
  scannedRange: string | null;
  totals: {
    approvalCount: number;
    unlimitedCount: number;
    staleCount: number;
    chainsScanned: number;
  };
  approvals: OracleApproval[];
  chains: ApprovalChain[];
  custody: { requiresWalletSignature: boolean; backendSigner: boolean };
}

function truncate(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function riskLabel(risk: OracleApprovalRisk): string {
  if (risk === "operator-all") return "Entire collection";
  if (risk === "unlimited") return "Unlimited";
  if (risk === "stale") return "Stale";
  if (risk === "unknown-spender") return "Unknown spender";
  return "Scoped";
}

function riskColor(risk: OracleApprovalRisk): string {
  // Operator grants read hottest: they are uncapped across every item held.
  if (risk === "operator-all") return "#E98791";
  if (risk === "unlimited") return "#F3C879";
  if (risk === "stale") return "#E9C081";
  if (risk === "unknown-spender") return "#E98791";
  return "rgba(221,241,255,.44)";
}

function stateColor(state: ScanState): string {
  if (state === "available") return "#8FE3C7";
  if (state === "empty") return "rgba(221,241,255,.4)";
  if (state === "degraded") return "#F3C879";
  if (state === "unavailable") return "#E98791";
  return "rgba(124,196,255,.36)";
}

function stateLabel(state: ScanState): string {
  if (state === "available") return "Scanned";
  if (state === "empty") return "None found";
  if (state === "degraded") return "Partial";
  if (state === "unavailable") return "Scan unavailable";
  return "Not connected";
}

function RevokeSheet({ approval, onClose }: { approval: OracleApproval; onClose: () => void }) {
  const [prepared, setPrepared] = useState<OracleRevokePrepareResponse | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [copied, setCopied] = useState(false);
  const chain = ORACLE_CHAIN_BY_ID[approval.chainId];

  const prepare = async () => {
    setPreparing(true);
    try {
      const response = await fetch(ORACLE_SIGNER_CONTRACT.routes.prepareRevoke.path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainId: approval.chainId,
          token: approval.token,
          spender: approval.spender,
          standard: approval.standard,
        }),
      });
      setPrepared((await response.json()) as OracleRevokePrepareResponse);
    } catch {
      setPrepared({
        configured: true,
        reachable: false,
        error: "Revoke preparation failed to reach Oracle",
        transaction: null,
        intentHash: null,
        requiresWalletSignature: true,
        backendSigner: false,
      });
    } finally {
      setPreparing(false);
    }
  };

  const copyIntent = async () => {
    if (!prepared?.transaction) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(prepared.transaction, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-[#05080C]/78 sm:place-items-center" role="dialog" aria-modal="true" aria-label="Prepare revoke">
      <div className="max-h-[92dvh] w-full max-w-lg overflow-y-auto border-t border-[#7CC4FF]/18 bg-[#0B1018] sm:border">
        <header className="flex items-start justify-between gap-4 border-b border-[#7CC4FF]/10 px-5 py-4">
          <div className="min-w-0">
            <div className="font-mono-ui text-[0.5rem] uppercase tracking-[0.18em] text-[#7CC4FF]/52">Review approval</div>
            <h2 className="mt-1 truncate text-[0.95rem] font-medium text-[#EEF8FF]">
              {approval.tokenSymbol ?? truncate(approval.token)} · {chain?.shortLabel ?? approval.chainId}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 border border-[#7CC4FF]/16 px-2.5 py-1 font-mono-ui text-[0.5rem] uppercase tracking-[0.13em] text-[#7CC4FF]/62"
          >
            Close
          </button>
        </header>

        <dl className="divide-y divide-[#7CC4FF]/8">
          {[
            ["Token", approval.token],
            ["Spender", approval.spenderLabel ? `${approval.spenderLabel} · ${approval.spender}` : approval.spender],
            ["Allowance", approval.allowanceDisplay],
            ["Risk", riskLabel(approval.risk)],
            ["Last activity", approval.lastActivityAt ?? "Not reported"],
          ].map(([label, value]) => (
            <div key={label} className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 px-5 py-3">
              <dt className="font-mono-ui text-[0.5rem] uppercase tracking-[0.13em] text-[#7CC4FF]/44">{label}</dt>
              <dd className="break-all font-mono-ui text-[0.66rem] text-[#DDF1FF]/82">{value}</dd>
            </div>
          ))}
        </dl>

        <div className="border-t border-[#7CC4FF]/10 px-5 py-4">
          {!prepared ? (
            <>
              <p className="text-[0.7rem] leading-relaxed text-[#DDF1FF]/50">
                Oracle builds unsigned{" "}
                <span className="font-mono-ui">
                  {approval.standard === "erc721" ? "setApprovalForAll(operator, false)" : "approve(spender, 0)"}
                </span>{" "}
                calldata. It does not sign and does not broadcast. Your wallet reviews and submits it.
              </p>
              <button
                type="button"
                disabled={preparing}
                onClick={() => { void haptic(6); void prepare(); }}
                className="mt-4 min-h-11 w-full bg-[#7CC4FF] px-4 font-mono-ui text-[0.6rem] font-semibold uppercase tracking-[0.14em] text-[#0B1018] disabled:opacity-40"
              >
                {preparing ? "Preparing…" : "Prepare revoke"}
              </button>
            </>
          ) : prepared.transaction ? (
            <>
              <div className="flex items-center gap-2 font-mono-ui text-[0.53rem] uppercase tracking-[0.14em] text-[#8FE3C7]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#8FE3C7]" />
                Unsigned · ready for your wallet
              </div>
              <CalldataReview data={prepared.transaction.data} to={prepared.transaction.to} token={approval.token} />
              <pre className="mt-3 max-h-52 overflow-auto border border-[#7CC4FF]/12 bg-[#080D13] p-3 font-mono-ui text-[0.6rem] leading-relaxed text-[#DDF1FF]/78">
{JSON.stringify(prepared.transaction, null, 2)}
              </pre>
              <div className="mt-2 font-mono-ui text-[0.5rem] uppercase tracking-[0.12em] text-[#7CC4FF]/40">
                Intent {prepared.intentHash} · backend signer {String(prepared.backendSigner)}
              </div>
              <button
                type="button"
                onClick={() => { void haptic(5); void copyIntent(); }}
                className="mt-3 min-h-10 w-full border border-[#7CC4FF]/28 px-4 font-mono-ui text-[0.56rem] uppercase tracking-[0.13em] text-[#7CC4FF]"
              >
                {copied ? "Copied" : "Copy unsigned transaction"}
              </button>
              <p className="mt-3 text-[0.66rem] leading-relaxed text-[#DDF1FF]/44">
                Revoke prepared · awaiting wallet. This allowance stays active until your wallet submits the transaction
                and a later read shows zero.
              </p>
            </>
          ) : (
            <div className="border border-[#E98791]/22 bg-[#E98791]/[0.05] px-3.5 py-3 text-[0.68rem] text-[#F4B8BE]">
              {prepared.error ?? "Revoke preparation was not returned"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ApprovalRow({ approval, onReview }: { approval: OracleApproval; onReview: () => void }) {
  const chain = ORACLE_CHAIN_BY_ID[approval.chainId];
  return (
    <button
      type="button"
      onClick={() => { void haptic(5); onReview(); }}
      className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[#7CC4FF]/8 px-3.5 py-3 text-left transition-colors last:border-b-0 hover:bg-[#7CC4FF]/[0.035] sm:px-4"
      style={{ boxShadow: chain ? `inset 1px 0 0 ${chain.accent}88` : undefined }}
    >
      <div className="min-w-0">
        <div className="truncate text-[0.78rem] font-medium text-[#DDF1FF]">
          {approval.tokenSymbol ?? truncate(approval.token)}
          <span className="ml-2 font-mono-ui text-[0.55rem] text-[#7CC4FF]/44">{chain?.shortLabel ?? approval.chainId}</span>
        </div>
        <div className="mt-0.5 truncate font-mono-ui text-[0.53rem] uppercase tracking-[0.1em] text-[#7CC4FF]/42">
          {approval.spenderLabel ?? truncate(approval.spender)}
        </div>
      </div>
      <div className="text-right">
        <div className="font-mono-ui text-[0.7rem]" style={{ color: approval.unlimited ? "#F3C879" : "#E9F7FF" }}>
          {approval.allowanceDisplay}
        </div>
        <div className="mt-0.5 font-mono-ui text-[0.5rem] uppercase tracking-[0.11em]" style={{ color: riskColor(approval.risk) }}>
          {riskLabel(approval.risk)}
        </div>
      </div>
    </button>
  );
}

/**
 * Describe what the scan actually covered.
 *
 * An empty approval list is the most dangerous state in this pane: it reads as
 * "you are safe" when it only means "nothing was found in this scope". Stating
 * the scope as the primary result keeps the limit in front of the user instead
 * of in a footnote they will skip.
 */
function scopeSummary(payload: ApprovalsPayload): string {
  const scanned = payload.totals.chainsScanned;
  if (scanned === 0) return "No chains could be scanned";
  const chainWord = scanned === 1 ? "chain" : "chains";
  return `Found nothing on ${scanned} scanned ${chainWord}. Other chains, tokens, and spenders were not checked.`;
}

/**
 * Show what the bytes actually say, not what we meant them to say.
 *
 * The label next to a hex blob is generated from the same inputs as the blob,
 * so a bad encoder produces a confidently wrong label. Decoding the emitted
 * calldata independently is the only way the two can disagree and get caught.
 * If they disagree, the user is warned instead of reassured.
 */
function CalldataReview({ data, to, token }: { data: string; to: string; token: string }) {
  const decoded = decodeCalldata(data);

  if (!decoded.ok) {
    return (
      <div className="mt-3 border border-[#E98791]/24 bg-[#E98791]/[0.05] px-3 py-2.5">
        <div className="font-mono-ui text-[0.5rem] uppercase tracking-[0.13em] text-[#F4B8BE]">
          Could not decode this transaction
        </div>
        <p className="mt-1 text-[0.66rem] leading-relaxed text-[#DDF1FF]/60">
          Do not sign it. Oracle prepared bytes it cannot read back ({decoded.reason}).
        </p>
      </div>
    );
  }

  const isRevoke = describesRevoke(decoded);
  const wrongTarget = to.toLowerCase() !== token.toLowerCase();
  const suspect = !isRevoke || wrongTarget;

  return (
    <div
      className="mt-3 border px-3 py-2.5"
      style={{
        borderColor: suspect ? "rgba(233,135,145,.34)" : "rgba(124,196,255,.16)",
        background: suspect ? "rgba(233,135,145,.05)" : "rgba(13,20,30,.7)",
      }}
    >
      <div
        className="font-mono-ui text-[0.5rem] uppercase tracking-[0.13em]"
        style={{ color: suspect ? "#F4B8BE" : "rgba(124,196,255,.55)" }}
      >
        {suspect ? "Review carefully before signing" : "Decoded from the calldata"}
      </div>
      <p className="mt-1.5 text-[0.7rem] leading-relaxed text-[#DDF1FF]/76">{decoded.summary}</p>
      {wrongTarget && (
        <p className="mt-1.5 text-[0.66rem] leading-relaxed text-[#F4B8BE]">
          This transaction targets {to}, not the token you selected.
        </p>
      )}
      {!isRevoke && (
        <p className="mt-1.5 text-[0.66rem] leading-relaxed text-[#F4B8BE]">
          These bytes do not revoke anything.
        </p>
      )}
    </div>
  );
}

/** Read-only approval review with unsigned, wallet-signed revoke preparation. */
export function ApprovalsPane() {
  const [localEvm, setLocalEvm] = useState("");
  const [active, setActive] = useState<OracleApproval | null>(null);
  const [showClear, setShowClear] = useState(false);

  useEffect(() => {
    setLocalEvm(window.localStorage.getItem("oracle-portfolio-evm") ?? "");
  }, []);

  const base = ORACLE_DATA_PLANE.routes.approvals.path;
  const endpoint = localEvm ? `${base}?evm=${encodeURIComponent(localEvm)}` : base;
  const poll = usePolling<ApprovalsPayload>(endpoint, 90_000);
  const payload = poll.data;

  const chains = useMemo(() => payload?.chains ?? [], [payload?.chains]);
  const problemChains = useMemo(
    () => chains.filter((chain) => chain.state === "degraded" || chain.state === "unavailable"),
    [chains],
  );
  const quietChains = useMemo(
    () => chains.filter((chain) => chain.state === "empty" || chain.state === "unconfigured"),
    [chains],
  );

  return (
    <section className="relative min-h-full bg-[#0B1018] text-[#DDF1FF]">
      <div className="relative mx-auto w-full max-w-[1080px] px-3 pb-10 pt-3 sm:px-5 lg:px-7 lg:pt-5">
        <header className="flex items-center gap-3 border-b border-[#7CC4FF]/10 pb-3">
          <OracleMark size={34} />
          <div className="min-w-0">
            <div className="font-mono-ui text-[0.52rem] uppercase tracking-[0.19em] text-[#7CC4FF]/46">Approvals</div>
            <h1 className="mt-0.5 truncate text-[0.9rem] font-medium text-[#EAF7FF]">What can spend your tokens</h1>
          </div>
          <button
            type="button"
            onClick={() => { void haptic(5); poll.reload(); }}
            aria-label="Refresh approvals"
            className="ml-auto grid h-8 w-8 place-items-center rounded-full border border-[#7CC4FF]/12 text-[#7CC4FF]/58 hover:border-[#7CC4FF]/32 hover:text-[#7CC4FF]"
          >
            <span className={poll.loading ? "animate-spin" : ""}><RefreshIcon width={14} height={14} /></span>
          </button>
        </header>

        <div className="mt-4 grid grid-cols-3 border border-[#7CC4FF]/12 bg-[#0D141E]/86">
          {[
            ["Approvals", payload?.reachable ? String(payload.totals.approvalCount) : "—"],
            ["Unlimited", payload?.reachable ? String(payload.totals.unlimitedCount) : "—"],
            ["Chains scanned", payload?.reachable ? String(payload.totals.chainsScanned) : "—"],
          ].map(([label, value]) => (
            <div key={label} className="flex min-h-[84px] flex-col items-center justify-center border-r border-[#7CC4FF]/10 last:border-r-0">
              <span className="font-mono-ui text-lg text-[#DDF1FF]">{value}</span>
              <span className="mt-1 font-mono-ui text-[0.48rem] uppercase tracking-[0.14em] text-[#7CC4FF]/42">{label}</span>
            </div>
          ))}
        </div>

        <p className="mt-3 font-mono-ui text-[0.5rem] uppercase tracking-[0.13em] text-[#7CC4FF]/40">
          Read-only · revoke is prepared unsigned · your wallet signs
          {payload?.scannedRange ? ` · range ${payload.scannedRange}` : ""}
        </p>

        {payload?.error && (
          <div className="mt-4 border border-[#E98791]/20 bg-[#E98791]/[0.045] px-4 py-3 text-[0.68rem] text-[#F4B8BE]">{payload.error}</div>
        )}

        {problemChains.length > 0 && (
          <div className="mt-4 border border-[#F3C879]/20 bg-[#F3C879]/[0.04] px-4 py-3">
            <div className="font-mono-ui text-[0.5rem] uppercase tracking-[0.14em] text-[#F3C879]/82">
              Approval scan unavailable on {problemChains.length} chain{problemChains.length === 1 ? "" : "s"}
            </div>
            <div className="mt-1.5 font-mono-ui text-[0.55rem] text-[#DDF1FF]/54">
              {problemChains.map((chain) => `${chain.shortLabel} (${stateLabel(chain.state).toLowerCase()})`).join(" · ")}
            </div>
          </div>
        )}

        <section className="mt-4 overflow-hidden border border-[#7CC4FF]/12 bg-[#0B1018]/88" aria-label="Active approvals">
          <div className="border-b border-[#7CC4FF]/10 px-4 py-3 font-mono-ui text-[0.53rem] uppercase tracking-[0.16em] text-[#7CC4FF]/48">
            Active approvals
          </div>
          {(payload?.approvals ?? []).length > 0 ? (
            payload?.approvals.map((approval) => (
              <ApprovalRow key={approval.id} approval={approval} onReview={() => setActive(approval)} />
            ))
          ) : (
            <div className="grid min-h-[190px] place-items-center px-5 text-center">
              <div className="max-w-[34ch]">
                <p className="text-[0.8rem] text-[#DDF1FF]/68">
                  {payload?.configured === false
                    ? "Add a public EVM address to review approvals"
                    : payload?.reachable
                      ? scopeSummary(payload)
                      : "Approval scan unavailable"}
                </p>
                <p className="mt-1.5 font-mono-ui text-[0.52rem] uppercase tracking-[0.12em] text-[#7CC4FF]/36">
                  {payload?.reachable
                    ? "This is scan coverage, not a clean bill of health"
                    : "Zero and unknown are kept separate"}
                </p>
              </div>
            </div>
          )}
        </section>

        {quietChains.length > 0 && (
          <div className="mt-3 border border-[#7CC4FF]/10 bg-[#0C131C]/70">
            <button
              type="button"
              onClick={() => setShowClear((value) => !value)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left font-mono-ui text-[0.52rem] uppercase tracking-[0.12em] text-[#7CC4FF]/45"
            >
              <span>{quietChains.length} chains with nothing found or not connected</span>
              <span>{showClear ? "hide" : "show"}</span>
            </button>
            {showClear && (
              <div className="border-t border-[#7CC4FF]/8 px-4 py-3">
                {quietChains.map((chain) => (
                  <div key={chain.id} className="flex items-center gap-2 py-1 font-mono-ui text-[0.55rem] text-[#DDF1FF]/58">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: stateColor(chain.state) }} />
                    {chain.shortLabel}
                    <span className="ml-auto text-[#7CC4FF]/38">{stateLabel(chain.state)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {active && <RevokeSheet approval={active} onClose={() => setActive(null)} />}
    </section>
  );
}

export default ApprovalsPane;
