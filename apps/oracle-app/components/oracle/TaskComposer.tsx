"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { haptic } from "@/components/shell/haptics";
import { ChevronRightIcon } from "@/components/shell/icons";
import { ProtocolPreview, type PreviewCandidate } from "./ProtocolPreview";
import type { OracleCoreSpecialist } from "./OracleCore";

const ORACLE_BLUE = "#7CC4FF";

export interface TaskComposerSpecialist extends OracleCoreSpecialist {
  description?: string;
  url?: string;
}

interface TaskMatch {
  specialist: TaskComposerSpecialist;
  score: number;
  hits: string[];
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "for", "to", "of", "on", "in", "my", "me",
  "i", "is", "are", "can", "you", "with", "what", "whats", "how", "do", "does",
  "should", "would", "give", "show", "get", "find", "all", "any", "from", "into",
]);

const PREPARE_SHAPED = /\b(swap|trade|buy|sell|bridge|convert|route)\b/i;
const BUILD_SHAPED = /\b(build|deploy|launch|ship|scaffold|protocol|dapp|contract|frontend|site|launchpad|mint)\b/i;

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s.-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function matchSpecialists(
  task: string,
  specialists: TaskComposerSpecialist[],
): TaskMatch[] {
  const tokens = tokenize(task);
  if (tokens.length === 0) return [];

  const matches: TaskMatch[] = [];
  for (const specialist of specialists) {
    const haystack = [specialist.label, specialist.detail, specialist.description]
      .filter((part): part is string => typeof part === "string")
      .join(" ")
      .toLowerCase();
    if (haystack.trim() === "") continue;

    const hits: string[] = [];
    let score = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) {
        hits.push(token);
        score += specialist.label.toLowerCase().includes(token) ? 3 : 1;
      }
    }
    if (score > 0) matches.push({ specialist, score, hits });
  }

  return matches.sort((left, right) => right.score - left.score).slice(0, 4);
}

export function TaskComposer({
  specialists,
  catalogLoading,
  catalogUnavailable,
  onOpenPrepare,
}: {
  specialists: TaskComposerSpecialist[];
  catalogLoading: boolean;
  catalogUnavailable: boolean;
  onOpenPrepare: () => void;
}) {
  const [task, setTask] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);

  const matches = useMemo(
    () => (submitted ? matchSpecialists(submitted, specialists) : []),
    [submitted, specialists],
  );

  const prepareShaped = submitted !== null && PREPARE_SHAPED.test(submitted);
  const buildShaped = submitted !== null && BUILD_SHAPED.test(submitted);

  const previewCandidates = useMemo<PreviewCandidate[]>(() => {
    const seen = new Set<string>();
    const out: PreviewCandidate[] = [];
    for (const match of matches) {
      const url = match.specialist.url;
      if (typeof url !== "string" || seen.has(url)) continue;
      seen.add(url);
      out.push({ label: match.specialist.label, url });
    }
    return out;
  }, [matches]);

  const submit = () => {
    const trimmed = task.trim();
    if (trimmed === "") return;
    void haptic(6);
    setSubmitted(trimmed);
  };

  return (
    <section aria-labelledby="task-composer-heading" className="w-full">
      <h2 id="task-composer-heading" className="sr-only">
        Give Oracle a task
      </h2>

      <div
        className="group/composer flex flex-col gap-2 border p-2 transition-all duration-300 focus-within:border-[#7CC4FF]/55 focus-within:shadow-[0_0_0_1px_rgba(124,196,255,0.18),0_18px_48px_-18px_rgba(124,196,255,0.14)] sm:flex-row sm:items-center"
        style={{
          borderColor: "rgba(124,196,255,.28)",
          background: "linear-gradient(180deg, #121B28, #0E1520)",
          boxShadow: "0 14px 40px -20px rgba(0,0,0,0.7)",
        }}
      >
        <label htmlFor="oracle-task-input" className="sr-only">
          Describe your task
        </label>
        <input
          id="oracle-task-input"
          value={task}
          onChange={(event) => setTask(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          placeholder="Describe a task. Oracle routes it."
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent px-3.5 py-3.5 text-[1.02rem] outline-none placeholder:text-[#8B98A8]/55"
          style={{ color: "#ECE7DA" }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={task.trim() === ""}
          className="flex shrink-0 items-center justify-center gap-2 px-6 py-3.5 font-mono-ui text-[0.62rem] uppercase tracking-[0.18em] transition-all duration-300 hover:brightness-110 disabled:opacity-35"
          style={{ background: ORACLE_BLUE, color: "#060A10" }}
        >
          Route task
          <ChevronRightIcon width={13} height={13} />
        </button>
      </div>

      {submitted !== null && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
          aria-live="polite"
        >
          <div
            className="mt-3 border"
            style={{ borderColor: "rgba(124,196,255,.14)", background: "#0E1520" }}
          >
            <div
              className="flex items-center justify-between gap-3 border-b px-4 py-2.5"
              style={{ borderColor: "rgba(124,196,255,.1)" }}
            >
              <span className="font-mono-ui text-[0.52rem] uppercase tracking-[0.2em]" style={{ color: ORACLE_BLUE }}>
                Routing preview
              </span>
              <span className="font-mono-ui text-[0.48rem] uppercase tracking-[0.12em] text-[#8B98A8]/70">
                catalog match, not an agent turn
              </span>
            </div>

            <div className="px-4 py-4">
              {catalogLoading && (
                <p className="text-[0.8rem] text-[#8B98A8]">Loading the live catalog before routing.</p>
              )}

              {!catalogLoading && catalogUnavailable && (
                <p className="text-[0.8rem] text-[#8B98A8]">
                  The catalog is unavailable, so Oracle cannot show which specialist would take this.
                  No substitute routing was invented.
                </p>
              )}

              {!catalogLoading && !catalogUnavailable && matches.length === 0 && (
                <p className="text-[0.8rem] text-[#8B98A8]">
                  No catalog specialist matched that wording. Try naming the chain, venue, or asset.
                </p>
              )}

              {matches.length > 0 && (
                <ul className="divide-y" style={{ borderColor: "rgba(124,196,255,.08)" }}>
                  {matches.map(({ specialist, hits }) => (
                    <li key={specialist.id} className="px-1 py-3 first:pt-1" style={{ borderColor: "rgba(124,196,255,.08)" }}>
                      <div className="flex items-center gap-2.5">
                        <span className="h-1 w-1 shrink-0 rounded-full" style={{ background: ORACLE_BLUE }} />
                        <span className="truncate text-[0.86rem] text-[#ECE7DA]">{specialist.label}</span>
                        {specialist.detail && (
                          <span className="ml-auto shrink-0 font-mono-ui text-[0.46rem] uppercase tracking-[0.12em] text-[#8B98A8]/65">
                            {specialist.detail}
                          </span>
                        )}
                      </div>
                      {specialist.description && (
                        <p className="mt-1.5 pl-3.5 text-[0.72rem] leading-relaxed text-[#8B98A8]">
                          {specialist.description}
                        </p>
                      )}
                      <p className="mt-1.5 pl-3.5 font-mono-ui text-[0.46rem] uppercase tracking-[0.1em] text-[#5C6878]">
                        matched {hits.slice(0, 4).join(", ")}
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              {prepareShaped && (
                <button
                  type="button"
                  onClick={() => {
                    void haptic(6);
                    onOpenPrepare();
                  }}
                  className="mt-3 flex w-full items-center justify-between gap-3 border px-3.5 py-2.5 text-left transition-colors duration-300 hover:border-[#7CC4FF]/45"
                  style={{ borderColor: "rgba(124,196,255,.24)" }}
                >
                  <span className="text-[0.8rem] text-[#ECE7DA]">Prepare an unsigned intent for this</span>
                  <ChevronRightIcon width={14} height={14} />
                </button>
              )}

              <p className="mt-4 max-w-[62ch] text-[0.7rem] leading-relaxed text-[#5C6878]">
                Oracle prepares. It never signs or broadcasts here. Connect a local Oracle agent to
                run the turn, and a local signer to execute it.
              </p>
            </div>
          </div>

          {buildShaped && <ProtocolPreview candidates={previewCandidates} />}
        </motion.div>
      )}
    </section>
  );
}

export default TaskComposer;
