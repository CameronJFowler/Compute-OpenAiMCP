/**
 * add_feature: derived columns.
 *
 * The interesting part is not the arithmetic - that lives in engine/features.ts
 * and is unit tested - but what happens afterwards. Adding a column changes the
 * tool signature, the registry tears the analysis tools down and registers them
 * again with the new column inside their enums, and the agent's very next call
 * can reference it. Nobody told the agent the schema changed; the schema simply
 * is different the next time it looks.
 */

import { buildFeature, defaultFeatureName, TRANSFORM_KINDS, type TransformKind } from "../../engine/features";
import { entityGroups, uniqueSortedDates } from "../../engine/frame";
import { moments } from "../../engine/stats";
import { getEffectiveFrame, useWorkspace } from "../../state/workspace";
import { availability, newlyAvailable } from "../availability";
import type { ToolDescriptor } from "../host";
import { addFeatureSchema } from "../schemas";
import {
  checkNumericArguments,
  defineTool,
  fmt,
  readInteger,
  readString,
  type ToolOutcome,
} from "./common";

/** At most this many lines on the chart, and this many points per line. */
const MAX_SERIES = 6;
const MAX_POINTS = 500;

/**
 * Build the plot payload for the workspace.
 *
 * This is the split-result mechanism in one function: the agent gets a summary
 * of a few hundred characters, and this pushes a few thousand points into the
 * store for the chart. One tool call, two audiences, and the big object never
 * crosses the boundary to the model.
 */
export function seriesView(columnName: string) {
  const frame = getEffectiveFrame();
  if (!frame) return null;
  const column = frame.columns[columnName];
  if (!column) return null;

  const groups = [...entityGroups(frame).entries()].slice(0, MAX_SERIES);
  const dates = frame.dates;

  const series = groups.map(([label, rows]) => {
    const stride = Math.max(1, Math.floor(rows.length / MAX_POINTS));
    const points: { x: string; y: number }[] = [];
    for (let i = 0; i < rows.length; i += stride) {
      const row = rows[i];
      const y = column.values[row];
      if (Number.isFinite(y)) {
        points.push({ x: dates ? dates[row] : String(i), y });
      }
    }
    return { label, points };
  });

  return series.filter((s) => s.points.length > 0);
}

export function addFeatureTool(numericColumns: string[]): ToolDescriptor {
  return defineTool({
    name: "add_feature",
    description:
      "Creates a derived column and adds it to the dataset, then re-registers the analysis tools so the new column appears inside their schemas immediately. Use this when the variable you want to analyse does not exist yet - you cannot regress on a return if only a price is loaded. momentum is the standard 12-1 construction (trailing return to 21 days ago, so the most recent month is skipped). zscore is cross-sectional within each date, which is what factor work means by a z-score, not a time-series one. forward_return looks ahead by design: it is legal as a regression dependent variable and is refused everywhere else.",
    inputSchema: addFeatureSchema(numericColumns),
    annotations: { readOnlyHint: false },
    run: (input): ToolOutcome => {
      const frame = getEffectiveFrame();
      const fullFrame = useWorkspace.getState().frame;
      if (!frame || !fullFrame) {
        return { ok: false, error: "no dataset is loaded", hint: "Call load_dataset first." };
      }

      const transform = readString(input, "transform") as TransformKind | null;
      if (!transform || !TRANSFORM_KINDS.includes(transform)) {
        return {
          ok: false,
          error: `transform "${input.transform}" is not one of the supported transforms`,
          hint: "Pick one of the listed transforms exactly.",
          valid: TRANSFORM_KINDS,
        };
      }

      const malformed = checkNumericArguments(input, [
        ["window", "integer"],
        ["horizon", "integer"],
      ]);
      if (malformed) return malformed;

      const sourceColumn = readString(input, "source_column");
      if (!sourceColumn) {
        return {
          ok: false,
          error: "source_column is required",
          hint: "Name the column to transform. get_state lists them.",
          valid: numericColumns,
        };
      }

      const spec = {
        transform,
        sourceColumn,
        window: readInteger(input, "window") ?? undefined,
        horizon: readInteger(input, "horizon") ?? undefined,
        name: readString(input, "name") ?? undefined,
      };

      const before = availability().names;

      /**
       * Built against the FULL frame, not the windowed one. A momentum value at
       * date t needs the 252 days before t, and computing it inside a narrowed
       * window would silently discard the warm-up and change the number. The
       * window narrows what gets analysed, never what gets computed.
       */
      const outcome = buildFeature(fullFrame, spec);
      if (!outcome.ok) {
        return { ok: false, error: outcome.error, hint: outcome.hint, valid: outcome.valid };
      }

      const column = outcome.column;
      if (fullFrame.columnOrder.includes(column.name)) {
        return {
          ok: false,
          error: `a column named "${column.name}" already exists`,
          hint: "Pass a different `name`, or use the existing column.",
          valid: fullFrame.columnOrder,
        };
      }

      useWorkspace.getState().addColumn(column);

      const windowed = getEffectiveFrame();
      const stats = moments(windowed?.columns[column.name]?.values ?? column.values);
      const series = seriesView(column.name);
      if (series && series.length > 0) {
        useWorkspace.getState().setView({
          kind: "series",
          title: `${column.name}  (${defaultFeatureName(spec) === column.name ? transform : `${transform}, named ${column.name}`})`,
          series,
          note: column.note,
        });
      }

      const after = availability().names;
      const gained = newlyAvailable(before, after);
      const dates = uniqueSortedDates(fullFrame);
      const warmup = stats.missing > 0 && dates.length > 0
        ? ` The first ${stats.missing} of ${column.values.length} cells are missing: that is the warm-up window, not an error.`
        : "";

      return {
        ok: true,
        summary: [
          `Created ${column.name} from ${sourceColumn} via ${transform}.`,
          `n=${stats.n} missing=${stats.missing} mean=${fmt(stats.mean, 6)} sd=${fmt(stats.sd, 6)} min=${fmt(stats.min, 4)} max=${fmt(stats.max, 4)}`,
          `${column.note}${warmup}`,
          column.forwardLooking
            ? "THIS COLUMN LOOKS AHEAD. It is available as a regression dependent variable and is refused as a regressor and as a backtest signal."
            : "",
          `${column.name} is now inside the schemas of the analysis tools.${gained.length ? ` Newly available: ${gained.join(", ")}.` : ""}`,
        ]
          .filter(Boolean)
          .join("\n"),
        structured: {
          column: column.name,
          transform,
          forward_looking: column.forwardLooking,
          n: stats.n,
          missing: stats.missing,
          newly_available_tools: gained,
        },
        digest: `created ${column.name} (${transform} of ${sourceColumn}), n=${stats.n}`,
        next: gained.length > 0 ? [...gained, "run_regression"] : ["run_regression", "summary_stats"],
      };
    },
  });
}
