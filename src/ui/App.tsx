import { useState } from "react";

import { APP_NAME } from "../config";
import { getTestingSummary, useWorkspace } from "../state/workspace";
import { ActivityLog } from "./ActivityLog";
import { AgentStatus } from "./AgentStatus";
import { Brief } from "./Brief";
import { DevConsole } from "./DevConsole";
import { WorkspacePanel } from "./WorkspacePanel";

/** Full-screen help overlay. */
function HelpPage({ onBack }: { onBack: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-canvas overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-8">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 mb-6 text-[12px] text-ink3 hover:text-ink transition"
        >
          <span aria-hidden="true">&larr;</span> Back to workspace
        </button>

        <h1 className="text-[22px] font-medium text-ink mb-1">{APP_NAME}</h1>
        <p className="text-[13px] text-ink3 mb-8">
          A statistical research bench where AI agents and humans share one live workspace.
          No backend, no API keys — all computation runs in the browser via WebMCP.
        </p>

        <Section title="Getting started">
          <ol className="space-y-3">
            {[
              <>Open <strong className="text-ink font-medium">ChatGPT</strong> and start a new conversation.</>,
              <>Paste or open <code className="text-accent text-[11px]">https://computeopenai.netlify.app/</code> inside ChatGPT's browser.</>,
              <>Ask a plain-language research question — e.g. <em className="text-ink2">"Does industry momentum survive out of sample?"</em></>,
              <>Watch the <strong className="text-ink font-medium">Agent</strong> indicator (top-right): the capability count rises from 4 to 12+ when data loads.</>,
              <>Results appear here as the agent calls tools. You can edit the question or narrow the sample window at any time.</>,
            ].map((step, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="text-[11px] text-ink3 tnum mt-[3px] shrink-0 w-4">{i + 1}.</span>
                <span className="text-[13px] text-ink2 leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        </Section>

        <Section title="Available tools">
          <div className="space-y-2">
            {[
              ["set_hypothesis", "Set the research question and load the matching dataset."],
              ["summary_stats", "Descriptive statistics (mean, SD, skewness, kurtosis, autocorrelation) for selected columns."],
              ["run_regression", "OLS regression with Newey-West HAC standard errors. Coefficients, R², and residual diagnostics."],
              ["hypothesis_test", "Welch t-test, ANOVA, chi-square, paired t, or Jarque-Bera normality test."],
              ["add_feature", "Create derived columns: momentum, log returns, forward returns, realised volatility, z-score, lag."],
              ["run_backtest", "Dollar-neutral momentum backtest with 70/30 train/test split, transaction costs, and out-of-sample metrics."],
              ["bootstrap_strategy", "Stationary block bootstrap to assess whether backtest Sharpe is due to luck."],
              ["correlate", "Pairwise correlation matrix for selected numeric columns."],
              ["record_finding", "Save a finding that cites the run-log steps that produced it. Citations are verified."],
              ["build_report", "Assemble a Markdown research report from the full session log."],
            ].map(([name, desc]) => (
              <div key={name} className="flex items-start gap-3">
                <code className="text-[11px] text-accent shrink-0 mt-[2px] w-36">{name}</code>
                <span className="text-[12.5px] text-ink2 leading-relaxed">{desc}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Datasets">
          <div className="space-y-2">
            {[
              ["industries_daily", "49 US industry portfolios · daily 2015–2025 · factor model research"],
              ["penguins", "344 Antarctic penguins · 3 species · morphology and weight"],
              ["climate", "Global temperature anomalies · 1880–2024 · time series"],
              ["hubble", "24 galaxies · Hubble's 1929 velocity-distance data"],
            ].map(([id, desc]) => (
              <div key={id} className="flex items-start gap-3">
                <code className="text-[11px] text-accent shrink-0 mt-[2px] w-36">{id}</code>
                <span className="text-[12.5px] text-ink2 leading-relaxed">{desc}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Interpreting results">
          <div className="space-y-3 text-[12.5px] text-ink2 leading-relaxed">
            <p>
              <strong className="text-ink font-medium">Adjusted alpha</strong> — every hypothesis tested tightens the threshold. After five tests, significant means p&nbsp;≤&nbsp;0.010, not 0.05. The session counter is always shown in the header.
            </p>
            <p>
              <strong className="text-ink font-medium">HAC standard errors</strong> — regressions use Newey-West heteroskedasticity- and autocorrelation-consistent errors by default. Classical errors are available but should only be used when you have a positive reason to believe residuals are independent.
            </p>
            <p>
              <strong className="text-ink font-medium">Sample window</strong> — narrowing the date range in the sidebar changes what every subsequent tool call operates on, including the agent's. There is no second copy to synchronise.
            </p>
            <p>
              <strong className="text-ink font-medium">Findings</strong> — every finding must cite the run-log step that produced it. The citation is checked against the log; the agent cannot fabricate a result it did not compute.
            </p>
          </div>
        </Section>

        <Section title="Local development">
          <p className="text-[12.5px] text-ink2 leading-relaxed">
            Run <code className="text-accent">npm run dev</code>, then enable the WebMCP flag in Chrome at{" "}
            <code className="text-accent">chrome://flags/#model-context-protocol</code>.
            The page registers tools with ChatGPT automatically when you open it in the browser.
          </p>
        </Section>

        <button
          onClick={onBack}
          className="mt-8 flex items-center gap-1.5 text-[12px] text-ink3 hover:text-ink transition"
        >
          <span aria-hidden="true">&larr;</span> Back to workspace
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-7">
      <h2 className="text-[13px] font-medium text-ink mb-3 pb-2 border-b border-hair">{title}</h2>
      {children}
    </div>
  );
}

/**
 * The session-adjusted significance readout.
 *
 * Permanently visible, because it is the one number a session loses track of.
 * An agent can test five hundred hypotheses a minute and every one of them
 * arrives looking like the first; nothing else in a research stack keeps score.
 */
function SignificanceReadout() {
  const tests = useWorkspace((s) => s.tests);
  const summary = getTestingSummary();
  const last = tests[tests.length - 1];

  const overstated =
    last !== undefined &&
    last.pValue <= summary.naiveAlpha &&
    last.pValue > summary.bonferroniAlpha;

  return (
    <div className="flex items-center gap-5">
      <div className="flex items-baseline gap-2">
        <span className="label">Tested</span>
        <span
          className={`text-[13px] tnum ${
            summary.testsRun > 0 ? "text-accent" : "text-ink2"
          }`}
        >
          {summary.testsRun}
        </span>
      </div>

      <div className="flex items-baseline gap-2">
        {/* Spelled out, not "α": the .label rule uppercases, and CSS maps a
            lowercase alpha to a capital Alpha, which reads as a typo. */}
        <span className="label">Adjusted alpha</span>
        {/* Nothing has been adjusted for yet; showing the naive value under
            that label would be a small lie in the one place the project asks
            to be believed. */}
        <span className="text-[13px] tnum text-ink2">
          {summary.testsRun === 0 ? "—" : summary.bonferroniAlpha.toPrecision(3)}
        </span>
      </div>

      {overstated && (
        <div className="flex items-center gap-2 px-2.5 h-7 rounded border border-neg/40">
          <span className="w-1.5 h-1.5 rounded-full bg-neg shrink-0" />
          <span className="text-[12px] text-neg">
            Latest result is not significant once adjusted
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * The way back out.
 *
 * Until now the only route from a loaded workspace to a different question was
 * reloading the page. Starting over discards the session record, so when there
 * is anything to lose this asks first - the same courtesy the agent gets before
 * an expensive call, applied to the human.
 */
function NewQuestion() {
  const frame = useWorkspace((s) => s.frame);
  const steps = useWorkspace((s) => s.steps);
  const findings = useWorkspace((s) => s.findings);
  const reset = useWorkspace((s) => s.reset);
  const [confirming, setConfirming] = useState(false);

  if (!frame) return null;

  const worthLosing = steps.length > 0 || findings.length > 0;

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] text-ink2">
          Discard {steps.length} step{steps.length === 1 ? "" : "s"}
          {findings.length > 0 &&
            ` and ${findings.length} finding${findings.length === 1 ? "" : "s"}`}
          ?
        </span>
        <button
          onClick={() => {
            reset();
            setConfirming(false);
          }}
          className="px-2 py-[3px] text-[11.5px] rounded bg-accent text-canvas hover:brightness-110 transition"
        >
          Discard
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="px-2 py-[3px] text-[11.5px] rounded border border-hair text-ink3 hover:text-ink transition"
        >
          Keep
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => (worthLosing ? setConfirming(true) : reset())}
      title="Start a new investigation"
      className="flex items-center gap-1.5 px-2.5 h-7 rounded border border-hair text-ink3 hover:text-ink hover:border-hair2 transition"
    >
      <span aria-hidden="true">&larr;</span>
      <span className="text-[12px]">New question</span>
    </button>
  );
}

export function App() {
  const devMode = new URLSearchParams(window.location.search).has("dev");
  const [showHelp, setShowHelp] = useState(false);

  return (
    <div className="h-screen flex flex-col bg-canvas text-ink">
      <header className="h-12 shrink-0 border-b border-hair flex items-center gap-5 px-4">
        <div className="flex items-baseline gap-2.5 shrink-0">
          <span className="text-[15px] tracking-tight text-ink">{APP_NAME}</span>
          <span className="text-[12px] text-ink3 hidden lg:inline">
            Research bench
          </span>
        </div>

        <NewQuestion />

        <div className="ml-auto flex items-center gap-5">
          <SignificanceReadout />
          <AgentStatus />
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <aside className="w-[300px] shrink-0 border-r border-hair min-h-0 bg-panel">
          <Brief />
        </aside>

        <main className="flex-1 min-w-0 min-h-0">
          <WorkspacePanel />
        </main>
      </div>

      <footer className="h-9 shrink-0 border-t border-hair bg-panel flex items-center px-3 gap-3">
        <div className="flex-1 min-w-0">
          <ActivityLog />
        </div>
        <button
          onClick={() => setShowHelp(true)}
          className="shrink-0 flex items-center gap-1 px-2 h-6 rounded border border-hair text-[11px] text-ink3 hover:text-ink hover:border-hair2 transition"
          title="Help & documentation"
        >
          <span aria-hidden="true">?</span>
          <span className="hidden sm:inline">Help</span>
        </button>
      </footer>

      {showHelp && <HelpPage onBack={() => setShowHelp(false)} />}
      {devMode && <DevConsole />}
    </div>
  );
}
