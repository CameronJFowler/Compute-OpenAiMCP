/**
 * Report tools: state the question, record what was found, assemble the write-up.
 *
 * record_finding refuses a claim that does not cite a run-log step that
 * actually ran and succeeded. That is a small check with a specific purpose:
 * it makes fabrication structurally awkward rather than merely discouraged. An
 * agent cannot assert a result it did not compute, because the citation is
 * checked against the log rather than taken on trust.
 */

import { APP_NAME } from "../../config";
import { dateRange, uniqueEntities } from "../../engine/frame";
import { formatStep, formatTranscript } from "../../state/runlog";
import {
  getEffectiveFrame,
  getTestingSummary,
  useWorkspace,
} from "../../state/workspace";
import type { ToolDescriptor } from "../host";
import { buildReportSchema, recordFindingSchema, setHypothesisSchema } from "../schemas";
import { defineTool, fmt, readIntegerArray, readString, type ToolOutcome } from "./common";
import { loadDatasetForQuestion } from "./session";

export function setHypothesisTool(): ToolDescriptor {
  return defineTool({
    name: "set_hypothesis",
    description:
      "Start research from the user's plain-language question. This writes the question into the brief, selects the relevant bundled dataset automatically, loads it, and rebuilds the analysis tools around the actual columns in that data. Call this first whenever the user asks a research question. The human can edit the question at any moment and your next call will see their version.",
    inputSchema: setHypothesisSchema(),
    annotations: { readOnlyHint: false, idempotentHint: true },
    run: async (input): Promise<ToolOutcome> => {
      const hypothesis = readString(input, "hypothesis");
      if (!hypothesis) {
        return {
          ok: false,
          error: "hypothesis is required and must not be empty",
          hint: "State the question in one or two sentences, phrased so that it could turn out to be false.",
        };
      }
      const previous = useWorkspace.getState().hypothesis;
      useWorkspace.getState().setHypothesis(hypothesis, "agent");
      const loaded = await loadDatasetForQuestion(hypothesis);
      if (!loaded.ok) return loaded;

      return {
        ok: true,
        summary: [
          `Hypothesis set: ${hypothesis}`,
          previous ? `(replaced: ${previous})` : "",
          loaded.summary,
          "The question and data are now in the shared workspace.",
        ]
          .filter(Boolean)
          .join("\n"),
        structured: { hypothesis, ...loaded.structured },
        digest: `started research: ${hypothesis.slice(0, 70)}`,
        next: loaded.next,
      };
    },
  });
}

export function recordFindingTool(): ToolDescriptor {
  return defineTool({
    name: "record_finding",
    description:
      "Appends a finding to the brief, citing the run-log steps that produced it. Every finding must reference at least one step that actually ran and succeeded; a citation that does not match the log is refused. Call get_state to see the available step numbers. Record what the analysis showed, including when it showed nothing - a null result that survives the session-adjusted threshold is worth more than a positive one that does not.",
    inputSchema: recordFindingSchema(),
    annotations: { readOnlyHint: false },
    run: (input): ToolOutcome => {
      const text = readString(input, "finding");
      const steps = readIntegerArray(input, "supporting_steps");
      const state = useWorkspace.getState();

      const completed = state.steps.filter((s) => s.status === "ok");
      const available = completed.map((s) => s.id);

      if (!text) {
        return {
          ok: false,
          error: "finding is required and must not be empty",
          hint: "State what you concluded in one or two sentences.",
        };
      }

      if (!steps || steps.length === 0) {
        return {
          ok: false,
          error: "supporting_steps is required: a finding must cite the work that produced it",
          hint: "Pass the run-log step numbers of the calls that support this claim. get_state lists them.",
          valid: available,
        };
      }

      const unknown = steps.filter((id) => !available.includes(id));
      if (unknown.length > 0) {
        return {
          ok: false,
          error: `these steps did not run successfully in this session: ${unknown.join(", ")}`,
          hint: "Only cite steps that actually completed. If the analysis has not been run yet, run it first and then record the finding.",
          valid: available,
        };
      }

      const finding = state.addFinding(text, steps);
      const cited = completed
        .filter((s) => steps.includes(s.id))
        .map((s) => formatStep(s));

      return {
        ok: true,
        summary: [
          `Finding ${finding.id} recorded: ${text}`,
          `Supported by:`,
          ...cited.map((line) => `  ${line}`),
        ].join("\n"),
        structured: { finding_id: finding.id, supporting_steps: steps },
        digest: `finding ${finding.id}: ${text.slice(0, 80)}`,
        next: ["build_report", "run_regression", "run_backtest"],
      };
    },
  });
}

export function buildReportTool(): ToolDescriptor {
  return defineTool({
    name: "build_report",
    description:
      "Assembles a Markdown report from the session: the question, the data and its provenance, the method, the results, the out-of-sample evidence, the multiple-testing position, the limitations, and your conclusion. Everything except the conclusion comes from the run log, so the report cannot claim work that was not done. If a report already exists this asks the human before overwriting it.",
    inputSchema: buildReportSchema(),
    annotations: { readOnlyHint: false },
    run: async (input): Promise<ToolOutcome> => {
      const conclusion = readString(input, "conclusion");
      if (!conclusion) {
        return {
          ok: false,
          error: "conclusion is required",
          hint: "State what you concluded overall. The rest of the report is assembled from the run log.",
        };
      }

      const store = useWorkspace.getState();
      if (store.report) {
        const outcome = await store.requestApproval({
          tool: "build_report",
          title: "Overwrite the existing report?",
          detail: "A report has already been generated for this session. Building a new one replaces it.",
          confirmLabel: "Overwrite report",
        });
        if (outcome === "gate_busy") {
          return {
            ok: false,
            error: "another approval card is already open in the page",
            hint: "Only one approval can be shown at a time, and nobody has declined anything. Wait for the human to resolve the open card, then retry this call unchanged.",
          };
        }
        if (outcome === "declined") {
          return {
            ok: false,
            error: "the human declined to overwrite the existing report",
            hint: "The previous report stands. Record any new conclusions with record_finding instead.",
          };
        }
      }

      const state = useWorkspace.getState();
      const frame = getEffectiveFrame();
      const testing = getTestingSummary();
      const range = frame ? dateRange(frame) : null;

      const successful = state.steps.filter((s) => s.status === "ok");
      const backtest = state.lastBacktest;

      const markdown = [
        `# ${APP_NAME} research report`,
        "",
        `Generated ${new Date().toISOString().slice(0, 19).replace("T", " ")} from a live session. Every number below was produced by a tool call recorded in the run log.`,
        "",
        "## Question",
        "",
        state.hypothesis || "_No hypothesis was set for this session._",
        "",
        "## Data",
        "",
        frame
          ? [
              `- Dataset: \`${state.datasetId}\` - ${state.datasetName}`,
              `- Rows in the analysed window: ${frame.nRows}`,
              range ? `- Window: ${range.start} to ${range.end}${state.sampleStart || state.sampleEnd ? " (narrowed by the operator)" : " (full available range)"}` : "- No time dimension.",
              frame.entities ? `- Entities: ${uniqueEntities(frame).length}` : "- Single series.",
              `- Columns: ${frame.columnOrder.join(", ")}`,
              `- Provenance: ${frame.source}`,
            ].join("\n")
          : "_No dataset was loaded._",
        "",
        "## Method",
        "",
        "Regressions use ordinary least squares solved by Householder QR, with Newey-West heteroskedasticity- and autocorrelation-consistent standard errors by default and a Bartlett kernel at bandwidth `floor(4*(n/100)^(2/9))`. Derived columns are causal except `forward_return`, which is admitted only as a dependent variable. Backtests form positions on the signal known at date t and earn returns from t+1 onward, charge costs on turnover, and split 70/30 chronologically.",
        "",
        "## What was run",
        "",
        "```",
        formatTranscript(successful) || "(nothing)",
        "```",
        "",
        "## Findings",
        "",
        state.findings.length > 0
          ? state.findings
              .map((f) => `${f.id}. ${f.text}\n   _Supported by steps ${f.supportingSteps.join(", ")}._`)
              .join("\n")
          : "_No findings were recorded._",
        "",
        "## Out-of-sample evidence",
        "",
        backtest
          ? [
              `The strategy on \`${backtest.params.signalColumn}\` was split chronologically at ${backtest.splitDate}.`,
              "",
              "| Period | CAGR | Sharpe | Max drawdown |",
              "|---|---|---|---|",
              `| Full | ${(backtest.full.cagr * 100).toFixed(2)}% | ${backtest.full.sharpe.toFixed(2)} | ${(backtest.full.maxDrawdown * 100).toFixed(2)}% |`,
              `| In-sample (70%) | ${(backtest.inSample.cagr * 100).toFixed(2)}% | ${backtest.inSample.sharpe.toFixed(2)} | ${(backtest.inSample.maxDrawdown * 100).toFixed(2)}% |`,
              `| Out-of-sample (30%) | ${(backtest.outOfSample.cagr * 100).toFixed(2)}% | ${backtest.outOfSample.sharpe.toFixed(2)} | ${(backtest.outOfSample.maxDrawdown * 100).toFixed(2)}% |`,
            ].join("\n")
          : "_No backtest was run, so there is no out-of-sample evidence in this session._",
        "",
        "## Multiple testing",
        "",
        testing.testsRun > 0
          ? [
              `${testing.testsRun} hypothesis tests were run in this session.`,
              "",
              `- Naive threshold: ${testing.naiveAlpha}`,
              `- Bonferroni threshold: ${fmt(testing.bonferroniAlpha, 5)}`,
              `- Benjamini-Hochberg declares ${testing.benjaminiHochbergDiscoveries} discoveries, at a threshold of ${fmt(testing.benjaminiHochbergThreshold, 5)}`,
              "",
              "Any p-value in this report should be read against the adjusted thresholds, not the naive one. The session tested many hypotheses; the naive threshold describes a single pre-registered test and does not apply.",
            ].join("\n")
          : "_No hypothesis tests were run._",
        "",
        "## Limitations",
        "",
        [
          "- The industry portfolio returns are value-weighted index returns, not tradeable instruments. A real implementation would face borrow costs, capacity limits and market impact that this backtest does not model.",
          "- Transaction costs are a flat charge on turnover and do not vary with liquidity or volatility.",
          "- The `close` column is a wealth index reconstructed from returns, not a traded price.",
          "- The out-of-sample period is a single contiguous block of one history. It is a check, not a guarantee.",
          state.sampleStart || state.sampleEnd
            ? "- The sample window was narrowed during the session, so results are not over the full available history."
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
        "",
        "## Conclusion",
        "",
        conclusion,
        "",
        "---",
        "",
        `_${APP_NAME}. All computation ran in the browser; no data left the page._`,
      ].join("\n");

      useWorkspace.getState().setReport(markdown);
      useWorkspace.getState().setView({
        kind: "report",
        title: "Research report",
        markdown,
      });

      return {
        ok: true,
        summary: [
          `Report built: ${markdown.length} characters, ${successful.length} steps cited, ${state.findings.length} findings.`,
          `Multiple testing: ${testing.testsRun} tests, Bonferroni alpha ${fmt(testing.bonferroniAlpha, 5)}.`,
          "It is rendered in the workspace and can be downloaded as Markdown. The full text is not returned here - it is in the page.",
        ].join("\n"),
        structured: {
          characters: markdown.length,
          steps_cited: successful.length,
          findings: state.findings.length,
          tests_run: testing.testsRun,
        },
        digest: `report built (${state.findings.length} findings, ${testing.testsRun} tests)`,
        next: ["record_finding", "get_state"],
      };
    },
  });
}
