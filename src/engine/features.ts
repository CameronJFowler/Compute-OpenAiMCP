/**
 * Derived column transforms.
 *
 * Every transform here is causal except forward_return, and that one is
 * labelled at the type level so the tool layer can refuse it as a regressor or
 * a backtest signal. This is not defensive politeness: a forward return used as
 * a predictor produces a beautiful, entirely fictional result, and it is the
 * single most common way a research bench lies to the person operating it.
 *
 * Nothing indexes rows directly. Time-series transforms run over entityGroups,
 * so a return can never be computed across the boundary between two tickers.
 */

import {
  entityGroups,
  dateGroups,
  getColumn,
  type Column,
  type Frame,
} from "./frame";
import { mean, standardDeviation } from "./stats";

/** Standard 12-1 momentum skips the most recent month to avoid reversal. */
export const MOMENTUM_SKIP_DAYS = 21;

export const TRADING_DAYS_PER_YEAR = 252;

export type TransformKind =
  | "log_return"
  | "forward_return"
  | "momentum"
  | "realised_vol"
  | "zscore"
  | "lag"
  | "excess_return";

export const TRANSFORM_KINDS: TransformKind[] = [
  "log_return",
  "forward_return",
  "momentum",
  "realised_vol",
  "zscore",
  "lag",
  "excess_return",
];

export interface FeatureSpec {
  transform: TransformKind;
  sourceColumn: string;
  window?: number;
  horizon?: number;
  name?: string;
  /** Column holding the risk-free rate, for excess_return. */
  riskFreeColumn?: string;
}

export type FeatureOutcome =
  | { ok: true; column: Column }
  | { ok: false; error: string; hint: string; valid?: unknown };

export function defaultFeatureName(spec: FeatureSpec): string {
  const { transform, sourceColumn, window, horizon } = spec;
  switch (transform) {
    case "log_return":
      return `${sourceColumn}_logret`;
    case "forward_return":
      return `${sourceColumn}_fwd${horizon ?? 21}`;
    case "momentum":
      return `${sourceColumn}_mom${window ?? 252}`;
    case "realised_vol":
      return `${sourceColumn}_vol${window ?? 21}`;
    case "zscore":
      return `${sourceColumn}_z`;
    case "lag":
      return `${sourceColumn}_lag${window ?? 1}`;
    case "excess_return":
      return `${sourceColumn}_excess`;
  }
}

/** Documentation strings, surfaced verbatim in describe_dataset and the UI. */
export const TRANSFORM_NOTES: Record<TransformKind, string> = {
  log_return: "Daily log return within each entity: log(p_t / p_{t-1}). Causal.",
  forward_return:
    "FORWARD LOOKING. Simple return from t to t+horizon: p_{t+h}/p_t - 1. Legal as a dependent variable only, never as a regressor or a backtest signal.",
  momentum:
    `Trailing return from t-window to t-${MOMENTUM_SKIP_DAYS}, skipping the most recent month (standard 12-1 construction). Causal.`,
  realised_vol:
    "Trailing standard deviation of daily log returns over window, annualised by sqrt(252). Causal.",
  zscore:
    "Cross-sectional z-score within each date, across entities. This is the factor-work definition, not a time-series z-score.",
  lag: "Value from window rows earlier within the same entity. Causal.",
  excess_return: "Source column minus the risk-free rate on the same date.",
};

function emptySeries(n: number): number[] {
  return new Array<number>(n).fill(NaN);
}

export function buildFeature(frame: Frame, spec: FeatureSpec): FeatureOutcome {
  const source = getColumn(frame, spec.sourceColumn);
  if (!source) {
    return {
      ok: false,
      error: `Column "${spec.sourceColumn}" does not exist in this dataset`,
      hint: "Call get_state or describe_dataset to see the current column list, then retry with a column from it.",
      valid: frame.columnOrder,
    };
  }
  if (source.kind !== "numeric") {
    return {
      ok: false,
      error: `Column "${spec.sourceColumn}" is not numeric`,
      hint: "Transforms operate on numeric columns only.",
    };
  }

  const name = spec.name ?? defaultFeatureName(spec);
  const note = TRANSFORM_NOTES[spec.transform];
  const base = {
    name,
    kind: "numeric" as const,
    derived: true,
    transform: spec.transform,
    sourceColumn: spec.sourceColumn,
    note,
  };

  switch (spec.transform) {
    case "log_return":
      return {
        ok: true,
        column: {
          ...base,
          forwardLooking: false,
          values: withinEntity(frame, source.values, (series, out) => {
            for (let i = 1; i < series.length; i++) {
              const prev = series[i - 1];
              const cur = series[i];
              out[i] = prev > 0 && cur > 0 ? Math.log(cur / prev) : NaN;
            }
          }),
        },
      };

    case "forward_return": {
      const horizon = spec.horizon ?? 21;
      if (!Number.isInteger(horizon) || horizon < 1) {
        return {
          ok: false,
          error: `horizon must be a positive integer, got ${horizon}`,
          hint: "Try horizon 21 for a one-month forward return.",
        };
      }
      return {
        ok: true,
        column: {
          ...base,
          forwardLooking: true,
          values: withinEntity(frame, source.values, (series, out) => {
            for (let i = 0; i + horizon < series.length; i++) {
              const now = series[i];
              const later = series[i + horizon];
              out[i] = now > 0 && Number.isFinite(later) ? later / now - 1 : NaN;
            }
          }),
        },
      };
    }

    case "momentum": {
      const window = spec.window ?? 252;
      if (!Number.isInteger(window) || window <= MOMENTUM_SKIP_DAYS) {
        return {
          ok: false,
          error: `window must be an integer greater than the ${MOMENTUM_SKIP_DAYS}-day skip, got ${window}`,
          hint: "Try window 252 for standard 12-1 momentum.",
        };
      }
      return {
        ok: true,
        column: {
          ...base,
          forwardLooking: false,
          values: withinEntity(frame, source.values, (series, out) => {
            for (let i = window; i < series.length; i++) {
              const start = series[i - window];
              const end = series[i - MOMENTUM_SKIP_DAYS];
              out[i] = start > 0 && end > 0 ? end / start - 1 : NaN;
            }
          }),
        },
      };
    }

    case "realised_vol": {
      const window = spec.window ?? 21;
      if (!Number.isInteger(window) || window < 2) {
        return {
          ok: false,
          error: `window must be an integer of at least 2, got ${window}`,
          hint: "Try window 21 for one-month realised volatility.",
        };
      }
      return {
        ok: true,
        column: {
          ...base,
          forwardLooking: false,
          values: withinEntity(frame, source.values, (series, out) => {
            const returns = emptySeries(series.length);
            for (let i = 1; i < series.length; i++) {
              const prev = series[i - 1];
              const cur = series[i];
              returns[i] = prev > 0 && cur > 0 ? Math.log(cur / prev) : NaN;
            }
            for (let i = window; i < series.length; i++) {
              const slice = returns.slice(i - window + 1, i + 1).filter(Number.isFinite);
              out[i] =
                slice.length >= Math.max(2, Math.floor(window * 0.8))
                  ? standardDeviation(slice) * Math.sqrt(TRADING_DAYS_PER_YEAR)
                  : NaN;
            }
          }),
        },
      };
    }

    case "zscore": {
      if (!frame.dates || !frame.entities) {
        return {
          ok: false,
          error: "zscore is cross-sectional and needs a panel with both dates and entities",
          hint: "This dataset has a single entity, so there is no cross-section to standardise within. Use it on the equities panel, or pick a different transform.",
        };
      }
      const out = emptySeries(frame.nRows);
      for (const rows of dateGroups(frame).values()) {
        const values = rows.map((i) => source.values[i]).filter(Number.isFinite);
        if (values.length < 3) continue;
        const m = mean(values);
        const sd = standardDeviation(values);
        if (!(sd > 0)) continue;
        for (const i of rows) {
          const v = source.values[i];
          out[i] = Number.isFinite(v) ? (v - m) / sd : NaN;
        }
      }
      return { ok: true, column: { ...base, forwardLooking: false, values: out } };
    }

    case "lag": {
      const window = spec.window ?? 1;
      if (!Number.isInteger(window) || window < 1) {
        return {
          ok: false,
          error: `window must be a positive integer, got ${window}`,
          hint: "Try window 1 for a one-period lag.",
        };
      }
      return {
        ok: true,
        column: {
          ...base,
          forwardLooking: false,
          values: withinEntity(frame, source.values, (series, out) => {
            for (let i = window; i < series.length; i++) out[i] = series[i - window];
          }),
        },
      };
    }

    case "excess_return": {
      const rfName =
        spec.riskFreeColumn ??
        frame.columnOrder.find((n) => n.toLowerCase() === "rf") ??
        frame.columnOrder.find((n) => n.toLowerCase().includes("risk_free"));
      if (!rfName) {
        return {
          ok: false,
          error: "no risk-free rate column found in this dataset",
          hint: "excess_return needs a risk-free column (conventionally named rf). Load a dataset that has one, or pick a different transform.",
          valid: frame.columnOrder,
        };
      }
      const rf = getColumn(frame, rfName);
      if (!rf) {
        return {
          ok: false,
          error: `risk-free column "${rfName}" does not exist`,
          hint: "Check the column list with describe_dataset.",
          valid: frame.columnOrder,
        };
      }
      const out = emptySeries(frame.nRows);
      for (let i = 0; i < frame.nRows; i++) {
        const v = source.values[i];
        const r = rf.values[i];
        out[i] = Number.isFinite(v) && Number.isFinite(r) ? v - r : NaN;
      }
      return {
        ok: true,
        column: { ...base, forwardLooking: false, values: out, note: `${note} Risk-free column: ${rfName}.` },
      };
    }
  }
}

/**
 * Run a per-entity transform.
 *
 * `fn` receives one entity's series in date order and writes into a parallel
 * output array; the results are scattered back to their original row positions.
 * Doing it this way means an individual transform cannot get the grouping
 * wrong, because it never sees a row index at all.
 */
function withinEntity(
  frame: Frame,
  values: number[],
  fn: (series: number[], out: number[]) => void,
): number[] {
  const result = emptySeries(frame.nRows);
  for (const rows of entityGroups(frame).values()) {
    const series = rows.map((i) => values[i]);
    const out = emptySeries(series.length);
    fn(series, out);
    for (let k = 0; k < rows.length; k++) result[rows[k]] = out[k];
  }
  return result;
}
