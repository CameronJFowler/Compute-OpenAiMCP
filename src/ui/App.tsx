import { useState } from "react";

import { APP_NAME } from "../config";
import { getTestingSummary, useWorkspace } from "../state/workspace";
import { ActivityLog } from "./ActivityLog";
import { AgentStatus } from "./AgentStatus";
import { Brief } from "./Brief";
import { DevConsole } from "./DevConsole";
import { WorkspacePanel } from "./WorkspacePanel";

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
        <span className="text-[13px] tnum text-ink2">
          {summary.bonferroniAlpha.toPrecision(3)}
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

      <footer className="h-9 shrink-0 border-t border-hair bg-panel">
        <ActivityLog />
      </footer>

      {devMode && <DevConsole />}
    </div>
  );
}
