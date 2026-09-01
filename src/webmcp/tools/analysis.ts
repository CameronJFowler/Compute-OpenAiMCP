/**
 * Analysis tools: describe, correlate, regress, test.
 *
 * The two tools that produce a p-value both register it with the session
 * counter before they write their summary, so the multiple-testing block they
 * print already includes the test they just ran. An agent cannot read the
 * result without also reading how many hypotheses have now been tested and what
 * that does to the threshold.
 */

import { chi2UpperTailP, fUpperTailP, studentTTwoSidedP } from "../../engine/dist";
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

/**
 * What every branch below produces, so the recording, the view and the
 * multiple-testing block are written once rather than five times.
 */
interface TestComputation {
  nullHypothesis: string;
  statisticName: string;
  statistic: number;
  df: number | null;
  pValue: number;
  detail: string;
  /** Label for the session test counter. */
  label: string;
  /** Extra rows for the workspace table, above the statistic. */
  rows?: { label: string; values: string[] }[];
  /** Appended to the summary, for caveats the reader has to see. */
  caution?: string;
}

type Failure = { ok: false; error: string; hint: string; valid?: unknown };

function isFailure<T>(value: T | Failure): value is Failure {
  return typeof value === "object" && value !== null && (value as Failure).ok === false;
}

export function hypothesisTestTool(
  numericColumns: string[],
  categoryColumns: string[],
  categoryLabels: string[],
): ToolDescriptor {
  return defineTool({
    name: "hypothesis_test",
    description:
      "Runs a named statistical test, states the null hypothesis in words, and reports the statistic, degrees of freedom and p-value with the decision at both the naive threshold and the session-adjusted one. one_sample_t: does a column's mean differ from a value. two_sample_t: Welch's test, comparing one measurement across two groups (pass group_column with group_a and group_b) or two different measurements (pass other_column). anova: one-way F test comparing a measurement across ALL groups of a categorical column at once - use this instead of running every pair through two_sample_t, which inflates the error rate. chi_square: are two categorical columns independent. paired_t: is the mean row-by-row difference zero. jarque_bera: is a column normally distributed. Every call adds to the session test counter.",
    inputSchema: hypothesisTestSchema(numericColumns, categoryColumns, categoryLabels),
    annotations: { readOnlyHint: true },
    run: (input, ctx): ToolOutcome => {
      const { frame, failure } = requireFrame();
      if (!frame) return failure;

      const malformed = checkNumericArguments(input, [["mu", "number"]]);
      if (malformed) return malformed;

      const test = readString(input, "test");
      const validTests = [
        "one_sample_t", "two_sample_t", "paired_t",
        "jarque_bera", "anova", "chi_square",
      ];
      if (!test || !validTests.includes(test)) {
        return {
          ok: false,
          error: `unknown test "${test}"`,
          hint: "Pick one of the supported tests.",
          valid: validTests,
        };
      }

      /** A categorical column with its labels, or a teaching failure. */
      const categorical = (
        key: string,
      ): { name: string; labels: string[]; values: string[] } | Failure => {
        const name = readString(input, key);
        if (!name) {
          return {
            ok: false,
            error: `${key} is required for ${test}`,
            hint: "Name a column of labels, not measurements.",
            valid: categoryColumns,
          };
        }
        const column = frame.columns[name];
        if (!column || column.kind !== "category" || !column.labels) {
          return {
            ok: false,
            error: `"${name}" is not a categorical column`,
            hint: `${key} has to be a column of labels. This dataset's categorical columns are listed.`,
            valid: categoryColumns,
          };
        }
        return {
          name,
          labels: column.labels,
          values: [...new Set(column.labels.filter((l) => l !== ""))].sort(),
        };
      };

      const computed = ((): TestComputation | Failure => {
        // ---- chi_square: two categorical columns, no measurement -----------
        if (test === "chi_square") {
          const first = categorical("group_column");
          if (isFailure(first)) return first;
          const second = categorical("second_group_column");
          if (isFailure(second)) return second;

          if (first.name === second.name) {
            return {
              ok: false,
              error: `group_column and second_group_column are both "${first.name}"`,
              hint: "A column is perfectly dependent on itself. Name two different categorical columns.",
              valid: categoryColumns,
            };
          }

          const rowLabels = first.values;
          const colLabels = second.values;
          if (rowLabels.length < 2 || colLabels.length < 2) {
            return {
              ok: false,
              error: `a contingency test needs at least two categories in each column (${first.name} has ${rowLabels.length}, ${second.name} has ${colLabels.length})`,
              hint: "Pick columns that actually vary.",
            };
          }

          const observed = rowLabels.map(() => colLabels.map(() => 0));
          let total = 0;
          for (let i = 0; i < frame.nRows; i++) {
            const r = rowLabels.indexOf(first.labels[i]);
            const c = colLabels.indexOf(second.labels[i]);
            if (r < 0 || c < 0) continue;
            observed[r][c]++;
            total++;
          }
          if (total === 0) {
            return {
              ok: false,
              error: "no rows have both labels present",
              hint: "The two columns do not overlap in this sample window.",
            };
          }

          const rowTotals = observed.map((row) => row.reduce((a, b) => a + b, 0));
          const colTotals = colLabels.map((_, c) =>
            observed.reduce((sum, row) => sum + row[c], 0),
          );

          let statistic = 0;
          let smallestExpected = Infinity;
          for (let r = 0; r < rowLabels.length; r++) {
            for (let c = 0; c < colLabels.length; c++) {
              const expected = (rowTotals[r] * colTotals[c]) / total;
              if (expected < smallestExpected) smallestExpected = expected;
              if (expected > 0) {
                statistic += (observed[r][c] - expected) ** 2 / expected;
              }
            }
          }

          const df = (rowLabels.length - 1) * (colLabels.length - 1);
          return {
            nullHypothesis: `H0: ${first.name} and ${second.name} are independent.`,
            statisticName: "chi-square",
            statistic,
            df,
            pValue: chi2UpperTailP(statistic, df),
            detail: `${total} rows, ${rowLabels.length}x${colLabels.length} table`,
            label: `chi_square:${first.name}x${second.name}`,
            rows: rowLabels.map((label, r) => ({
              label,
              values: [...observed[r].map(String), String(rowTotals[r])],
            })),
            caution:
              smallestExpected < 5
                ? `The smallest expected count is ${fmt(smallestExpected, 1)}. Below about 5 the chi-square approximation is unreliable, so treat this p-value as indicative rather than exact.`
                : undefined,
          };
        }

        // Everything else needs a measurement column.
        const columnName = readString(input, "column");
        if (!columnName || !frame.columns[columnName]) {
          return {
            ok: false,
            error: `column "${columnName}" does not exist`,
            hint: "Name a numeric column from the current dataset.",
            valid: numericColumns,
          };
        }
        const primary = frame.columns[columnName];

        // ---- jarque_bera ---------------------------------------------------
        if (test === "jarque_bera") {
          const jb = jarqueBera(primary.values);
          return {
            nullHypothesis: `H0: ${columnName} is drawn from a normal distribution.`,
            statisticName: "JB",
            statistic: jb.statistic,
            df: 2,
            pValue: chi2UpperTailP(jb.statistic, 2),
            detail: `skew=${fmt(jb.skewness, 3)} excess kurtosis=${fmt(jb.excessKurtosis, 3)} n=${jb.n}`,
            label: `jarque_bera:${columnName}`,
          };
        }

        // ---- one_sample_t --------------------------------------------------
        if (test === "one_sample_t") {
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
          const statistic = (m - mu) / se;
          const df = values.length - 1;
          return {
            nullHypothesis: `H0: the mean of ${columnName} equals ${mu}.`,
            statisticName: "t",
            statistic,
            df,
            pValue: studentTTwoSidedP(statistic, df),
            detail: `mean=${fmt(m, 6)} sd=${fmt(sd, 6)} se=${fmt(se, 6)} n=${values.length}`,
            label: `one_sample_t:${columnName}`,
          };
        }

        // ---- anova: one measurement across every group ---------------------
        if (test === "anova") {
          const group = categorical("group_column");
          if (isFailure(group)) return group;

          const samples: { label: string; values: number[] }[] = [];
          for (const label of group.values) {
            const values: number[] = [];
            for (let i = 0; i < frame.nRows; i++) {
              if (group.labels[i] !== label) continue;
              const v = primary.values[i];
              if (Number.isFinite(v)) values.push(v);
            }
            if (values.length >= 2) samples.push({ label, values });
          }

          if (samples.length < 2) {
            return {
              ok: false,
              error: `only ${samples.length} group(s) of ${group.name} have enough data for ${columnName}`,
              hint: "An F test needs at least two groups with two or more observations each.",
              valid: group.values,
            };
          }

          const total = samples.reduce((n, s) => n + s.values.length, 0);
          const grandMean =
            samples.reduce((sum, s) => sum + s.values.reduce((a, b) => a + b, 0), 0) / total;

          let betweenSS = 0;
          let withinSS = 0;
          for (const sample of samples) {
            const m = mean(sample.values);
            betweenSS += sample.values.length * (m - grandMean) ** 2;
            for (const v of sample.values) withinSS += (v - m) ** 2;
          }

          const dfBetween = samples.length - 1;
          const dfWithin = total - samples.length;
          if (dfWithin <= 0 || withinSS <= 0) {
            return {
              ok: false,
              error: "the groups have no within-group variation, so an F ratio is undefined",
              hint: "Check that the measurement actually varies inside each group.",
            };
          }

          const statistic = (betweenSS / dfBetween) / (withinSS / dfWithin);
          const pairs = (samples.length * (samples.length - 1)) / 2;

          return {
            nullHypothesis: `H0: mean ${columnName} is the same across all ${samples.length} groups of ${group.name}.`,
            statisticName: "F",
            statistic,
            df: dfBetween,
            pValue: fUpperTailP(statistic, dfBetween, dfWithin),
            detail: `F(${dfBetween}, ${dfWithin}), n=${total}`,
            label: `anova:${columnName}~${group.name}`,
            rows: samples.map((s) => ({
              label: s.label,
              values: [String(s.values.length), fmt(mean(s.values), 4), fmt(standardDeviation(s.values), 4)],
            })),
            caution:
              pairs > 1
                ? `This is one test. Comparing the ${samples.length} groups pairwise instead would have been ${pairs} tests, and the session threshold would have tightened accordingly - which is the reason to prefer the omnibus test when the question is whether the groups differ at all.`
                : undefined,
          };
        }

        // ---- two_sample_t by group -----------------------------------------
        if (test === "two_sample_t" && readString(input, "group_column")) {
          const group = categorical("group_column");
          if (isFailure(group)) return group;

          const groupA = readString(input, "group_a");
          const groupB = readString(input, "group_b");
          if (!groupA || !groupB) {
            return {
              ok: false,
              error: "group_a and group_b are both required when group_column is given",
              hint: `Name the two groups of ${group.name} to compare, or use anova to compare all of them at once.`,
              valid: group.values,
            };
          }
          if (groupA === groupB) {
            return {
              ok: false,
              error: `group_a and group_b are both "${groupA}"`,
              hint: "Comparing a group with itself has no null hypothesis. Pick two different groups.",
              valid: group.values,
            };
          }
          const unknown = [groupA, groupB].filter((g) => !group.values.includes(g));
          if (unknown.length > 0) {
            return {
              ok: false,
              error: `${group.name} has no group called ${unknown.map((u) => `"${u}"`).join(" or ")}`,
              hint: "Group labels are case sensitive. describe_dataset lists the column.",
              valid: group.values,
            };
          }

          const sampleA: number[] = [];
          const sampleB: number[] = [];
          for (let i = 0; i < frame.nRows; i++) {
            const value = primary.values[i];
            if (!Number.isFinite(value)) continue;
            if (group.labels[i] === groupA) sampleA.push(value);
            else if (group.labels[i] === groupB) sampleB.push(value);
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
          const statistic = (meanA - meanB) / Math.sqrt(varA + varB);
          const df =
            (varA + varB) ** 2 /
            (varA ** 2 / (sampleA.length - 1) + varB ** 2 / (sampleB.length - 1));

          return {
            nullHypothesis: `H0: mean ${columnName} is the same for ${groupA} and ${groupB}.`,
            statisticName: "t (Welch)",
            statistic,
            df,
            pValue: studentTTwoSidedP(statistic, df),
            detail: `${groupA}: mean=${fmt(meanA, 4)} n=${sampleA.length} | ${groupB}: mean=${fmt(meanB, 4)} n=${sampleB.length} | difference=${fmt(meanA - meanB, 4)}`,
            label: `two_sample_t:${columnName}~${group.name}`,
          };
        }

        // ---- paired_t and two_sample_t across two columns -------------------
        const otherName = readString(input, "other_column");
        if (!otherName || !frame.columns[otherName]) {
          return {
            ok: false,
            error: `${test} needs either group_column (to split ${columnName} by a category) or other_column (to compare two measurements), and neither was usable`,
            hint: "For a group comparison pass group_column, group_a and group_b. For a column comparison pass other_column. To compare more than two groups at once, use anova.",
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
          const statistic = m / se;
          const df = differences.length - 1;
          return {
            nullHypothesis: `H0: the mean of (${columnName} - ${otherName}) is zero.`,
            statisticName: "t",
            statistic,
            df,
            pValue: studentTTwoSidedP(statistic, df),
            detail: `mean difference=${fmt(m, 6)} se=${fmt(se, 6)} n=${differences.length}`,
            label: `paired_t:${columnName}-${otherName}`,
          };
        }

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
        const statistic = (ma - mb) / Math.sqrt(va + vb);
        const df =
          (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));

        return {
          nullHypothesis: `H0: ${columnName} and ${otherName} have the same mean.`,
          statisticName: "t (Welch)",
          statistic,
          df,
          pValue: studentTTwoSidedP(statistic, df),
          detail: `mean ${columnName}=${fmt(ma, 6)} (n=${a.length}), mean ${otherName}=${fmt(mb, 6)} (n=${b.length})`,
          label: `two_sample_t:${columnName}-${otherName}`,
        };
      })();

      if (isFailure(computed)) return computed;

      ctx.recordTest(computed.label, computed.pValue);
      const summary = getTestingSummary();
      const verdict = judge(computed.pValue, summary);

      useWorkspace.getState().setView({
        kind: "dataset",
        title: `${test}: ${computed.nullHypothesis}`,
        headers:
          test === "chi_square"
            ? ["group", "observed counts by category", "", "total"].slice(0, (computed.rows?.[0]?.values.length ?? 1) + 1)
            : test === "anova"
              ? ["group", "n", "mean", "sd"]
              : ["quantity", "value"],
        rows: [
          ...(computed.rows ?? []),
          { label: computed.statisticName, values: [fmt(computed.statistic, 4)] },
          { label: "df", values: [computed.df === null ? "-" : fmt(computed.df, 2)] },
          { label: "p", values: [fmt(computed.pValue, 5)] },
          { label: "naive alpha 0.05", values: [verdict.naive] },
          {
            label: `Bonferroni ${fmt(summary.bonferroniAlpha, 5)}`,
            values: [verdict.bonferroni],
          },
        ],
        note: computed.detail,
      });

      return {
        ok: true,
        summary: [
          computed.nullHypothesis,
          `${computed.statisticName}=${fmt(computed.statistic, 4)}${computed.df === null ? "" : ` df=${fmt(computed.df, 2)}`} p=${fmt(computed.pValue, 5)}`,
          computed.detail,
          computed.caution ?? "",
          formatMultipleTestingBlock(computed.pValue, summary),
        ]
          .filter(Boolean)
          .join("\n"),
        structured: {
          test,
          statistic: computed.statistic,
          df: computed.df,
          p_value: computed.pValue,
          naive: verdict.naive,
          bonferroni: verdict.bonferroni,
          tests_run: summary.testsRun,
        },
        pValue: computed.pValue,
        digest: `${test}: p=${fmt(computed.pValue, 4)} (${verdict.bonferroni} after adjustment)`,
        next: ["record_finding", "run_regression", "build_report"],
      };
    },
  });
}
