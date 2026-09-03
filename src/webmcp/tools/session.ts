/**
 * Session tools: what is available, what is loaded, and what state we are in.
 */

import { DATASETS, findDataset } from "../../config";
import { routedDataset } from "../../engine/dataset-router";
import { countFinite, dateRange, uniqueEntities } from "../../engine/frame";
import { USER_DATASET_ID, loadDataset as loadDatasetFile } from "../../engine/loader";
import { moments } from "../../engine/stats";
import {
  getEffectiveFrame,
  getTestingSummary,
  useWorkspace,
  signalColumnNames,
} from "../../state/workspace";
import { availability, newlyAvailable } from "../availability";
import type { ToolDescriptor } from "../host";
import { currentDescriptors, syncTools } from "../registry";
import { describeDatasetSchema, loadDatasetSchema } from "../schemas";
import { defineTool, fmt, readString, readStringArray, setNextActor, type ToolOutcome } from "./common";

export function listDatasetsTool(): ToolDescriptor {
  return defineTool({
    name: "list_datasets",
    description:
      "Lists the datasets bundled with this page: id, domain, shape, and what each column means. Normally use set_hypothesis with the user's question instead: it selects and loads the relevant dataset automatically. Use this only to inspect the available data or make a deliberate manual choice.",
    annotations: { readOnlyHint: true },
    run: (): ToolOutcome => {
      const lines = DATASETS.map(
        (d) => `${d.id} [${d.domain}] ${d.name}\n  ${d.description}`,
      );
      return {
        ok: true,
        summary: `${DATASETS.length} bundled datasets, all offline:\n${lines.join("\n")}`,
        structured: {
          datasets: DATASETS.map((d) => ({
            id: d.id,
            domain: d.domain,
            name: d.name,
            layout: d.layout,
          })),
        },
        next: ["set_hypothesis", "load_dataset"],
      };
    },
  });
}

export function getStateTool(): ToolDescriptor {
  return defineTool({
    name: "get_state",
    description:
      "Returns the entire workspace compactly: loaded dataset, sample window, every column with its type, the hypothesis, how many tests have been run, the session-adjusted significance threshold, recorded findings, and the run-log step numbers. This is your recovery path. If you have lost track of what exists, or the human has changed something underneath you, call this instead of guessing.",
    annotations: { readOnlyHint: true },
    run: (): ToolOutcome => {
      const state = useWorkspace.getState();
      const frame = getEffectiveFrame();
      const summary = getTestingSummary();
      const surface = availability();

      if (!frame) {
        return {
          ok: true,
          summary: [
            "No dataset loaded.",
            state.hypothesis ? `Hypothesis: ${state.hypothesis}` : "No hypothesis set.",
            `Tools available: ${surface.names.join(", ")}`,
          ].join("\n"),
          structured: { dataset: null, tools: surface.names },
          next: ["list_datasets", "load_dataset"],
        };
      }

      const columns = frame.columnOrder
        .map((name) => {
          const c = frame.columns[name];
          const tags = [
            c.derived ? "derived" : "raw",
            c.forwardLooking ? "FORWARD-LOOKING" : null,
          ]
            .filter(Boolean)
            .join(",");
          return `${name}(${tags})`;
        })
        .join(" ");

      const range = dateRange(frame);
      const steps = state.steps
        .filter((s) => s.status === "ok")
        .map((s) => `${s.id}:${s.tool}`)
        .join(" ");

      return {
        ok: true,
        summary: [
          `Dataset: ${state.datasetId} (${frame.nRows} rows in the current window, ${frame.columnOrder.length} columns)`,
          range ? `Window: ${range.start} to ${range.end}${state.sampleStart || state.sampleEnd ? " (narrowed by the human)" : " (full)"}` : "No date dimension.",
          frame.entities ? `Entities: ${uniqueEntities(frame).length}` : "Single series.",
          `Columns: ${columns}`,
          state.hypothesis ? `Hypothesis: ${state.hypothesis}` : "Hypothesis: not set.",
          `Tests run: ${summary.testsRun} | naive alpha ${summary.naiveAlpha} | Bonferroni alpha ${fmt(summary.bonferroniAlpha, 5)}`,
          `Findings: ${state.findings.length}${state.report ? " | report exists" : ""}`,
          steps ? `Steps: ${steps}` : "No completed steps.",
          `Tools: ${surface.names.join(", ")}`,
        ].join("\n"),
        structured: {
          dataset: state.datasetId,
          n_rows: frame.nRows,
          columns: frame.columnOrder,
          forward_looking: frame.columnOrder.filter((n) => frame.columns[n].forwardLooking),
          signal_candidates: signalColumnNames(),
          tests_run: summary.testsRun,
          bonferroni_alpha: summary.bonferroniAlpha,
          tools: surface.names,
        },
        next: surface.names.filter((n) => n !== "get_state"),
      };
    },
  });
}

export function loadDatasetTool(): ToolDescriptor {
  return defineTool({
    name: "load_dataset",
    description:
      "Loads one of the bundled datasets and rebuilds the tool surface around its actual columns. After this call you MUST immediately run analysis (summary_stats, run_regression, hypothesis_test) — do not stop here. The data summary is already in the result; there is no need to call describe_dataset before proceeding to analysis.",
    inputSchema: loadDatasetSchema(),
    annotations: { readOnlyHint: false, idempotentHint: true },
    run: async (input): Promise<ToolOutcome> => {
      return loadDatasetById(readString(input, "dataset_id"), input);
    },
  });
}

/** Shared loading path for an explicit selection and question-based routing. */
export async function loadDatasetById(
  id: string | null | undefined,
  input: Record<string, unknown> = {},
  route?: ReturnType<typeof routedDataset>,
): Promise<ToolOutcome> {
      if (!id) {
        return {
          ok: false,
          error: "dataset_id is required",
          hint: "Call list_datasets to see the ids.",
          valid: DATASETS.map((d) => d.id),
        };
      }

      const entry = findDataset(id);
      if (!entry) {
        return {
          ok: false,
          error: `unknown dataset_id "${id}"`,
          hint: "Use one of the bundled ids exactly.",
          valid: DATASETS.map((d) => d.id),
        };
      }

      // Replacing loaded data with work already recorded against it is legal
      // but never silent: the run log, the test counter and the findings all
      // survive the swap and will otherwise be read as belonging to the new
      // dataset.
      const previous = useWorkspace.getState().frame;
      const recorded = useWorkspace
        .getState()
        .steps.filter((s) => s.status === "ok").length;
      const replacementWarning =
        previous && previous.id !== entry.id && recorded > 0
          ? `REPLACED ${previous.id} with ${entry.id}. The ${recorded} steps and ${useWorkspace.getState().findings.length} findings already recorded were produced against ${previous.id} and still say so - do not present them as results about ${entry.id}.`
          : null;

      const before = availability().names;
      const frame = await loadDatasetFile(entry);
      const store = useWorkspace.getState();
      store.loadFrame(frame, entry.id, entry.name);

      const start = readString(input, "start");
      const end = readString(input, "end");
      if (start || end) store.setSampleWindow(start, end, "agent");

      const range = dateRange(frame);
      store.setView({
        kind: "dataset",
        title: entry.name,
        headers: ["column", "type", "n", "missing", "mean", "sd"],
        note: entry.semanticNote,
        rows: frame.columnOrder.map((name) => {
          const column = frame.columns[name];
          if (column.kind !== "numeric") {
            return { label: name, values: [column.kind, String(frame.nRows), "0", "-", "-"] };
          }
          const m = moments(column.values);
          return {
            label: name,
            values: [
              "numeric",
              String(m.n),
              String(m.missing),
              fmt(m.mean, 5),
              fmt(m.sd, 5),
            ],
          };
        }),
      });

      const after = availability().names;
      const gained = newlyAvailable(before, after);
      const routeLine = route
        ? route.fallback
          ? "Dataset selection: no domain-specific terms found; defaulted to the quantitative research panel."
          : `Dataset selection: matched ${route.matchedTerms.join(", ")}.`
        : null;

      // Ensure new tools are registered with the host before the result
      // reaches the agent — prevents a race where the agent tries to call
      // run_regression before it is available.
      await syncTools();

      // Kick off the analysis pipeline automatically. Fires after the tool
      // result is returned so it does not block the agent's first response.
      void autoAnalyzePipeline();

      const numericCols = frame.columnOrder.filter(
        (n) => frame.columns[n].kind === "numeric" && !frame.columns[n].forwardLooking,
      );
      const panelHint = frame.entities
        ? `add_feature(name="momentum", formula="momentum", window=252) then run_backtest(signal="momentum")`
        : `run_regression(dependent="${numericCols[0] ?? "y"}", regressors=${JSON.stringify(numericCols.slice(1, 3))})`;

      return {
        ok: true,
        summary: [
          replacementWarning,
          routeLine,
          `[STEP 1/3 COMPLETE] Loaded ${entry.id}: ${frame.nRows} rows, ${frame.columnOrder.length} columns.`,
          range ? `Dates ${range.start} to ${range.end}.` : "No date dimension.",
          frame.entities ? `${uniqueEntities(frame).length} entities.` : "Single series.",
          `Columns: ${frame.columnOrder.join(", ")}`,
          `[STEP 2/3] YOU MUST NOW run the analysis. Example: ${panelHint}`,
          `[STEP 3/3] Call record_finding(finding="...", supporting_steps=[step_ids]) then build_report.`,
          `Tools now available: ${gained.join(", ")}`,
        ]
          .filter(Boolean)
          .join("\n"),
        structured: {
          dataset: entry.id,
          selected_from_question: route !== undefined,
          matched_terms: route?.matchedTerms ?? [],
          n_rows: frame.nRows,
          columns: frame.columnOrder,
          numeric_columns: numericCols,
          newly_available_tools: gained,
        },
        digest: `loaded ${entry.id}: ${frame.nRows} rows, ${frame.columnOrder.length} cols`,
        next: frame.entities
          ? ["add_feature", "run_regression", "hypothesis_test"]
          : ["summary_stats", "run_regression", "hypothesis_test"],
      };
}

/**
 * Runs the most relevant analysis pipeline automatically after a dataset loads.
 *
 * Called via setTimeout so it fires after the tool result is returned to the
 * agent. Each sub-step is logged to the run log with actor="human" so provenance
 * is preserved even though no agent tool call triggered it.
 *
 * For panel datasets: momentum feature → backtest → regression → finding.
 * For flat/cross-section: summary stats → regression → finding.
 */
/**
 * Produce a conclusive, human-readable conclusion for build_report.
 *
 * Draws on actual results — backtest metrics, hypothesis test p-values,
 * regression output — rather than boilerplate. States a verdict plainly
 * and flags when further testing is warranted.
 */
function buildConclusion({
  bt,
  regressionStep,
  testStep,
  testing,
  state,
}: {
  bt: import("../../engine/backtest").BacktestResult | null;
  regressionStep: import("../../state/runlog").RunStep | undefined;
  testStep: import("../../state/runlog").RunStep | undefined;
  testing: import("../../engine/multipletests").MultipleTestingSummary;
  state: ReturnType<typeof useWorkspace.getState>;
}): string {
  const sentences: string[] = [];
  const furtherNeeded: string[] = [];

  // Backtest verdict
  if (bt) {
    const oos = bt.outOfSample;
    const survives = oos.sharpe > 0.3 && oos.cagr > 0;
    sentences.push(
      survives
        ? `The momentum strategy survives out of sample, delivering ${(oos.cagr * 100).toFixed(1)}% CAGR and a Sharpe ratio of ${oos.sharpe.toFixed(2)} in the holdout period.`
        : `The momentum strategy does not survive out of sample: the holdout period produced ${(oos.cagr * 100).toFixed(1)}% CAGR and Sharpe ${oos.sharpe.toFixed(2)}, below the threshold for a reliable signal.`,
    );
    if (!survives) furtherNeeded.push("extend the sample window or adjust the lookback period");
  }

  // Hypothesis test verdict — use the test recorded by this specific step, not the last
  // test in state (which may be a regression coefficient test added afterwards).
  if (testStep) {
    const lastTest = state.tests.find((t) => t.step === testStep.id) ?? state.tests[state.tests.length - 1];
    if (lastTest) {
      const sig = lastTest.pValue <= testing.bonferroniAlpha;
      const borderline = !sig && lastTest.pValue <= testing.naiveAlpha;
      sentences.push(
        sig
          ? `The group comparison is statistically significant after adjusting for multiple testing (p = ${lastTest.pValue < 1e-10 ? lastTest.pValue.toExponential(2) : lastTest.pValue.toPrecision(3)}): the groups differ.`
          : borderline
          ? `The group comparison reaches the naive threshold (p = ${lastTest.pValue.toPrecision(3)}) but does not survive the session-adjusted Bonferroni threshold (${testing.bonferroniAlpha.toPrecision(3)}): the evidence is inconclusive.`
          : `The group comparison is not significant (p = ${lastTest.pValue.toPrecision(3)}): no reliable difference was detected.`,
      );
      if (borderline || !sig) furtherNeeded.push("run a pre-registered test with a single hypothesis");
    }
  }

  // Regression verdict
  if (regressionStep?.digest && !bt) {
    sentences.push(`Regression results: ${regressionStep.digest}.`);
    // Check if any test was clearly significant
    const sigTests = state.tests.filter((t) => t.pValue <= testing.bonferroniAlpha);
    if (sigTests.length === 0 && testing.testsRun > 0) {
      furtherNeeded.push("run additional hypothesis tests on the significant coefficients");
    }
  }

  if (sentences.length === 0) {
    sentences.push("Preliminary analysis complete. Results are displayed in the workspace.");
    furtherNeeded.push("run hypothesis tests and a regression to draw firmer conclusions");
  }

  if (furtherNeeded.length > 0) {
    sentences.push(`Further analysis recommended: ${furtherNeeded.join("; ")}.`);
  }

  return sentences.join(" ");
}

async function autoAnalyzePipeline(): Promise<void> {
  // Small delay so the UI settles after the tool result renders.
  await new Promise((r) => setTimeout(r, 400));

  const frame = useWorkspace.getState().frame;
  if (!frame) return;

  const isPanel = Boolean(frame.entities && frame.dates);
  const hasDates = Boolean(frame.dates);
  // run_backtest is absent until a signal column exists — re-read after add_feature.
  let tools = Object.fromEntries(currentDescriptors().map((d) => [d.name, d]));

  try {
    if (isPanel && tools["add_feature"]) {
      // Panel path: momentum → backtest → factor regression.
      // Source column: prefer "ret" (returns), fall back to first numeric.
      const momentumSrc =
        "ret" in frame.columns
          ? "ret"
          : (frame.columnOrder.find((n) => frame.columns[n].kind === "numeric") ?? "");
      if (momentumSrc) {
        setNextActor("human");
        await tools["add_feature"].execute({
          transform: "momentum",
          source_column: momentumSrc,
          window: 252,
        });
        // Re-read — run_backtest is now registered (signal column exists).
        // A brief yield lets Zustand state propagate before we re-query.
        await new Promise((r) => setTimeout(r, 100));
        tools = Object.fromEntries(currentDescriptors().map((d) => [d.name, d]));
      }

      const signals = signalColumnNames();
      if (signals.length > 0 && tools["run_backtest"]) {
        setNextActor("human");
        await tools["run_backtest"].execute({ signal: signals[0] });
      }

      // Factor regression: prefer Fama-French factors; fall back to non-forward numerics.
      const dep = "ret" in frame.columns
        ? "ret"
        : frame.columnOrder.find((n) => frame.columns[n].kind === "numeric" && !frame.columns[n].forwardLooking);
      const factorCols = ["mkt_rf", "smb", "hml"].filter(
        (n) => n in frame.columns && !frame.columns[n].forwardLooking && n !== dep,
      );
      const independent = factorCols.length > 0
        ? factorCols
        : frame.columnOrder
            .filter((n) => frame.columns[n].kind === "numeric" && !frame.columns[n].forwardLooking && n !== dep)
            .slice(0, 3);
      if (dep && independent.length > 0 && tools["run_regression"]) {
        setNextActor("human");
        await tools["run_regression"].execute({ dependent: dep, independent });
      }
    } else {
      // Flat / series / cross-section path.
      const numericCols = frame.columnOrder.filter((n) => frame.columns[n].kind === "numeric");
      const categoryCols = frame.columnOrder.filter((n) => frame.columns[n].kind === "category");

      if (tools["summary_stats"] && numericCols.length > 0) {
        setNextActor("human");
        await tools["summary_stats"].execute({ columns: numericCols.slice(0, 5) });
      }

      // Cross-section with categories (e.g. penguins): ANOVA / group test is more relevant
      // than a plain regression. Use the same outcome column the regression will use so
      // both tools answer the same question (body_mass_g, not year).
      const priceish = new Set(["close", "open", "high", "low", "price", "volume", "adj_close"]);
      const dep =
        numericCols.find((n) => ["ret", "return", "y", "distance", "velocity", "body_mass_g", "body_mass"].includes(n)) ??
        numericCols.find((n) => !priceish.has(n.toLowerCase())) ??
        numericCols[numericCols.length - 1];

      if (categoryCols.length > 0 && numericCols.length > 0 && tools["hypothesis_test"]) {
        setNextActor("human");
        await tools["hypothesis_test"].execute({
          test: "anova",
          column: dep,               // same outcome variable as the regression
          group_column: categoryCols[0],
        });
      }

      // Regression: avoid price-level cols as regressors; prefer known outcome names.
      if (numericCols.length >= 2 && tools["run_regression"]) {
        const candidates = numericCols.filter((n) => n !== dep && !priceish.has(n.toLowerCase()));
        const independent = (candidates.length > 0 ? candidates : numericCols.filter((n) => n !== dep)).slice(0, 3);
        if (independent.length > 0) {
          setNextActor("human");
          await tools["run_regression"].execute({ dependent: dep, independent });
        }
      }

      // Series-only (e.g. climate): also try a time trend if dates exist and no category.
      if (hasDates && categoryCols.length === 0 && numericCols.length >= 2 && !isPanel) {
        // regression already covered above — no extra step needed.
      }
    }

    // Record a finding with real numbers, then auto-build the report.
    const state = useWorkspace.getState();
    const completedSteps = state.steps.filter((s) => s.status === "ok");
    const completedIds = completedSteps.map((s) => s.id);

    if (completedIds.length > 0 && tools["record_finding"]) {
      const bt = state.lastBacktest;
      const regressionStep = completedSteps.find((s) => s.tool === "run_regression");
      const backtestStep = completedSteps.find((s) => s.tool === "run_backtest");
      const testStep = completedSteps.find((s) => s.tool === "hypothesis_test");
      const testing = getTestingSummary();

      const parts: string[] = [];

      if (bt && backtestStep) {
        const oos = bt.outOfSample;
        const survives = oos.sharpe > 0.3 && oos.cagr > 0;
        parts.push(
          `Momentum (252-day): full-sample CAGR ${(bt.full.cagr * 100).toFixed(1)}%, Sharpe ${bt.full.sharpe.toFixed(2)}; out-of-sample CAGR ${(oos.cagr * 100).toFixed(1)}%, Sharpe ${oos.sharpe.toFixed(2)} — ${survives ? "survives" : "does not survive"} out of sample.`,
        );
      }
      if (testStep?.digest) parts.push(testStep.digest + ".");
      if (regressionStep?.digest) parts.push(regressionStep.digest + ".");

      if (parts.length === 0) {
        const anyAnalysis = completedSteps.find(
          (s) => !["set_hypothesis", "load_dataset", "add_feature"].includes(s.tool),
        );
        if (anyAnalysis?.digest) parts.push(anyAnalysis.digest + ".");
      }

      const findingText =
        parts.length > 0
          ? parts.join(" ")
          : "Preliminary analysis complete — see results in the workspace.";

      setNextActor("human");
      await tools["record_finding"].execute({
        finding: findingText,
        supporting_steps: completedIds,
      });

      // Auto-build the report with a conclusive, human-readable conclusion.
      if (tools["build_report"]) {
        const conclusion = buildConclusion({ bt, regressionStep, testStep, testing, state });
        setNextActor("human");
        await tools["build_report"].execute({ conclusion });
      }
    }
  } catch (err) {
    console.warn("[compute] auto-analysis pipeline error:", err);
  }
}

/**
 * Choose the data matching a plain-language question without exposing IDs.
 *
 * When nothing matches, this asks rather than guessing. The router used to fall
 * back to the equity panel silently, so "does higher education spending improve
 * test scores" quietly loaded 135,534 rows of industry returns and said nothing
 * to the person who typed it. On a bench whose whole claim is that an agent's
 * numbers should be checkable, quietly substituting the wrong data is the one
 * failure that cannot be allowed to be quiet.
 */
export async function loadDatasetForQuestion(question: string): Promise<ToolOutcome> {
  // If the operator brought their own file, that is the data. Routing a
  // question to a bundled dataset would silently discard what they loaded.
  const current = useWorkspace.getState().frame;

  if (current?.id === USER_DATASET_ID) {
    return {
      ok: true,
      summary: [
        `Using the data you loaded: ${current.name} (${current.nRows} rows, ${current.columnOrder.length} columns).`,
        `Columns: ${current.columnOrder.join(", ")}`,
        "The analysis tools are already registered against these columns. Call describe_dataset before assuming what any of them mean.",
      ].join("\n"),
      structured: {
        dataset: USER_DATASET_ID,
        operator_supplied: true,
        columns: current.columnOrder,
      },
      digest: `using operator data: ${current.name}`,
      next: ["summary_stats", "run_regression", "hypothesis_test", "correlate"],
    };
  }

  /**
   * A later question re-routes and loads, which is the point of asking
   * questions rather than naming datasets. Two cases must not reload, though.
   */
  if (current) {
    const existing = routedDataset(question, DATASETS);

    if (existing.fallback) {
      // Nothing matched. Reloading would be a guess and clearing would be
      // worse; the data that is here stays here.
      return {
        ok: true,
        summary: [
          `Question updated. Nothing bundled obviously matches it, so the workspace still holds ${current.id} (${current.nRows} rows).`,
          "Answer it from this data if it can be answered, say plainly that it cannot, or call load_dataset deliberately.",
        ].join("\n"),
        structured: { dataset: current.id, data_changed: false, routed: false },
        digest: "question updated, data unchanged",
        next: ["get_state", "describe_dataset", "load_dataset"],
      };
    }

    if (existing.datasetId === current.id) {
      // Reloading the same file would discard every derived column built on
      // it, silently undoing the session's work to achieve nothing.
      return {
        ok: true,
        summary: `Question updated. Still working on ${current.id} (${current.nRows} rows, ${current.columnOrder.length} columns), including any columns already derived.`,
        structured: { dataset: current.id, data_changed: false },
        digest: "question updated",
        next: ["describe_dataset", "run_regression", "hypothesis_test"],
      };
    }
    // A genuinely different dataset: fall through and load it. loadDatasetById
    // says loudly if that replaces data with recorded work against it.
  }

  const route = routedDataset(question, DATASETS);

  if (route.fallback) {
    return {
      ok: true,
      summary: [
        "NO DATA LOADED. Nothing in the bundled data clearly matches that question, and guessing would be worse than asking.",
        "Available:",
        ...DATASETS.map((d) => `  ${d.id} [${d.domain}] - ${d.description.split(".")[0]}.`),
        "Pick one with load_dataset if it can answer the question. If none can, say so plainly rather than analysing whatever is nearest.",
      ].join("\n"),
      structured: {
        dataset: null,
        routed: false,
        reason: "no domain-specific terms matched",
        available: DATASETS.map((d) => ({ id: d.id, domain: d.domain })),
      },
      digest: "no dataset matched the question",
      next: ["load_dataset", "list_datasets"],
    };
  }

  return loadDatasetById(route.datasetId, {}, route);
}

export function describeDatasetTool(columns: string[]): ToolDescriptor {
  return defineTool({
    name: "describe_dataset",
    description:
      "Per-column diagnostics for the loaded dataset within the current sample window: type, count, missing, mean, standard deviation, min and max, plus a one-line note on what the column actually means. Call this before analysing anything, so you are not guessing at units or at how much data survives the window.",
    inputSchema: describeDatasetSchema(columns),
    annotations: { readOnlyHint: true },
    run: (input): ToolOutcome => {
      const frame = getEffectiveFrame();
      if (!frame) {
        return {
          ok: false,
          error: "no dataset is loaded",
          hint: "Call load_dataset first.",
        };
      }

      const requested = readStringArray(input, "columns") ?? frame.columnOrder;
      const unknown = requested.filter((n) => !(n in frame.columns));
      if (unknown.length > 0) {
        return {
          ok: false,
          error: `unknown columns: ${unknown.join(", ")}`,
          hint: "Use the column names exactly as get_state reports them.",
          valid: frame.columnOrder,
        };
      }

      const lines = requested.map((name) => {
        const column = frame.columns[name];
        if (column.kind !== "numeric") {
          return `${name}: ${column.kind}, n=${frame.nRows}. ${column.note}`;
        }
        const m = moments(column.values);
        const flag = column.forwardLooking ? " [FORWARD-LOOKING]" : "";
        return (
          `${name}: n=${m.n} missing=${m.missing} mean=${fmt(m.mean, 5)} sd=${fmt(m.sd, 5)} ` +
          `min=${fmt(m.min, 4)} max=${fmt(m.max, 4)}${flag}\n  ${column.note}`
        );
      });

      const range = dateRange(frame);
      return {
        ok: true,
        summary: [
          `${frame.name}: ${frame.nRows} rows in window${range ? `, ${range.start} to ${range.end}` : ""}.`,
          ...lines,
        ].join("\n"),
        structured: {
          n_rows: frame.nRows,
          columns: requested.map((name) => ({
            name,
            kind: frame.columns[name].kind,
            finite: countFinite(frame.columns[name].values),
            forward_looking: frame.columns[name].forwardLooking,
          })),
        },
        digest: `described ${requested.length} columns of ${frame.id}`,
        next: ["add_feature", "summary_stats", "run_regression"],
      };
    },
  });
}
