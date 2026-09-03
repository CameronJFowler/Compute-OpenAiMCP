import { useEffect, useState } from "react";

import { DEFAULT_ALPHA } from "../config";
import { getTestingSummary, useWorkspace } from "../state/workspace";

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

  // Local mirror so typing stays responsive; pushed to the store on each keystroke.
  const [draft, setDraft] = useState(hypothesis);
  useEffect(() => setDraft(hypothesis), [hypothesis]);

  const summary = getTestingSummary();
  const last = tests[tests.length - 1];
  const narrowed = Boolean(sampleStart || sampleEnd);

  const quickButton =
    "px-2 py-[3px] text-[11px] rounded border border-hair text-ink3 hover:text-ink hover:border-hair2 transition";

  return (
    <div className="h-full overflow-y-auto">
      <Section
        title="Question"
        accessory={<Author author={hypothesisAuthor} />}
      >
        <textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setHypothesis(e.target.value);
          }}
          rows={4}
          spellCheck={false}
          placeholder="State it so that it could turn out to be false."
          className="w-full bg-canvas border border-hair rounded px-2.5 py-2 text-[12.5px] leading-relaxed text-ink placeholder:text-ink3/70 focus:outline-none focus:border-hair2 resize-none"
        />
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

          <p className="text-[11.5px] text-ink3 leading-relaxed">
            Changing this changes what the next analysis runs on, including the
            agent&apos;s. There is no second copy to synchronise.
          </p>
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
