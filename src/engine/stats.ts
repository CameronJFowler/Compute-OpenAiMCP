/**
 * Descriptive statistics, autocorrelation and correlation matrices.
 *
 * Every function here ignores non-finite entries rather than propagating them,
 * because a derived column always starts with NaN during its warm-up window and
 * a mean that came back NaN would be useless in exactly the normal case.
 */

const TRADING_DAYS_PER_YEAR = 252;

export interface Moments {
  n: number;
  missing: number;
  mean: number;
  sd: number;
  /** Fisher-Pearson sample skewness. */
  skewness: number;
  /** Excess kurtosis: normal is 0, not 3. */
  excessKurtosis: number;
  min: number;
  max: number;
  median: number;
}

export function finiteValues(values: number[]): number[] {
  return values.filter((v) => Number.isFinite(v));
}

export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/** Sample standard deviation, denominator n-1. */
export function standardDeviation(values: number[]): number {
  const n = values.length;
  if (n < 2) return NaN;
  const m = mean(values);
  let s = 0;
  for (const v of values) s += (v - m) * (v - m);
  return Math.sqrt(s / (n - 1));
}

export function quantile(sortedValues: number[], q: number): number {
  const n = sortedValues.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedValues[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (pos - lo) * (sortedValues[hi] - sortedValues[lo]);
}

export function moments(rawValues: number[]): Moments {
  const values = finiteValues(rawValues);
  const n = values.length;
  const missing = rawValues.length - n;

  if (n === 0) {
    return {
      n: 0, missing, mean: NaN, sd: NaN, skewness: NaN,
      excessKurtosis: NaN, min: NaN, max: NaN, median: NaN,
    };
  }

  const m = mean(values);
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  let min = Infinity;
  let max = -Infinity;

  for (const v of values) {
    const d = v - m;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  m2 /= n;
  m3 /= n;
  m4 /= n;

  const sd = n > 1 ? Math.sqrt((m2 * n) / (n - 1)) : NaN;
  const skewness = m2 > 0 ? m3 / Math.pow(m2, 1.5) : NaN;
  const excessKurtosis = m2 > 0 ? m4 / (m2 * m2) - 3 : NaN;

  const sorted = [...values].sort((a, b) => a - b);

  return {
    n, missing, mean: m, sd, skewness, excessKurtosis,
    min, max, median: quantile(sorted, 0.5),
  };
}

/**
 * Sample autocorrelation at the given lags.
 *
 * Uses the biased (divide by n) estimator, which is what every time-series
 * package reports by default and what keeps the ACF positive semi-definite.
 */
export function autocorrelation(rawValues: number[], lags: number[]): Map<number, number> {
  const values = finiteValues(rawValues);
  const n = values.length;
  const out = new Map<number, number>();
  if (n < 3) {
    for (const l of lags) out.set(l, NaN);
    return out;
  }

  const m = mean(values);
  let denominator = 0;
  for (const v of values) denominator += (v - m) * (v - m);

  for (const lag of lags) {
    if (lag <= 0 || lag >= n || denominator === 0) {
      out.set(lag, NaN);
      continue;
    }
    let numerator = 0;
    for (let t = lag; t < n; t++) numerator += (values[t] - m) * (values[t - lag] - m);
    out.set(lag, numerator / denominator);
  }
  return out;
}

/** Annualisation helpers for columns that hold daily returns. */
export function annualisedMean(dailyMean: number): number {
  return dailyMean * TRADING_DAYS_PER_YEAR;
}

export function annualisedVolatility(dailySd: number): number {
  return dailySd * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/**
 * Annualised Sharpe ratio of a daily return series.
 *
 * The guard is not decoration. The standard deviation of a list of identical
 * doubles is a tiny positive number rather than exactly zero, because the mean
 * of n copies of x is not bit-identical to x once it has been through a
 * sequential sum. Without the relative test, a portfolio that earns the same
 * amount every day - one that never trades, say - reports a Sharpe ratio of
 * around 1e18 instead of saying the ratio is undefined.
 */
export function annualisedSharpe(returns: number[]): number {
  const values = finiteValues(returns);
  if (values.length < 2) return NaN;
  const m = mean(values);
  const sd = standardDeviation(values);
  if (!(sd > 0) || sd <= Math.abs(m) * 1e-12) return NaN;
  return (m / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/** Pairwise-complete Pearson correlation. */
export function pearson(a: number[], b: number[]): { r: number; n: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      xs.push(a[i]);
      ys.push(b[i]);
    }
  }
  const m = xs.length;
  if (m < 3) return { r: NaN, n: m };

  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < m; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const denominator = Math.sqrt(sxx * syy);
  return { r: denominator === 0 ? NaN : sxy / denominator, n: m };
}

/** Average ranks, so that ties do not bias the Spearman coefficient. */
function rank(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((p, q) => p.v - q.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[indexed[k].i] = averageRank;
    i = j + 1;
  }
  return ranks;
}

export function spearman(a: number[], b: number[]): { r: number; n: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      xs.push(a[i]);
      ys.push(b[i]);
    }
  }
  if (xs.length < 3) return { r: NaN, n: xs.length };
  return pearson(rank(xs), rank(ys));
}

export interface CorrelationMatrix {
  names: string[];
  /** Symmetric, unit diagonal. */
  values: number[][];
  /** Pairwise-complete observation counts. */
  counts: number[][];
  method: "pearson" | "spearman";
}

export function correlationMatrix(
  columns: { name: string; values: number[] }[],
  method: "pearson" | "spearman" = "pearson",
): CorrelationMatrix {
  const k = columns.length;
  const values: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(NaN));
  const counts: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const fn = method === "pearson" ? pearson : spearman;

  for (let i = 0; i < k; i++) {
    values[i][i] = 1;
    counts[i][i] = columns[i].values.filter((v) => Number.isFinite(v)).length;
    for (let j = i + 1; j < k; j++) {
      const { r, n } = fn(columns[i].values, columns[j].values);
      values[i][j] = r;
      values[j][i] = r;
      counts[i][j] = n;
      counts[j][i] = n;
    }
  }
  return { names: columns.map((c) => c.name), values, counts, method };
}

/**
 * Jarque-Bera test of normality. The statistic is chi-square with 2 df under
 * the null; the p-value is computed by the caller so this stays dependency
 * free at the module level.
 */
export function jarqueBera(rawValues: number[]): { statistic: number; n: number; skewness: number; excessKurtosis: number } {
  const m = moments(rawValues);
  if (m.n < 4 || !Number.isFinite(m.skewness)) {
    return { statistic: NaN, n: m.n, skewness: m.skewness, excessKurtosis: m.excessKurtosis };
  }
  const statistic =
    (m.n / 6) * (m.skewness * m.skewness + (m.excessKurtosis * m.excessKurtosis) / 4);
  return { statistic, n: m.n, skewness: m.skewness, excessKurtosis: m.excessKurtosis };
}

/** Maximum peak-to-trough decline of a cumulative wealth series. */
export function maxDrawdown(wealth: number[]): { maxDrawdown: number; peakIndex: number; troughIndex: number } {
  let peak = -Infinity;
  let peakIndex = 0;
  let worst = 0;
  let worstPeak = 0;
  let worstTrough = 0;

  for (let i = 0; i < wealth.length; i++) {
    if (wealth[i] > peak) {
      peak = wealth[i];
      peakIndex = i;
    }
    const drawdown = peak > 0 ? wealth[i] / peak - 1 : 0;
    if (drawdown < worst) {
      worst = drawdown;
      worstPeak = peakIndex;
      worstTrough = i;
    }
  }
  return { maxDrawdown: worst, peakIndex: worstPeak, troughIndex: worstTrough };
}
