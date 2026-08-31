import { useMemo } from "react";
import type { ChartConfiguration } from "chart.js";

import { DATASETS, datasetDomains } from "../config";
import { useWorkspace, type WorkspaceView } from "../state/workspace";
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
function EmptyState() {
  return (
    <div className="h-full flex items-center justify-center py-12">
      <div className="max-w-2xl w-full">
        <div className="mb-8">
          <div className="label mb-2">Research workspace</div>
          <h1 className="text-[22px] text-ink tracking-tight">Choose a dataset to begin.</h1>
        </div>

        <div className="flex items-baseline gap-3 mb-3">
          <span className="label">Bundled data</span>
          <span className="text-[11.5px] text-ink3">
            {datasetDomains().join(" · ")}
          </span>
        </div>

        <ul className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
          {DATASETS.map((d) => (
            <li key={d.id} className="border border-hair rounded-md bg-panel px-3.5 py-3">
              <div className="min-w-0">
                <div className="text-[12.5px] text-ink">
                  {d.name}
                  <span className="text-ink3 ml-2 text-[11px]">{d.domain}</span>
                </div>
                <div className="text-[11.5px] text-ink3 leading-relaxed">
                  {d.description.split(".")[0]}.
                </div>
              </div>
            </li>
          ))}
        </ul>
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

export function WorkspacePanel() {
  const view = useWorkspace((s) => s.view);
  const progress = useWorkspace((s) => s.progress);
  const stepCount = useWorkspace((s) => s.steps.length);

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <ApprovalCard />

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

      {/* Keyed on the step count so each completed call re-mounts and the
          settle animation replays. Every tool call visibly changes something. */}
      <div key={stepCount} className={view.kind === "empty" ? "h-full" : "settle rounded-md"}>
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
