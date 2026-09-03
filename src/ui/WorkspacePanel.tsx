import { useMemo, useState } from "react";
import type { ChartConfiguration } from "chart.js";

import { DATASETS, OPERATOR_GUIDE_URL } from "../config";
import { USER_DATASET_ID, buildFrameFromCsv } from "../engine/loader";
import { moments } from "../engine/stats";
import { useWorkspace, type WorkspaceView } from "../state/workspace";
import { setNextActor } from "../webmcp/tools/common";
import { setHypothesisTool } from "../webmcp/tools/report";
import { loadDatasetTool } from "../webmcp/tools/session";
import { ApprovalCard } from "./ApprovalCard";
import {
  BASE_PLUGINS,
  CHART_COLORS,
  ChartCanvas,
  SERIES_PALETTE,
  baseScales,
} from "./Chart";

function n(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return "—";
  if (value !== 0 && Math.abs(value) < 1e-4) return value.toExponential(2);
  return value.toFixed(digits);
}

function Heading({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <div className="mb-4">
      <h1 className="text-[15px] text-ink leading-snug">{children}</h1>
      {sub && (
        <p className="text-[12px] text-ink3 mt-1 leading-relaxed max-w-3xl">{sub}</p>
      )}
    </div>
  );
}

function Panel({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="border border-hair rounded-md bg-panel">
      {title && (
        <div className="px-3.5 py-2 border-b border-hair">
          <span className="label">{title}</span>
        </div>
      )}
      <div className="p-3.5">{children}</div>
    </section>
  );
}

function Table({
  headers,
  rows,
}: {
  headers: string[];
  rows: { label: string; values: string[] }[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px] border-collapse">
        <thead>
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                className="label text-left font-normal border-b border-hair pb-1.5 pr-5 whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b border-hair/50 last:border-0">
              <td className="py-1.5 pr-5 text-ink whitespace-nowrap">{row.label}</td>
              {row.values.map((v, i) => (
                <td key={i} className="py-1.5 pr-5 text-ink2 tnum whitespace-nowrap">
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="label mb-1">{label}</div>
      <div className={`text-[15px] tnum ${tone ?? "text-ink"}`}>{value}</div>
    </div>
  );
}

/**
 * The calm starting point before data is loaded.
 */
const EXAMPLE_QUESTIONS = [
  "Do Adelie and Gentoo penguins differ in body mass?",
  "How much of global temperature variation is explained by CO2?",
  "Does industry momentum survive out of sample and transaction costs?",
];

function EmptyState() {
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the question matched no bundled dataset. The page asks rather
  // than analysing whatever happens to be nearest.
  const [needsChoice, setNeedsChoice] = useState(false);
  const [dragging, setDragging] = useState(false);

  /**
   * Take a CSV the operator brought and make it the workspace.
   *
   * Nothing leaves the page. The registry is watching the store, so by the time
   * this returns the agent's schemas already carry these column names.
   */
  const loadFile = async (file: File) => {
    setError(null);
    setNeedsChoice(false);
    setSubmitting(true);
    try {
      const frame = buildFrameFromCsv(file.name, await file.text());
      const store = useWorkspace.getState();
      store.loadFrame(frame, USER_DATASET_ID, file.name);
      // beginStep returns the id; the captured store's `steps` array is the one
      // from before the call and would leave the step showing as still running.
      const stepId = store.beginStep("load_file", { file: file.name }, "human");
      useWorkspace
        .getState()
        .completeStep(
          stepId,
          `loaded ${file.name}: ${frame.nRows} rows, ${frame.columnOrder.length} columns`,
          "ok",
        );
      store.setView({
        kind: "dataset",
        title: file.name,
        headers: ["column", "type", "n", "missing", "mean", "sd"],
        note: "Your file, parsed in this page. Nothing was uploaded. The analysis tools now carry these column names in their schemas.",
        rows: frame.columnOrder.map((name) => {
          const column = frame.columns[name];
          if (column.kind !== "numeric") {
            return { label: name, values: ["category", String(frame.nRows), "0", "-", "-"] };
          }
          const m = moments(column.values);
          return {
            label: name,
            values: ["numeric", String(m.n), String(m.missing), n(m.mean, 4), n(m.sd, 4)],
          };
        }),
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? `Could not read that file: ${err.message}`
          : "Could not read that file.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const start = async (text: string) => {
    if (!text || submitting) return;
    setSubmitting(true);
    setError(null);
    setNeedsChoice(false);
    setNextActor("human");

    try {
      const result = (await setHypothesisTool().execute({ hypothesis: text })) as {
        isError?: boolean;
        content?: { text?: string }[];
      };
      if (result.isError) {
        setError(result.content?.[0]?.text ?? "Unable to start research.");
      } else if (!useWorkspace.getState().frame) {
        setNeedsChoice(true);
      }
    } catch {
      setError("Unable to start research.");
    } finally {
      setSubmitting(false);
    }
  };

  const chooseDataset = async (datasetId: string) => {
    setSubmitting(true);
    setNextActor("human");
    try {
      await loadDatasetTool().execute({ dataset_id: datasetId });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center py-12">
      <div className="max-w-xl w-full">
        <div className="mb-6">
          <div className="label mb-2">Research workspace</div>
          <h1 className="text-[22px] text-ink tracking-tight">
            What would you like to investigate?
          </h1>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void start(question.trim());
          }}
          className="flex gap-2"
        >
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask a research question"
            autoFocus
            className="flex-1 min-w-0 h-10 bg-panel border border-hair rounded px-3 text-[13px] text-ink placeholder:text-ink3 focus:outline-none focus:border-hair2"
          />
          <button
            type="submit"
            disabled={!question.trim() || submitting}
            className="h-10 px-4 rounded bg-accent text-canvas text-[12.5px] disabled:opacity-40 hover:brightness-110 transition"
          >
            {submitting ? "Starting…" : "Start"}
          </button>
        </form>

        {error && <p className="mt-3 text-[11.5px] text-neg">{error}</p>}

        {needsChoice ? (
          <div className="mt-5 border border-hair rounded-md bg-panel p-4">
            <div className="text-[12.5px] text-ink mb-1">
              Nothing bundled here clearly answers that.
            </div>
            <p className="text-[11.5px] text-ink3 leading-relaxed mb-3">
              Rather than analyse the nearest data and let you assume it was the right
              data, here is everything on hand. Pick one, or ask something else.
            </p>
            <ul className="space-y-1.5">
              {DATASETS.map((d) => (
                <li key={d.id}>
                  <button
                    onClick={() => void chooseDataset(d.id)}
                    disabled={submitting}
                    className="w-full text-left px-2.5 py-1.5 rounded border border-hair hover:border-hair2 transition disabled:opacity-40"
                  >
                    <span className="text-[12px] text-ink">{d.name}</span>
                    <span className="text-[11px] text-ink3 ml-2">{d.domain}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="mt-5">
            <div className="label mb-2">For example</div>
            <ul className="space-y-1.5">
              {EXAMPLE_QUESTIONS.map((example) => (
                <li key={example}>
                  <button
                    onClick={() => {
                      setQuestion(example);
                      void start(example);
                    }}
                    disabled={submitting}
                    className="text-left text-[12px] text-ink2 hover:text-ink transition disabled:opacity-40"
                  >
                    {example}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 pt-4 border-t border-hair">
          <label
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files[0];
              if (file) void loadFile(file);
            }}
            className={`block rounded-md border border-dashed px-4 py-3 cursor-pointer transition-colors ${
              dragging ? "border-accent bg-accent/[0.05]" : "border-hair2 hover:border-ink3"
            }`}
          >
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void loadFile(file);
              }}
            />
            <div className="text-[12.5px] text-ink2">
              Or bring your own CSV — drop it here, or click to choose.
            </div>
            <div className="text-[11.5px] text-ink3 leading-relaxed mt-0.5">
              Parsed in this page and never uploaded. The agent&apos;s tools are
              rebuilt around your columns the moment it loads.
            </div>
          </label>
        </div>

        <p className="mt-5 pt-4 border-t border-hair text-[11.5px] text-ink3 leading-relaxed">
          Working with an agent? Ask it the same question instead — through WebMCP it
          drives these exact tools, and the results land here rather than in the chat.{" "}
          <a
            href={OPERATOR_GUIDE_URL}
            target="_blank"
            rel="noreferrer"
            className="text-ink2 underline decoration-hair2 underline-offset-2 hover:text-ink"
          >
            How to connect one
          </a>
          .
        </p>
      </div>
    </div>
  );
}

function SeriesView({ view }: { view: Extract<WorkspaceView, { kind: "series" }> }) {
  const config = useMemo<ChartConfiguration>(
    () => ({
      type: "line",
      data: {
        labels: view.series[0]?.points.map((p) => p.x) ?? [],
        datasets: view.series.map((s, i) => ({
          label: s.label,
          data: s.points.map((p) => p.y),
          borderColor: SERIES_PALETTE[i % SERIES_PALETTE.length],
          backgroundColor: "transparent",
          borderWidth: 1.2,
          pointRadius: 0,
          tension: 0,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        interaction: { mode: "index", intersect: false },
        scales: baseScales(),
        plugins: BASE_PLUGINS,
      },
    }),
    [view],
  );

  return (
    <div>
      <Heading sub={view.note}>{view.title}</Heading>
      <Panel>
        <ChartCanvas config={config} height={320} />
      </Panel>
      <p className="text-[11.5px] text-ink3 mt-2.5 leading-relaxed">
        Up to six series shown, downsampled for display. The full column stays in the
        page — the agent received a summary of a few hundred characters, not the data.
      </p>
    </div>
  );
}

function RegressionView({
  view,
}: {
  view: Extract<WorkspaceView, { kind: "regression" }>;
}) {
  const { result } = view;

  const scatterConfig = useMemo<ChartConfiguration>(() => {
    const xs = view.scatter.map((p) => p.x).filter(Number.isFinite);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const intercept = result.coefficients[0]?.estimate ?? 0;
    const slope = result.coefficients[1]?.estimate ?? 0;

    return {
      type: "scatter",
      data: {
        datasets: [
          {
            label: "observations",
            data: view.scatter,
            backgroundColor: "rgba(95,147,192,0.30)",
            pointRadius: 1.6,
          },
          {
            label: "fit",
            type: "line" as const,
            data: [
              { x: minX, y: intercept + slope * minX },
              { x: maxX, y: intercept + slope * maxX },
            ],
            borderColor: CHART_COLORS.accent,
            borderWidth: 1.5,
            pointRadius: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        scales: baseScales(view.scatterXLabel, view.dependentName),
        plugins: BASE_PLUGINS,
      },
    };
  }, [view, result]);

  const residualConfig = useMemo<ChartConfiguration>(
    () => ({
      type: "scatter",
      data: {
        datasets: [
          {
            label: "residuals",
            data: view.residualPoints,
            backgroundColor: "rgba(143,134,196,0.30)",
            pointRadius: 1.6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        scales: baseScales("fitted", "residual"),
        plugins: { ...BASE_PLUGINS, legend: { display: false } },
      },
    }),
    [view],
  );

  return (
    <div className="space-y-5">
      <Heading
        sub={`${result.n.toLocaleString()} observations · ${
          result.standardErrors === "newey_west"
            ? `Newey-West HAC standard errors at ${result.neweyWestLags} lags`
            : "classical standard errors"
        }`}
      >
        {view.title}
      </Heading>

      <Panel title="Coefficients">
        <Table
          headers={["term", "estimate", "std. error", "t", "p", "95% low", "95% high"]}
          rows={result.coefficients.map((c) => ({
            label: c.name,
            values: [
              n(c.estimate, 6), n(c.standardError, 6), n(c.tStatistic, 3),
              n(c.pValue, 5), n(c.ciLow, 5), n(c.ciHigh, 5),
            ],
          }))}
        />
      </Panel>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-5 px-1">
        <Stat label="R²" value={n(result.rSquared, 4)} />
        <Stat label="Adjusted R²" value={n(result.adjustedRSquared, 4)} />
        <Stat
          label={`F(${result.k - 1}, ${result.degreesOfFreedom})`}
          value={n(result.fStatistic, 3)}
        />
        <Stat label="F p-value" value={n(result.fPValue, 5)} />
        <Stat label="Residual s.e." value={n(result.residualStandardError, 5)} />
      </div>

      {result.conditionWarning && (
        <div className="flex gap-2.5 text-[12.5px] text-neg border border-neg/35 rounded-md px-3.5 py-2.5 leading-relaxed">
          <span className="w-1.5 h-1.5 rounded-full bg-neg mt-1.5 shrink-0" />
          {result.conditionWarning}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Panel title={`Fit against ${view.scatterXLabel}`}>
          <ChartCanvas config={scatterConfig} height={250} />
        </Panel>
        <Panel title="Residuals against fitted">
          <ChartCanvas config={residualConfig} height={250} />
        </Panel>
      </div>
    </div>
  );
}

function CorrelationView({
  view,
}: {
  view: Extract<WorkspaceView, { kind: "correlation" }>;
}) {
  const { matrix } = view;

  const cell = (r: number) => {
    if (!Number.isFinite(r)) return "rgba(103,112,124,0.12)";
    const intensity = Math.min(1, Math.abs(r));
    return r >= 0
      ? `rgba(217,164,65,${0.08 + intensity * 0.45})`
      : `rgba(95,147,192,${0.08 + intensity * 0.45})`;
  };

  return (
    <div>
      <Heading sub="Amber is positive, blue negative. Computed pairwise-complete.">
        {view.title}
      </Heading>
      <Panel>
        <div className="overflow-x-auto">
          <table className="text-[11.5px] border-collapse">
            <thead>
              <tr>
                <th className="p-1.5" />
                {matrix.names.map((name) => (
                  <th
                    key={name}
                    className="p-1.5 text-ink3 font-normal text-left whitespace-nowrap"
                  >
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.names.map((rowName, i) => (
                <tr key={rowName}>
                  <td className="p-1.5 pr-4 text-ink3 whitespace-nowrap">{rowName}</td>
                  {matrix.names.map((colName, j) => (
                    <td
                      key={colName}
                      className="p-1.5 text-center text-ink tnum min-w-[56px]"
                      style={{ background: cell(matrix.values[i][j]) }}
                      title={`${rowName} · ${colName}  n=${matrix.counts[i][j]}`}
                    >
                      {n(matrix.values[i][j], 2)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function BacktestView({ view }: { view: Extract<WorkspaceView, { kind: "backtest" }> }) {
  const equityConfig = useMemo<ChartConfiguration>(() => {
    const splitIndex = view.splitDate
      ? view.equityCurve.findIndex((p) => p.x >= view.splitDate!)
      : -1;
    return {
      type: "line",
      data: {
        labels: view.equityCurve.map((p) => p.x),
        datasets: [
          {
            label: "in-sample",
            data: view.equityCurve.map((p, i) =>
              splitIndex < 0 || i <= splitIndex ? p.y : null,
            ),
            borderColor: CHART_COLORS.accent,
            borderWidth: 1.4,
            pointRadius: 0,
            spanGaps: false,
          },
          {
            label: "out-of-sample",
            data: view.equityCurve.map((p, i) =>
              splitIndex >= 0 && i >= splitIndex ? p.y : null,
            ),
            borderColor: CHART_COLORS.pos,
            borderWidth: 1.4,
            pointRadius: 0,
            spanGaps: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        interaction: { mode: "index", intersect: false },
        scales: baseScales(undefined, "wealth"),
        plugins: BASE_PLUGINS,
      },
    };
  }, [view]);

  const drawdownConfig = useMemo<ChartConfiguration>(
    () => ({
      type: "line",
      data: {
        labels: view.drawdown.map((p) => p.x),
        datasets: [
          {
            label: "drawdown",
            data: view.drawdown.map((p) => p.y),
            borderColor: CHART_COLORS.neg,
            backgroundColor: "rgba(201,123,116,0.10)",
            borderWidth: 1.2,
            pointRadius: 0,
            fill: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        scales: baseScales(),
        plugins: { ...BASE_PLUGINS, legend: { display: false } },
      },
    }),
    [view],
  );

  return (
    <div className="space-y-5">
      <Heading
        sub={`Split chronologically at ${view.splitDate ?? "—"}. The 70/30 boundary is fixed and is not a parameter: a split you can tune is not an out-of-sample test.`}
      >
        {view.title}
      </Heading>

      <Panel title="Performance">
        <Table
          headers={["metric", "full period", "in-sample 70%", "out-of-sample 30%"]}
          rows={view.metrics.map((m) => ({
            label: m.label,
            values: [m.full, m.inSample, m.outOfSample],
          }))}
        />
      </Panel>

      <Panel title="Equity curve">
        <ChartCanvas config={equityConfig} height={230} />
      </Panel>
      <Panel title="Drawdown">
        <ChartCanvas config={drawdownConfig} height={140} />
      </Panel>
    </div>
  );
}

function BootstrapView({
  view,
}: {
  view: Extract<WorkspaceView, { kind: "bootstrap" }>;
}) {
  const config = useMemo<ChartConfiguration>(
    () => ({
      type: "bar",
      data: {
        labels: view.histogram.map((b) => b.binStart.toFixed(2)),
        datasets: [
          {
            label: "paths",
            data: view.histogram.map((b) => b.count),
            backgroundColor: view.histogram.map((b) =>
              b.binEnd <= 0 ? "rgba(201,123,116,0.55)" : "rgba(95,147,192,0.45)",
            ),
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        scales: baseScales("Sharpe ratio", "paths"),
        plugins: { ...BASE_PLUGINS, legend: { display: false } },
      },
    }),
    [view],
  );

  return (
    <div className="space-y-5">
      <Heading sub="Red bars are resampled histories in which the strategy did not make money on a risk-adjusted basis.">
        {view.title}
      </Heading>

      <Panel>
        <ChartCanvas config={config} height={260} />
      </Panel>

      <div className="grid grid-cols-3 md:grid-cols-7 gap-5 px-1">
        <Stat label="Observed" value={n(view.observed, 2)} tone="text-accent" />
        {view.percentiles.map((p) => (
          <Stat key={p.label} label={p.label} value={n(p.value, 2)} />
        ))}
        <Stat
          label="Failed"
          value={`${(view.fractionNonPositive * 100).toFixed(1)}%`}
          tone={view.fractionNonPositive > 0.1 ? "text-neg" : "text-pos"}
        />
      </div>
    </div>
  );
}

function ReportView({ view }: { view: Extract<WorkspaceView, { kind: "report" }> }) {
  const download = () => {
    const blob = new Blob([view.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "compute-report.md";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-4">
        <Heading sub="Assembled from the session record. Every number came from a step in the log.">
          {view.title}
        </Heading>
        <button
          onClick={download}
          className="shrink-0 px-3 py-1.5 text-[12px] rounded border border-hair2 text-ink2 hover:text-ink hover:border-ink3 transition"
        >
          Download Markdown
        </button>
      </div>
      <Panel>
        <pre className="text-[12px] leading-relaxed whitespace-pre-wrap text-ink2 font-mono max-h-[62vh] overflow-y-auto">
          {view.markdown}
        </pre>
      </Panel>
    </div>
  );
}

function FindingsPanel() {
  const findings = useWorkspace((s) => s.findings);
  if (findings.length === 0) return null;
  return (
    <div className="mb-5 border border-hair rounded-md bg-panel">
      <div className="px-3.5 py-2 border-b border-hair">
        <span className="label">Findings ({findings.length})</span>
      </div>
      <div className="p-3.5 space-y-3">
        {findings.map((f) => (
          <div key={f.id}>
            <div className="text-[12.5px] leading-relaxed text-ink2">
              <span className="tnum text-ink3 mr-1.5">{f.id}.</span>
              {f.text}
            </div>
            <div className="text-2xs text-ink3 mt-0.5 ml-5">
              step{f.supportingSteps.length > 1 ? "s" : ""}{" "}
              {f.supportingSteps.join(", ")}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function WorkspacePanel() {
  const view = useWorkspace((s) => s.view);
  const progress = useWorkspace((s) => s.progress);
  const stepCount = useWorkspace((s) => s.steps.length);
  const viewingStep = useWorkspace((s) => s.viewingStep);
  const returnToLatest = useWorkspace((s) => s.returnToLatest);

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <ApprovalCard />

      {/* Looking at an earlier result. Say so, or the numbers on screen will be
          read as the current ones. */}
      {viewingStep !== null && (
        <div className="mb-5 flex items-center gap-3 rounded-md border border-hair bg-panel px-3.5 py-2">
          <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
          <span className="text-[12px] text-ink2">
            Showing step {viewingStep}, not the latest result.
          </span>
          <button
            onClick={returnToLatest}
            className="ml-auto px-2 py-[3px] text-[11.5px] rounded border border-hair text-ink3 hover:text-ink hover:border-hair2 transition"
          >
            Back to latest
          </button>
        </div>
      )}

      {progress && (
        <div className="mb-5 max-w-md">
          <div className="flex justify-between text-[11.5px] text-ink3 mb-1.5">
            <span>{progress.label}</span>
            <span className="tnum">{(progress.value * 100).toFixed(0)}%</span>
          </div>
          <div className="h-[3px] bg-hair rounded-full overflow-hidden">
            <div
              className="h-full bg-accent transition-[width] duration-150"
              style={{ width: `${progress.value * 100}%` }}
            />
          </div>
        </div>
      )}

      {view.kind !== "empty" && <FindingsPanel />}

      {/* Keyed on the step count so each completed call re-mounts and the
          settle animation replays. Every tool call visibly changes something. */}
      {/* Re-mounting on each step is what replays the settle animation, but the
          empty state owns local state (the question, and whether we had to ask
          which dataset) and must survive the very call it just made. */}
      <div
        key={view.kind === "empty" ? "empty" : stepCount}
        className={view.kind === "empty" ? "h-full" : "settle rounded-md"}
      >
        {view.kind === "empty" && <EmptyState />}
        {view.kind === "dataset" && (
          <div>
            <Heading sub={view.note}>{view.title}</Heading>
            <Panel>
              <Table headers={view.headers} rows={view.rows} />
            </Panel>
          </div>
        )}
        {view.kind === "series" && <SeriesView view={view} />}
        {view.kind === "regression" && <RegressionView view={view} />}
        {view.kind === "correlation" && <CorrelationView view={view} />}
        {view.kind === "backtest" && <BacktestView view={view} />}
        {view.kind === "bootstrap" && <BootstrapView view={view} />}
        {view.kind === "report" && <ReportView view={view} />}
      </div>
    </div>
  );
}
