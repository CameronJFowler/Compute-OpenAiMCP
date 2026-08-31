/**
 * Analysis tools: describe, correlate, regress, test.
 *
 * The two tools that produce a p-value both register it with the session
 * counter before they write their summary, so the multiple-testing block they
 * print already includes the test they just ran. An agent cannot read the
 * result without also reading how many hypotheses have now been tested and what
 * that does to the threshold.
 */

import { chi2UpperTailP, studentTTwoSidedP } from "../../engine/dist";
import { getColumn } from "../../engine/frame";
import { formatMultipleTestingBlock, judge } from "../../engine/multipletests";
import { olsFromColumns } from "../../engine/ols";
import {
  annualisedMean,
  annualisedVolatility,
  autocorrelation,
  correlationMatrix,
  finiteValues,
  jarqueBera,
  mean,
  moments,
  standardDeviation,
} from "../../engine/stats";
import {
  getEffectiveFrame,
  getTestingSummary,
  useWorkspace,
} from "../../state/workspace";
import type { ToolDescriptor } from "../host";
import {
  correlateSchema,
  hypothesisTestSchema,
  runRegressionSchema,
  summaryStatsSchema,
} from "../schemas";
import {
  checkNumericArguments,
  defineTool,
  fmt,
  readInteger,
  readNumber,
  readString,
  readStringArray,
  type ToolOutcome,
} from "./common";

const MAX_SCATTER_POINTS = 1500;

function requireFrame() {
  const frame = getEffectiveFrame();
  if (!frame) {
    return {
      frame: null,
      failure: {
        ok: false as const,
        error: "no dataset is loaded",
        hint: "Call load_dataset first. The analysis tools exist only while a dataset is loaded.",
      },
    };
  }
  return { frame, failure: null };
}

// ---------------------------------------------------------------------------

export function summaryStatsTool(numericColumns: string[]): ToolDescriptor {
  return defineTool({
    name: "summary_stats",
    description:
      "Moments and autocorrelation for one or more columns over the current sample window: mean, standard deviation, skewness, excess kurtosis, min, max, and the autocorrelation at lags 1, 5 and 21. Columns that look like daily returns are also reported annualised. Use this to find out whether a series is fat tailed or strongly autocorrelated before you fit anything to it - both change which standard errors are honest.",
    inputSchema: summaryStatsSchema(numericColumns),
    annotations: { readOnlyHint: true },
    run: (input): ToolOutcome => {
      const { frame, failure } = requireFrame();
      if (!frame) return failure;

      const requested = readStringArray(input, "columns");
      if (!requested || requested.length === 0) {
        return {
          ok: false,
          error: "columns is required and must name at least one column",
          hint: "Pass an array of column names.",
          valid: numericColumns,
        };
      }

      const unknown = requested.filter((n) => !frame.columns[n]);
      if (unknown.length > 0) {
        return {
          ok: false,
          error: `unknown columns: ${unknown.join(", ")}`,
          hint: "Names are case sensitive and must match exactly.",
          valid: frame.columnOrder,
        };
      }

      const rows: { label: string; values: string[] }[] = [];
      const lines = requested.map((name) => {
        const column = frame.columns[name];
        const m = moments(column.values);
        const acf = autocorrelation(column.values, [1, 5, 21]);

        // A column whose values sit within a few percent of zero is a return
        // series in all but name, and annualising it is what makes it readable.
        const looksLikeReturn =
          Number.isFinite(m.sd) && m.sd < 0.15 && Math.abs(m.mean) < 0.05;

        rows.push({
          label: name,
          values: [
            String(m.n), fmt(m.mean, 5), fmt(m.sd, 5), fmt(m.skewness, 3),
            fmt(m.excessKurtosis, 3), fmt(acf.get(1) ?? NaN, 3),
          ],
        });

        return [
          `${name}: n=${m.n} mean=${fmt(m.mean, 6)} sd=${fmt(m.sd, 6)} skew=${fmt(m.skewness, 3)} exkurt=${fmt(m.excessKurtosis, 3)} min=${fmt(m.min, 4)} max=${fmt(m.max, 4)}`,
          `  acf(1)=${fmt(acf.get(1) ?? NaN, 3)} acf(5)=${fmt(acf.get(5) ?? NaN, 3)} acf(21)=${fmt(acf.get(21) ?? NaN, 3)}` +
            (looksLikeReturn
              ? ` | annualised mean=${fmt(annualisedMean(m.mean), 4)} vol=${fmt(annualisedVolatility(m.sd), 4)}`
              : ""),
        ].join("\n");
      });

      useWorkspace.getState().setView({
        kind: "dataset",
        title: `summary_stats: ${requested.join(", ")}`,
        headers: ["column", "n", "mean", "sd", "skew", "ex.kurt", "acf(1)"],
        rows,
        note: "Excess kurtosis is zero for a normal distribution. A large acf(1) means classical standard errors will understate uncertainty.",
      });

      return {
        ok: true,
        summary: lines.join("\n"),
        structured: { columns: requested },
        digest: `summary stats for ${requested.join(", ")}`,
        next: ["correlate", "run_regression", "hypothesis_test"],
      };
    },
  });
}

// ---------------------------------------------------------------------------

export function correlateTool(numericColumns: string[]): ToolDescriptor {
  return defineTool({
    name: "correlate",
    description:
      "Pearson and Spearman correlation between two or more columns, over the current sample window, computed pairwise-complete. Renders a heatmap in the workspace. Use it to spot collinearity before a regression: two regressors correlated above about 0.95 will produce unstable coefficients and the regression will say so.",
    inputSchema: correlateSchema(numericColumns),
    annotations: { readOnlyHint: true },
    run: (input): ToolOutcome => {
      const { frame, failure } = requireFrame();
      if (!frame) return failure;

      const requested = readStringArray(input, "columns");
      if (!requested || requested.length < 2) {
        return {
          ok: false,
          error: "correlate needs at least two columns",
          hint: "Pass an array of two or more column names.",
          valid: numericColumns,
        };
      }
      const unknown = requested.filter((n) => !frame.columns[n]);
      if (unknown.length > 0) {
        return {
          ok: false,
          error: `unknown columns: ${unknown.join(", ")}`,
          hint: "Names must match exactly.",
          valid: frame.columnOrder,
        };
      }

      const method = (readString(input, "method") ?? "pearson") as "pearson" | "spearman";
      if (method !== "pearson" && method !== "spearman") {
        return {
          ok: false,
          error: `unknown method "${method}"`,
          hint: "Use pearson or spearman.",
          valid: ["pearson", "spearman"],
        };
      }

      const columns = requested.map((name) => ({
        name,
        values: frame.columns[name].values,
      }));
      const matrix = correlationMatrix(columns, method);

      useWorkspace.getState().setView({
        kind: "correlation",
        title: `${method} correlation`,
        matrix,
      });

      const pairs: string[] = [];
      let strongest = { pair: "", value: 0 };
      for (let i = 0; i < requested.length; i++) {
        for (let j = i + 1; j < requested.length; j++) {
          const r = matrix.values[i][j];
          pairs.push(`${requested[i]} ~ ${requested[j]}: r=${fmt(r, 4)} (n=${matrix.counts[i][j]})`);
          if (Math.abs(r) > Math.abs(strongest.value)) {
            strongest = { pair: `${requested[i]} ~ ${requested[j]}`, value: r };
          }
        }
      }

      const collinear = Math.abs(strongest.value) > 0.95;
      return {
        ok: true,
        summary: [
          `${method} correlation over ${frame.nRows} rows:`,
          ...pairs.slice(0, 20),
          pairs.length > 20 ? `(${pairs.length - 20} further pairs are in the heatmap, not here)` : "",
          collinear
            ? `WARNING: ${strongest.pair} at r=${fmt(strongest.value, 3)} is close to collinear. Using both as regressors will make the individual coefficients meaningless.`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
        structured: { method, columns: requested, strongest_pair: strongest.pair, strongest_r: strongest.value },
        digest: `${method} correlation of ${requested.length} columns`,
        next: ["run_regression", "summary_stats"],
      };
    },
  });
}

// ---------------------------------------------------------------------------

export function runRegressionTool(
  dependents: string[],
  regressors: string[],
): ToolDescriptor {
  return defineTool({
    name: "run_regression",
    description:
      "Fits an ordinary least squares regression on the loaded dataset over the current sample window, and returns per-coefficient estimates, standard errors, t statistics and p-values, plus R-squared, adjusted R-squared, the joint F test and n. Call add_feature first if the regressor you want does not exist yet; check get_state for the current column list. Do not use it for a binary outcome. It defaults to Newey-West standard errors because overlapping and serially correlated returns make classical standard errors too small, which is the direction that manufactures significance - only ask for classical if you have a reason to believe the residuals are independent. Every call adds its coefficients to the session test counter and the result tells you what that does to the significance threshold.",
    inputSchema: runRegressionSchema(dependents, regressors),
    annotations: { readOnlyHint: true },
    run: (input, ctx): ToolOutcome => {
      const { frame, failure } = requireFrame();
      if (!frame) return failure;

      const malformed = checkNumericArguments(input, [["newey_west_lags", "integer"]]);
      if (malformed) return malformed;

      const dependent = readString(input, "dependent");
      const independent = readStringArray(input, "independent");

      if (!dependent) {
        return {
          ok: false,
          error: "dependent is required",
          hint: "Name the column being explained.",
          valid: dependents,
        };
      }
      if (!independent || independent.length === 0) {
        return {
          ok: false,
          error: "independent is required and must contain at least one column",
          hint: "Pass an array of regressor names.",
          valid: regressors,
        };
      }

      const yColumn = getColumn(frame, dependent);
      if (!yColumn) {
        return {
          ok: false,
          error: `dependent column "${dependent}" does not exist`,
          hint: "Create it with add_feature, or pick one that exists.",
          valid: frame.columnOrder,
        };
      }

      const missing = independent.filter((n) => !frame.columns[n]);
      if (missing.length > 0) {
        return {
          ok: false,
          error: `regressor columns do not exist: ${missing.join(", ")}`,
          hint: "Create them with add_feature first, or use existing columns.",
          valid: regressors,
        };
      }

      const lookahead = independent.filter((n) => frame.columns[n].forwardLooking);
      if (lookahead.length > 0) {
        return {
          ok: false,
          error: `these regressors look into the future: ${lookahead.join(", ")}`,
          hint: "A forward-looking column can only be the dependent variable. Predicting a forward return with a forward return is not a finding.",
          valid: regressors,
        };
      }

      const overlap = independent.filter((n) => n === dependent);
      if (overlap.length > 0) {
        return {
          ok: false,
          error: `"${dependent}" appears on both sides of the regression`,
          hint: "Remove it from independent. Regressing a variable on itself gives an R-squared of 1 and means nothing.",
          valid: regressors.filter((n) => n !== dependent),
        };
      }

      const standardErrors =
        (readString(input, "standard_errors") as "classical" | "newey_west" | null) ??
        "newey_west";
      if (standardErrors !== "classical" && standardErrors !== "newey_west") {
        return {
          ok: false,
          error: `unknown standard_errors "${standardErrors}"`,
          hint: "Use newey_west (the default) or classical.",
          valid: ["newey_west", "classical"],
        };
      }

      let fit;
      try {
        fit = olsFromColumns(
          yColumn.values,
          independent.map((name) => ({ name, values: frame.columns[name].values })),
          {
            standardErrors,
            neweyWestLags: readInteger(input, "newey_west_lags") ?? undefined,
          },
        );
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          hint: "This usually means the columns do not overlap in time once missing values are dropped. Call describe_dataset to see how many finite observations each column has in the current window.",
        };
      }

      const { result, droppedRows, keptIndices } = fit;

      // Every slope is a hypothesis test. Reporting only the best one and
      // counting it as a single test is precisely the behaviour this counter
      // exists to make visible, so all of them are registered.
      const slopes = result.coefficients.slice(1);
      for (const c of slopes) ctx.recordTest(`${dependent}~${c.name}`, c.pValue);

      const summaryStats = getTestingSummary();
      const headline = slopes.reduce(
        (best, c) => (Number.isFinite(c.pValue) && c.pValue < best.pValue ? c : best),
        slopes[0] ?? result.coefficients[0],
      );

      // Scatter against the first regressor, plus residuals against fitted.
      const xName = independent[0];
      const xValues = frame.columns[xName].values;
      const stride = Math.max(1, Math.floor(keptIndices.length / MAX_SCATTER_POINTS));
      const scatter: { x: number; y: number }[] = [];
      const residualPoints: { x: number; y: number }[] = [];
      for (let i = 0; i < keptIndices.length; i += stride) {
        const row = keptIndices[i];
        scatter.push({ x: xValues[row], y: yColumn.values[row] });
        residualPoints.push({ x: result.fitted[i], y: result.residuals[i] });
      }

      useWorkspace.getState().setView({
        kind: "regression",
        title: `${dependent} ~ ${independent.join(" + ")}`,
        result,
        dependentName: dependent,
        scatter,
        scatterXLabel: xName,
        residualPoints,
      });

      const coefficientLines = result.coefficients.map(
        (c) =>
          `  ${c.name.padEnd(18)} est=${fmt(c.estimate, 6)} se=${fmt(c.standardError, 6)} t=${fmt(c.tStatistic, 3)} p=${fmt(c.pValue, 4)}`,
      );

      return {
        ok: true,
        summary: [
          `OLS ${dependent} ~ ${independent.join(" + ")}  (n=${result.n}, ${standardErrors}${result.neweyWestLags !== null ? `, ${result.neweyWestLags} lags` : ""})`,
          ...coefficientLines,
          `R2=${fmt(result.rSquared, 4)} adjR2=${fmt(result.adjustedRSquared, 4)} F(${result.k - 1},${result.degreesOfFreedom})=${fmt(result.fStatistic, 3)} p=${fmt(result.fPValue, 4)}`,
          droppedRows > 0
            ? `${droppedRows} rows dropped for missing values; ${result.n} used.`
            : "",
          result.conditionWarning ?? "",
          formatMultipleTestingBlock(headline.pValue, summaryStats),
        ]
          .filter(Boolean)
          .join("\n"),
        structured: {
          dependent,
          independent,
          standard_errors: standardErrors,
          n: result.n,
          r_squared: result.rSquared,
          coefficients: result.coefficients.map((c) => ({
            name: c.name, estimate: c.estimate, se: c.standardError,
            t: c.tStatistic, p: c.pValue,
          })),
          tests_run: summaryStats.testsRun,
          bonferroni_alpha: summaryStats.bonferroniAlpha,
          survives_adjustment: judge(headline.pValue, summaryStats).survivesAdjustment,
        },
        pValue: headline.pValue,
        digest: `OLS ${dependent}~${independent.join("+")}: R2=${fmt(result.rSquared, 3)}, best p=${fmt(headline.pValue, 4)}`,
        next: ["record_finding", "hypothesis_test", "run_backtest", "build_report"],
      };
    },
  });
}

// ---------------------------------------------------------------------------

export function hypothesisTestTool(
  numericColumns: string[],
  categoryColumns: string[],
  categoryLabels: string[],
): ToolDescriptor {
  return defineTool({
    name: "hypothesis_test",
    description:
      "Runs a named statistical test and states the null hypothesis in words alongside the statistic, degrees of freedom and p-value, with the decision at both the naive threshold and the session-adjusted one. one_sample_t asks whether a column's mean differs from a value. two_sample_t is Welch's test and does not assume equal variances: pass group_column with group_a and group_b to split one measurement by a category, which is the usual case, or other_column to compare two different measurements. paired_t tests the mean of the row-by-row difference and needs the two columns aligned on the same rows. jarque_bera tests normality. Every call adds to the session test counter.",
    inputSchema: hypothesisTestSchema(numericColumns, categoryColumns, categoryLabels),
    annotations: { readOnlyHint: true },
    run: (input, ctx): ToolOutcome => {
      const { frame, failure } = requireFrame();
      if (!frame) return failure;

      const malformed = checkNumericArguments(input, [["mu", "number"]]);
      if (malformed) return malformed;

      const test = readString(input, "test");
      const columnName = readString(input, "column");
      const validTests = ["one_sample_t", "two_sample_t", "paired_t", "jarque_bera"];

      if (!test || !validTests.includes(test)) {
        return {
          ok: false,
          error: `unknown test "${test}"`,
          hint: "Pick one of the supported tests.",
          valid: validTests,
        };
      }
      if (!columnName || !frame.columns[columnName]) {
        return {
          ok: false,
          error: `column "${columnName}" does not exist`,
          hint: "Name a column from the current dataset.",
          valid: frame.columnOrder,
        };
      }

      const primary = frame.columns[columnName];
      const otherName = readString(input, "other_column");

      let nullHypothesis: string;
      let statisticName: string;
      let statistic: number;
      let df: number | null;
      let pValue: number;
      let detail: string;

      if (test === "jarque_bera") {
        const jb = jarqueBera(primary.values);
        nullHypothesis = `H0: ${columnName} is drawn from a normal distribution.`;
        statisticName = "JB";
        statistic = jb.statistic;
        df = 2;
        pValue = chi2UpperTailP(jb.statistic, 2);
        detail = `skew=${fmt(jb.skewness, 3)} excess kurtosis=${fmt(jb.excessKurtosis, 3)} n=${jb.n}`;
      } else if (test === "one_sample_t") {
        const values = finiteValues(primary.values);
        if (values.length < 3) {
          return {
            ok: false,
            error: `${columnName} has only ${values.length} finite values in this window`,
            hint: "Widen the sample window, or pick a column with less warm-up.",
          };
        }
        const mu = readNumber(input, "mu") ?? 0;
        const m = mean(values);
        const sd = standardDeviation(values);
        const se = sd / Math.sqrt(values.length);
        statistic = (m - mu) / se;
        df = values.length - 1;
        pValue = studentTTwoSidedP(statistic, df);
        nullHypothesis = `H0: the mean of ${columnName} equals ${mu}.`;
        statisticName = "t";
        detail = `mean=${fmt(m, 6)} sd=${fmt(sd, 6)} se=${fmt(se, 6)} n=${values.length}`;
      } else if (test === "two_sample_t" && readString(input, "group_column")) {
        // Split one measurement by a categorical column. This is what makes the
        // tool usable on any dataset with a factor rather than only on datasets
        // that happen to hold two comparable measurements side by side.
        const groupName = readString(input, "group_column") as string;
        const group = frame.columns[groupName];

        if (!group || group.kind !== "category" || !group.labels) {
          return {
            ok: false,
            error: `"${groupName}" is not a categorical column`,
            hint: "group_column has to be a column of labels, not measurements.",
            valid: frame.columnOrder.filter((n) => frame.columns[n].kind === "category"),
          };
        }

        const labels = group.labels;
        const available = [...new Set(labels.filter((l) => l !== ""))].sort();
        const groupA = readString(input, "group_a");
        const groupB = readString(input, "group_b");

        if (!groupA || !groupB) {
          return {
            ok: false,
            error: "group_a and group_b are both required when group_column is given",
            hint: `Name the two groups of ${groupName} to compare.`,
            valid: available,
          };
        }
        if (groupA === groupB) {
          return {
            ok: false,
            error: `group_a and group_b are both "${groupA}"`,
            hint: "Comparing a group with itself has no null hypothesis. Pick two different groups.",
            valid: available,
          };
        }
        const unknown = [groupA, groupB].filter((g) => !available.includes(g));
        if (unknown.length > 0) {
          return {
            ok: false,
            error: `${groupName} has no group called ${unknown.map((u) => `"${u}"`).join(" or ")}`,
            hint: "Group labels are case sensitive. describe_dataset lists the column.",
            valid: available,
          };
        }

        const sampleA: number[] = [];
        const sampleB: number[] = [];
        for (let i = 0; i < frame.nRows; i++) {
          const value = primary.values[i];
          if (!Number.isFinite(value)) continue;
          if (labels[i] === groupA) sampleA.push(value);
          else if (labels[i] === groupB) sampleB.push(value);
        }

        if (sampleA.length < 3 || sampleB.length < 3) {
          return {
            ok: false,
            error: `too few complete observations: ${groupA} has ${sampleA.length}, ${groupB} has ${sampleB.length}`,
            hint: "Each group needs at least 3 rows where the measurement is present.",
          };
        }

        const meanA = mean(sampleA);
        const meanB = mean(sampleB);
        const varA = standardDeviation(sampleA) ** 2 / sampleA.length;
        const varB = standardDeviation(sampleB) ** 2 / sampleB.length;
        statistic = (meanA - meanB) / Math.sqrt(varA + varB);
        df =
          (varA + varB) ** 2 /
          (varA ** 2 / (sampleA.length - 1) + varB ** 2 / (sampleB.length - 1));
        pValue = studentTTwoSidedP(statistic, df);
        nullHypothesis = `H0: mean ${columnName} is the same for ${groupA} and ${groupB}.`;
        statisticName = "t (Welch)";
        detail = `${groupA}: mean=${fmt(meanA, 4)} n=${sampleA.length} | ${groupB}: mean=${fmt(meanB, 4)} n=${sampleB.length} | difference=${fmt(meanA - meanB, 4)}`;
      } else {
        if (!otherName || !frame.columns[otherName]) {
          return {
            ok: false,
            error: `${test} needs either group_column (to split ${columnName} by a category) or other_column (to compare two measurements), and neither was usable`,
            hint: "For a group comparison pass group_column, group_a and group_b. For a column comparison pass other_column.",
            valid: frame.columnOrder,
          };
        }
        const other = frame.columns[otherName];

        if (test === "paired_t") {
          const differences: number[] = [];
          for (let i = 0; i < frame.nRows; i++) {
            const a = primary.values[i];
            const b = other.values[i];
            if (Number.isFinite(a) && Number.isFinite(b)) differences.push(a - b);
          }
          if (differences.length < 3) {
            return {
              ok: false,
              error: `only ${differences.length} rows have both ${columnName} and ${otherName}`,
              hint: "The columns barely overlap in this window. Check describe_dataset, or widen the window.",
            };
          }
          const m = mean(differences);
          const se = standardDeviation(differences) / Math.sqrt(differences.length);
          statistic = m / se;
          df = differences.length - 1;
          pValue = studentTTwoSidedP(statistic, df);
          nullHypothesis = `H0: the mean of (${columnName} - ${otherName}) is zero.`;
          statisticName = "t";
          detail = `mean difference=${fmt(m, 6)} se=${fmt(se, 6)} n=${differences.length}`;
        } else {
          const a = finiteValues(primary.values);
          const b = finiteValues(other.values);
          if (a.length < 3 || b.length < 3) {
            return {
              ok: false,
              error: "both columns need at least 3 finite values",
              hint: "Widen the sample window.",
            };
          }
          const ma = mean(a);
          const mb = mean(b);
          const va = standardDeviation(a) ** 2 / a.length;
          const vb = standardDeviation(b) ** 2 / b.length;
          statistic = (ma - mb) / Math.sqrt(va + vb);
          // Welch-Satterthwaite.
          df =
            (va + vb) ** 2 /
            (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
          pValue = studentTTwoSidedP(statistic, df);
          nullHypothesis = `H0: ${columnName} and ${otherName} have the same mean.`;
          statisticName = "t (Welch)";
          detail = `mean ${columnName}=${fmt(ma, 6)} (n=${a.length}), mean ${otherName}=${fmt(mb, 6)} (n=${b.length})`;
        }
      }

      ctx.recordTest(`${test}:${columnName}`, pValue);
      const summary = getTestingSummary();
      const verdict = judge(pValue, summary);

      useWorkspace.getState().setView({
        kind: "dataset",
        title: `hypothesis_test: ${test}`,
        headers: ["quantity", "value"],
        rows: [
          { label: "null hypothesis", values: [nullHypothesis] },
          { label: statisticName, values: [fmt(statistic, 4)] },
          { label: "df", values: [df === null ? "-" : fmt(df, 2)] },
          { label: "p", values: [fmt(pValue, 5)] },
          { label: "naive alpha 0.05", values: [verdict.naive] },
          { label: `Bonferroni ${fmt(summary.bonferroniAlpha, 5)}`, values: [verdict.bonferroni] },
        ],
        note: detail,
      });

      return {
        ok: true,
        summary: [
          nullHypothesis,
          `${statisticName}=${fmt(statistic, 4)}${df === null ? "" : ` df=${fmt(df, 2)}`} p=${fmt(pValue, 5)}`,
          detail,
          formatMultipleTestingBlock(pValue, summary),
        ].join("\n"),
        structured: {
          test, column: columnName, statistic, df, p_value: pValue,
          naive: verdict.naive, bonferroni: verdict.bonferroni,
          tests_run: summary.testsRun,
        },
        pValue,
        digest: `${test} on ${columnName}: p=${fmt(pValue, 4)} (${verdict.bonferroni} after adjustment)`,
        next: ["record_finding", "run_regression", "build_report"],
      };
    },
  });
}
