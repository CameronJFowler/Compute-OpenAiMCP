/**
 * Session tools: what is available, what is loaded, and what state we are in.
 */

import { DATASETS, findDataset } from "../../config";
import { routedDataset } from "../../engine/dataset-router";
import { countFinite, dateRange, uniqueEntities } from "../../engine/frame";
import { loadDataset as loadDatasetFile } from "../../engine/loader";
import { moments } from "../../engine/stats";
import {
  getEffectiveFrame,
  getTestingSummary,
  useWorkspace,
  signalColumnNames,
} from "../../state/workspace";
import { availability, newlyAvailable } from "../availability";
import type { ToolDescriptor } from "../host";
import { describeDatasetSchema, loadDatasetSchema } from "../schemas";
import { defineTool, fmt, readString, readStringArray, type ToolOutcome } from "./common";

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
      "Loads one of the bundled datasets into the workspace and rebuilds the tool surface around it. After this call, the analysis tools exist and their column arguments are enums containing this dataset's real column names - so you cannot name a column that is not there. Call list_datasets first if you do not know the ids.",
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

      return {
        ok: true,
        summary: [
          routeLine,
          `Loaded ${entry.id}: ${frame.nRows} rows, ${frame.columnOrder.length} columns.`,
          range ? `Dates ${range.start} to ${range.end}.` : "No date dimension.",
          frame.entities ? `${uniqueEntities(frame).length} entities.` : "Single series.",
          `Columns: ${frame.columnOrder.join(", ")}`,
          `NOTE: ${entry.semanticNote}`,
          `TOOL SURFACE CHANGED. Now available: ${gained.join(", ")}. Their column arguments are enums of the columns above.`,
        ].join("\n"),
        structured: {
          dataset: entry.id,
          selected_from_question: route !== undefined,
          matched_terms: route?.matchedTerms ?? [],
          n_rows: frame.nRows,
          columns: frame.columnOrder,
          newly_available_tools: gained,
        },
        digest: `loaded ${entry.id}: ${frame.nRows} rows, ${frame.columnOrder.length} cols`,
        next: ["describe_dataset", "add_feature", "run_regression"],
      };
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
