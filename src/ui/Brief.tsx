import { useEffect, useRef, useState } from "react";

import { APP_NAME, DEFAULT_ALPHA } from "../config";
import { getTestingSummary, useWorkspace } from "../state/workspace";
import { loadDatasetById, loadDatasetForQuestion } from "../webmcp/tools/session";

function Section({
  title,
  children,
  accessory,
}: {
  title: string;
  children: React.ReactNode;
  accessory?: React.ReactNode;
}) {
  return (
    <section className="px-4 py-4 border-b border-hair">
      <div className="flex items-center justify-between mb-2.5">
        <h2 className="label">{title}</h2>
        {accessory}
      </div>
      {children}
    </section>
  );
}

/**
 * Who last wrote this field.
 *
 * Both parties write to the same hypothesis and the same window. Saying which
 * one did it last is what turns a shared object into visible turn-taking.
 */
function Author({ author }: { author: "agent" | "human" | null }) {
  if (!author) return null;
  return (
    <span className="text-2xs uppercase tracking-label text-ink3">
      {author === "agent" ? (
        <span className="text-accent">set by agent</span>
      ) : (
        "edited by you"
      )}
    </span>
  );
}

/**
 * A p-value that is small enough to underflow is reported as such rather than
 * as zero. The tails are computed directly now, so this only fires at the
 * genuine limit of double precision - but "0.00" would still read as a
 * measurement rather than as the edge of the arithmetic.
 */
function formatP(p: number): string {
  if (!Number.isFinite(p)) return "n/a";
  if (p === 0) return "< 1e-300";
  return p.toPrecision(3);
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between py-[3px]">
      <span className="text-[12px] text-ink3">{label}</span>
      <span className={`text-[12.5px] tnum ${tone ?? "text-ink2"}`}>{value}</span>
    </div>
  );
}

/**
 * Cold-start panel shown before any dataset is loaded.
 *
 * Surfaces the value proposition and step-by-step connection instructions
 * so a judge or first-time visitor can get an agent running immediately.
 */
function ConnectGuide() {
  const [open, setOpen] = useState(false);

  return (
    <div className="px-4 py-4 border-b border-hair">
      <div className="mb-3">
        <div className="text-[13.5px] font-medium text-ink mb-1">{APP_NAME}</div>
        <p className="text-[12px] text-ink3 leading-relaxed">
          A statistical research bench where AI agents and humans share one
          live workspace — no backend, no API keys, runs entirely in the
          browser via WebMCP.
        </p>
      </div>

      <div className="space-y-1.5 mb-3">
        {[
          "5 bundled datasets: climate, finance, biology, astronomy",
          "Numbers go to the agent; charts render here for you",
          "Every tool call logged — findings must cite their source",
          "Approval gates before expensive operations",
        ].map((item) => (
          <div key={item} className="flex items-start gap-1.5">
            <span className="text-accent text-[11px] mt-[2px] shrink-0">+</span>
            <span className="text-[11.5px] text-ink2 leading-relaxed">{item}</span>
          </div>
        ))}
      </div>

      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 rounded border border-hair bg-panel hover:border-hair2 hover:text-ink transition text-[11.5px] text-ink2"
      >
        <span>Connect with ChatGPT</span>
        <span className="text-ink3">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <ol className="space-y-2">
            {[
              <>Open <strong className="text-ink font-medium">ChatGPT</strong> and start a new conversation.</>,
              <>Paste this URL into the chat or open it inside ChatGPT's browser: <span className="font-mono text-[10.5px] text-accent break-all">https://computeopenai.netlify.app/</span></>,
              <>Ask a plain-language research question — e.g. <em className="text-ink2">"Is there a momentum effect in US industry returns?"</em></>,
              <>Watch the <strong className="text-ink font-medium">Agent</strong> indicator in the top-right: the capability count jumps from 4 to 12+ when a dataset loads.</>,
              <>Results appear here as the agent calls tools. You can edit the question or narrow the sample window between calls.</>,
            ].map((step, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="text-[10px] text-ink3 tnum mt-[3px] shrink-0 w-3">{i + 1}.</span>
                <span className="text-[11.5px] text-ink2 leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
          <p className="text-[10.5px] text-ink3 leading-relaxed pt-1 border-t border-hair">
            Local testing: run <span className="font-mono">npm run dev</span> then
            enable the WebMCP flag in Chrome at{" "}
            <span className="font-mono">chrome://flags</span>.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The research brief.
 *
 * Everything here is editable by the operator while the agent is running, and
 * the next tool call reads the edited value, because there is only one copy of
 * it. Changing the sample window is not a request to the agent; it changes the
 * data the agent's next call operates on.
 */
export function Brief() {
  const hypothesis = useWorkspace((s) => s.hypothesis);
  const setHypothesis = useWorkspace((s) => s.setHypothesis);
  const datasetId = useWorkspace((s) => s.datasetId);
  const datasetName = useWorkspace((s) => s.datasetName);
  const frame = useWorkspace((s) => s.frame);
  const dataStart = useWorkspace((s) => s.dataStart);
  const dataEnd = useWorkspace((s) => s.dataEnd);
  const sampleStart = useWorkspace((s) => s.sampleStart);
  const sampleEnd = useWorkspace((s) => s.sampleEnd);
  const setSampleWindow = useWorkspace((s) => s.setSampleWindow);
  const findings = useWorkspace((s) => s.findings);
  const tests = useWorkspace((s) => s.tests);
  const hypothesisAuthor = useWorkspace((s) => s.hypothesisAuthor);
  const windowAuthor = useWorkspace((s) => s.windowAuthor);
  const reset = useWorkspace((s) => s.reset);

  // Local mirror so typing stays responsive; pushed to the store on each keystroke.
  const [draft, setDraft] = useState(hypothesis);
  useEffect(() => setDraft(hypothesis), [hypothesis]);

  // Running state: set on submit, cleared when step count changes.
  const [running, setRunning] = useState(false);
  const prevSteps = useRef(0);
  const stepCount = useWorkspace((s) => s.steps.length);
  useEffect(() => {
    if (stepCount > prevSteps.current) {
      setRunning(false);
      prevSteps.current = stepCount;
    }
  }, [stepCount]);

  const summary = getTestingSummary();
  const last = tests[tests.length - 1];
  const narrowed = Boolean(sampleStart || sampleEnd);

  const quickButton =
    "px-2 py-[3px] text-[11px] rounded border border-hair text-ink3 hover:text-ink hover:border-hair2 transition";

  /** Fire the analysis pipeline from a human-initiated submit. */
  async function handleSubmit() {
    if (!draft.trim() || running) return;
    setRunning(true);
    try {
      if (frame && datasetId) {
        // Dataset already loaded — reload with current date range to re-run pipeline.
        await loadDatasetById(datasetId, {
          start: sampleStart ?? undefined,
          end: sampleEnd ?? undefined,
        });
      } else {
        // Cold start — route to the right dataset and run.
        await loadDatasetForQuestion(draft.trim());
      }
    } catch {
      setRunning(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      {!datasetId && <ConnectGuide />}
      <Section
        title="Question"
        accessory={
          frame ? (
            <button
              onClick={() => reset()}
              title="Start a new investigation"
              className="text-[11px] text-ink3 hover:text-ink transition px-1.5 py-0.5 rounded border border-hair hover:border-hair2"
            >
              ↺ New
            </button>
          ) : (
            <Author author={hypothesisAuthor} />
          )
        }
      >
        <textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setHypothesis(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void handleSubmit();
          }}
          rows={4}
          spellCheck={false}
          placeholder="State it so that it could turn out to be false."
          className="w-full bg-canvas border border-hair rounded px-2.5 py-2 text-[12.5px] leading-relaxed text-ink placeholder:text-ink3/70 focus:outline-none focus:border-hair2 resize-none"
        />
        {!frame && (
          <button
            onClick={() => void handleSubmit()}
            disabled={!draft.trim() || running}
            className="mt-2 w-full py-2 rounded text-[12.5px] font-medium transition
              bg-accent text-canvas hover:brightness-110
              disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {running ? "Running…" : "Run Analysis →"}
          </button>
        )}
      </Section>

      <Section title="Data">
        {datasetId ? (
          <div>
            <div className="text-[13px] text-ink mb-0.5">{datasetName}</div>
            <div className="text-[11.5px] text-ink3 mb-2.5 font-mono">{datasetId}</div>
            <Row label="Rows" value={frame ? frame.nRows.toLocaleString() : "-"} />
            <Row label="Columns" value={String(frame?.columnOrder.length ?? 0)} />
            {frame?.entities && (
              <Row label="Entities" value={String(new Set(frame.entities).size)} />
            )}
          </div>
        ) : (
          <p className="text-[12.5px] text-ink3 leading-relaxed">
            No dataset loaded yet.
          </p>
        )}
      </Section>

      {dataStart && dataEnd && (
        <Section
          title="Sample window"
          accessory={narrowed ? <Author author={windowAuthor} /> : undefined}
        >
          <div className="flex items-center gap-2 mb-2">
            <input
              type="date"
              value={sampleStart ?? dataStart}
              min={dataStart}
              max={dataEnd}
              onChange={(e) => setSampleWindow(e.target.value || null, sampleEnd)}
              className="flex-1 min-w-0 bg-canvas border border-hair rounded px-2 py-1 text-[11.5px] tnum text-ink focus:outline-none focus:border-hair2"
            />
            <span className="text-[11px] text-ink3 shrink-0">to</span>
            <input
              type="date"
              value={sampleEnd ?? dataEnd}
              min={dataStart}
              max={dataEnd}
              onChange={(e) => setSampleWindow(sampleStart, e.target.value || null)}
              className="flex-1 min-w-0 bg-canvas border border-hair rounded px-2 py-1 text-[11.5px] tnum text-ink focus:outline-none focus:border-hair2"
            />
          </div>

          <div className="flex gap-1.5 mb-2.5">
            <button className={quickButton} onClick={() => setSampleWindow(null, null)}>
              Full
            </button>
            <button
              className={quickButton}
              onClick={() => {
                const end = new Date(dataEnd);
                const start = new Date(end);
                start.setFullYear(start.getFullYear() - 3);
                setSampleWindow(start.toISOString().slice(0, 10), null);
              }}
            >
              Last 3y
            </button>
            <button
              className={quickButton}
              onClick={() => {
                const start = new Date(dataStart).getTime();
                const end = new Date(dataEnd).getTime();
                const cut = new Date(start + (end - start) * 0.7);
                setSampleWindow(null, cut.toISOString().slice(0, 10));
              }}
            >
              First 70%
            </button>
          </div>

          <p className="text-[11.5px] text-ink3 leading-relaxed mb-3">
            Changing this changes what the next analysis runs on, including the
            agent&apos;s. There is no second copy to synchronise.
          </p>

          <button
            onClick={() => void handleSubmit()}
            disabled={!draft.trim() || running}
            className="w-full py-2 rounded text-[12.5px] font-medium transition
              bg-accent text-canvas hover:brightness-110
              disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {running
              ? "Running…"
              : narrowed
              ? "Re-run with this window →"
              : "Re-run Analysis →"}
          </button>
        </Section>
      )}

      <Section title="Multiple testing">
        {summary.testsRun === 0 ? (
          /* Four rows of zeros said nothing. Before anything has been tested
             the useful thing is not the numbers, which are all defaults, but
             what is about to happen to them. */
          <p className="text-[12.5px] text-ink3 leading-relaxed">
            Nothing tested yet. Every hypothesis tested in this session tightens the
            threshold a result has to clear: after five tests, significant means
            p&nbsp;&le;&nbsp;{(DEFAULT_ALPHA / 5).toFixed(3)} rather than{" "}
            {DEFAULT_ALPHA}. The count and the adjusted threshold are returned inside
            every test result, so the agent has to reason about them too.
          </p>
        ) : (
          <>
            <Row
              label="Hypotheses tested"
              value={String(summary.testsRun)}
              tone="text-accent"
            />
            <Row label="Naive threshold" value={summary.naiveAlpha.toFixed(4)} />
            <Row
              label="Bonferroni"
              value={summary.bonferroniAlpha.toPrecision(3)}
              tone={summary.testsRun > 1 ? "text-accent" : "text-ink2"}
            />
            <Row
              label="Survive FDR control"
              value={`${summary.benjaminiHochbergDiscoveries} of ${summary.testsRun}`}
            />

            {last && (
              <p className="mt-2.5 text-[11.5px] leading-relaxed">
                {last.pValue <= summary.bonferroniAlpha ? (
                  <span className="text-pos">
                    Latest p = {formatP(last.pValue)} survives the session-adjusted
                    threshold.
                  </span>
                ) : last.pValue <= summary.naiveAlpha ? (
                  <span className="text-neg">
                    Latest p = {formatP(last.pValue)} clears {summary.naiveAlpha} on its
                    own but not after adjusting for the {summary.testsRun} tests run
                    here.
                  </span>
                ) : (
                  <span className="text-ink3">
                    Latest p = {formatP(last.pValue)}. Not significant.
                  </span>
                )}
              </p>
            )}
          </>
        )}
      </Section>

      <Section title={`Findings${findings.length ? ` (${findings.length})` : ""}`}>
        {findings.length === 0 ? (
          <p className="text-[12.5px] text-ink3 leading-relaxed">
            None recorded. A finding has to cite the step that produced it.
          </p>
        ) : (
          <ol className="space-y-3">
            {findings.map((f) => (
              <li key={f.id} className="text-[12.5px] leading-relaxed text-ink2">
                <span className="tnum text-ink3 mr-1.5">{f.id}.</span>
                {f.text}
                <div className="text-2xs text-ink3 mt-0.5">
                  from step{f.supportingSteps.length > 1 ? "s" : ""}{" "}
                  {f.supportingSteps.join(", ")}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}
