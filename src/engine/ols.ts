/**
 * Ordinary least squares with classical and Newey-West HAC standard errors.
 *
 * The default is HAC, deliberately. Almost every regression this bench will
 * run has overlapping or serially correlated returns on at least one side, and
 * classical standard errors under those conditions are not conservative - they
 * are wrong in the direction that manufactures significance. Making the honest
 * option the default is the only way that fact survives contact with an agent
 * that is optimising for a small p-value.
 */

import {
  accumulateOuter,
  backSubstitute,
  collinearityRatio,
  invertSymmetric,
  matmul,
  quadraticForm,
  submatrix,
  transpose,
  xtxInverseFromR,
  householderQR,
  zeros,
  type Matrix,
} from "./matrix";
import { fUpperTailP, studentTTwoSidedP } from "./dist";

export type StandardErrorKind = "classical" | "newey_west";

export interface Coefficient {
  name: string;
  estimate: number;
  standardError: number;
  tStatistic: number;
  pValue: number;
  ciLow: number;
  ciHigh: number;
}

export interface OlsResult {
  coefficients: Coefficient[];
  /** Fitted values, aligned with the rows handed in. */
  fitted: number[];
  residuals: number[];
  n: number;
  /** Number of estimated parameters, intercept included. */
  k: number;
  degreesOfFreedom: number;
  rSquared: number;
  adjustedRSquared: number;
  /** Joint test that every slope is zero. */
  fStatistic: number;
  fPValue: number;
  standardErrors: StandardErrorKind;
  /** Bartlett bandwidth actually used, null for classical errors. */
  neweyWestLags: number | null;
  residualStandardError: number;
  /** Reported when the design is close to collinear, so the UI can say so. */
  conditionWarning: string | null;
}

/** Newey-West default bandwidth, floor(4 * (n/100)^(2/9)). */
export function defaultNeweyWestLags(n: number): number {
  return Math.max(0, Math.floor(4 * Math.pow(n / 100, 2 / 9)));
}

/**
 * The HAC "meat" matrix S.
 *
 *   S = sum_t e_t^2 x_t x_t^T
 *     + sum_{l=1..L} w_l sum_t e_t e_{t-l} (x_t x_{t-l}^T + x_{t-l} x_t^T)
 *
 * with Bartlett weights w_l = 1 - l/(L+1), which is what guarantees S stays
 * positive semi-definite.
 */
function neweyWestMeat(X: Matrix, residuals: number[], lags: number): Matrix {
  const n = X.length;
  const k = X[0].length;
  const S = zeros(k, k);

  for (let t = 0; t < n; t++) {
    accumulateOuter(S, X[t], X[t], residuals[t] * residuals[t]);
  }

  for (let l = 1; l <= lags; l++) {
    const w = 1 - l / (lags + 1);
    if (w <= 0) continue;
    for (let t = l; t < n; t++) {
      const scale = w * residuals[t] * residuals[t - l];
      if (scale === 0) continue;
      // Both cross terms, which is what makes S symmetric.
      accumulateOuter(S, X[t], X[t - l], scale);
      accumulateOuter(S, X[t - l], X[t], scale);
    }
  }
  return S;
}

export interface OlsOptions {
  standardErrors?: StandardErrorKind;
  neweyWestLags?: number;
  /** Names for the columns of X, intercept excluded. */
  regressorNames?: string[];
  /** Prepend a column of ones. Default true. */
  includeIntercept?: boolean;
}

/**
 * Fit y on X.
 *
 * X is passed WITHOUT an intercept column unless includeIntercept is false;
 * the intercept is prepended here so that the joint F test knows which
 * coefficient to exclude.
 */
export function ols(y: number[], X: Matrix, options: OlsOptions = {}): OlsResult {
  const {
    standardErrors = "newey_west",
    regressorNames,
    includeIntercept = true,
  } = options;

  const nRaw = y.length;
  if (nRaw === 0) throw new Error("ols: no observations");
  if (X.length !== nRaw) throw new Error("ols: X and y have different row counts");

  const design: Matrix = includeIntercept
    ? X.map((row) => [1, ...row])
    : X.map((row) => row.slice());

  const n = design.length;
  const k = design[0].length;
  if (n <= k) {
    throw new Error(
      `ols: need more observations than parameters, got n=${n} k=${k}`,
    );
  }

  const names = includeIntercept
    ? ["intercept", ...(regressorNames ?? X[0].map((_, i) => `x${i + 1}`))]
    : (regressorNames ?? X[0].map((_, i) => `x${i + 1}`));

  const qr = householderQR(design, y);
  const beta = backSubstitute(qr.R, qr.qtb);

  const fitted = design.map((row) => {
    let s = 0;
    for (let j = 0; j < k; j++) s += row[j] * beta[j];
    return s;
  });
  const residuals = y.map((yi, i) => yi - fitted[i]);

  let ssResidual = 0;
  for (const e of residuals) ssResidual += e * e;

  const yMean = y.reduce((a, b) => a + b, 0) / n;
  let ssTotal = 0;
  for (const yi of y) ssTotal += (yi - yMean) * (yi - yMean);

  const df = n - k;
  const sigma2 = ssResidual / df;
  const xtxInv = xtxInverseFromR(qr.R);

  let covariance: Matrix;
  let lagsUsed: number | null = null;

  if (standardErrors === "classical") {
    covariance = xtxInv.map((row) => row.map((v) => v * sigma2));
  } else {
    lagsUsed = options.neweyWestLags ?? defaultNeweyWestLags(n);
    const meat = neweyWestMeat(design, residuals, lagsUsed);
    covariance = matmul(matmul(xtxInv, meat), xtxInv);
  }

  const coefficients: Coefficient[] = beta.map((estimate, j) => {
    const variance = covariance[j][j];
    const se = variance > 0 ? Math.sqrt(variance) : NaN;
    const t = se > 0 ? estimate / se : NaN;
    const p = Number.isFinite(t) ? studentTTwoSidedP(t, df) : NaN;
    // 95% interval using the same t reference distribution as the p-value.
    const critical = tCritical95(df);
    return {
      name: names[j] ?? `x${j}`,
      estimate,
      standardError: se,
      tStatistic: t,
      pValue: p,
      ciLow: estimate - critical * se,
      ciHigh: estimate + critical * se,
    };
  });

  const rSquared = ssTotal > 0 ? 1 - ssResidual / ssTotal : NaN;
  const adjustedRSquared = ssTotal > 0 ? 1 - (1 - rSquared) * ((n - 1) / df) : NaN;

  const { fStatistic, fPValue } = jointFTest(
    beta,
    covariance,
    includeIntercept,
    rSquared,
    k,
    df,
    standardErrors,
  );

  return {
    coefficients,
    fitted,
    residuals,
    n,
    k,
    degreesOfFreedom: df,
    rSquared,
    adjustedRSquared,
    fStatistic,
    fPValue,
    standardErrors,
    neweyWestLags: lagsUsed,
    residualStandardError: Math.sqrt(sigma2),
    conditionWarning: describeConditioning(design, qr.fullRank),
  };
}

/** Collinearity thresholds, on the scale-invariant ratio. */
const RANK_DEFICIENT_RATIO = 1e-8;
const NEAR_COLLINEAR_RATIO = 1e-2;

/**
 * Turn the collinearity ratio into something worth reading.
 *
 * The thresholds are the Belsley-Kuh-Welsch rules of thumb: a condition number
 * above 100 (ratio below 1e-2) is a design worth warning about, and anything
 * near 1e-8 has lost half the available precision and is not identified at all.
 */
function describeConditioning(design: Matrix, fullRank: boolean): string | null {
  const ratio = collinearityRatio(design);

  if (!fullRank || ratio < RANK_DEFICIENT_RATIO) {
    return "Design matrix is rank deficient: at least one regressor is a linear combination of the others. Drop one of them.";
  }
  if (ratio < NEAR_COLLINEAR_RATIO) {
    const conditionNumber = Math.round(1 / ratio);
    return `Design matrix is close to collinear (condition number about ${conditionNumber}). Individual coefficients and their standard errors are unstable even though the fit as a whole is fine.`;
  }
  return null;
}

/**
 * Joint significance of the slopes.
 *
 * With classical errors this is the textbook R-squared form. With HAC errors
 * that form is not valid, so it becomes a Wald statistic built from the same
 * robust covariance matrix and divided by the number of restrictions.
 */
function jointFTest(
  beta: number[],
  covariance: Matrix,
  includeIntercept: boolean,
  rSquared: number,
  k: number,
  df: number,
  kind: StandardErrorKind,
): { fStatistic: number; fPValue: number } {
  const slopeIndices: number[] = [];
  for (let j = includeIntercept ? 1 : 0; j < k; j++) slopeIndices.push(j);
  const q = slopeIndices.length;

  if (q === 0) return { fStatistic: NaN, fPValue: NaN };

  if (kind === "classical") {
    const f = (rSquared / q) / ((1 - rSquared) / df);
    return { fStatistic: f, fPValue: fUpperTailP(f, q, df) };
  }

  const subCov = submatrix(covariance, slopeIndices, slopeIndices);
  const inv = invertSymmetric(subCov);
  if (!inv) return { fStatistic: NaN, fPValue: NaN };

  const slopes = slopeIndices.map((j) => beta[j]);
  const wald = quadraticForm(slopes, inv);
  const f = wald / q;
  return { fStatistic: f, fPValue: fUpperTailP(f, q, df) };
}

/**
 * Two-sided 95% t critical value. Bisection on the CDF: called once per
 * regression, so the cost is irrelevant and it avoids a second special
 * function inverse.
 */
function tCritical95(df: number): number {
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (studentTTwoSidedP(mid, df) > 0.05) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Convenience wrapper: build the design matrix from named column vectors.
 * Rows where any input is not finite are dropped, and the count is reported so
 * a caller can tell the agent how much data the alignment cost.
 */
export function olsFromColumns(
  yValues: number[],
  regressors: { name: string; values: number[] }[],
  options: Omit<OlsOptions, "regressorNames"> = {},
): { result: OlsResult; droppedRows: number; keptIndices: number[] } {
  const n = yValues.length;
  const keptIndices: number[] = [];
  const y: number[] = [];
  const X: Matrix = [];

  for (let i = 0; i < n; i++) {
    const yi = yValues[i];
    if (!Number.isFinite(yi)) continue;
    const row = regressors.map((r) => r.values[i]);
    if (row.some((v) => !Number.isFinite(v))) continue;
    keptIndices.push(i);
    y.push(yi);
    X.push(row);
  }

  if (y.length === 0) {
    throw new Error(
      "ols: every row was dropped because of missing values; check that the columns overlap in time",
    );
  }

  const result = ols(y, X, {
    ...options,
    regressorNames: regressors.map((r) => r.name),
  });
  return { result, droppedRows: n - y.length, keptIndices };
}

/** Exposed for tests: X^T X without the QR route, to check the QR path. */
export function normalEquationsCheck(X: Matrix): Matrix {
  return matmul(transpose(X), X);
}
