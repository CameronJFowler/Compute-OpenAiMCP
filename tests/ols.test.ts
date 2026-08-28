import { describe, expect, it } from "vitest";

import fixtures from "./fixtures/fixtures.json";
import { defaultNeweyWestLags, ols } from "../src/engine/ols";

/**
 * Coefficients are checked against numpy.linalg.lstsq (LAPACK SVD), which is a
 * completely different algorithm from the Householder QR under test. Standard
 * errors, R-squared and the F statistics are checked against a NumPy reference
 * implementation of the same estimators, and every p-value against scipy.
 */
function expectClose(actual: number, expected: number, rtol: number, label: string): void {
  const tolerance = 1e-12 + rtol * Math.abs(expected);
  const difference = Math.abs(actual - expected);
  if (difference > tolerance) {
    throw new Error(
      `${label}: expected ${actual} to be within ${tolerance} of ${expected} (off by ${difference})`,
    );
  }
  expect(difference).toBeLessThanOrEqual(tolerance);
}

type FixtureCase = {
  y: number[];
  X: number[][];
  names: string[];
  reference: Record<string, never>;
};

const cases = fixtures.ols as unknown as Record<string, FixtureCase>;

function checkAgainstReference(
  name: string,
  reference: {
    beta: number[];
    se_classical: number[];
    se_newey_west: number[];
    t_classical: number[];
    t_newey_west: number[];
    p_classical: number[];
    p_newey_west: number[];
    r_squared: number;
    adjusted_r_squared: number;
    f_classical: number;
    f_p_classical: number;
    f_newey_west: number;
    f_p_newey_west: number;
    residual_standard_error: number;
    nw_lags: number;
    n: number;
    k: number;
    df: number;
  },
  y: number[],
  X: number[][],
  names: string[],
  rtol: number,
  neweyWestLags?: number,
): void {
  const classical = ols(y, X, {
    standardErrors: "classical",
    regressorNames: names,
  });
  const hac = ols(y, X, {
    standardErrors: "newey_west",
    regressorNames: names,
    neweyWestLags,
  });

  expect(classical.n).toBe(reference.n);
  expect(classical.k).toBe(reference.k);
  expect(classical.degreesOfFreedom).toBe(reference.df);
  expect(hac.neweyWestLags).toBe(reference.nw_lags);

  reference.beta.forEach((expected, j) => {
    expectClose(classical.coefficients[j].estimate, expected, rtol, `${name} beta[${j}]`);
    // Point estimates do not depend on the covariance estimator.
    expectClose(hac.coefficients[j].estimate, expected, rtol, `${name} hac beta[${j}]`);
  });

  reference.se_classical.forEach((expected, j) => {
    expectClose(classical.coefficients[j].standardError, expected, rtol, `${name} se[${j}]`);
  });
  reference.se_newey_west.forEach((expected, j) => {
    expectClose(hac.coefficients[j].standardError, expected, rtol, `${name} hac se[${j}]`);
  });
  reference.t_classical.forEach((expected, j) => {
    expectClose(classical.coefficients[j].tStatistic, expected, rtol, `${name} t[${j}]`);
  });
  reference.t_newey_west.forEach((expected, j) => {
    expectClose(hac.coefficients[j].tStatistic, expected, rtol, `${name} hac t[${j}]`);
  });
  reference.p_classical.forEach((expected, j) => {
    expectClose(classical.coefficients[j].pValue, expected, Math.max(rtol, 1e-9), `${name} p[${j}]`);
  });
  reference.p_newey_west.forEach((expected, j) => {
    expectClose(hac.coefficients[j].pValue, expected, Math.max(rtol, 1e-9), `${name} hac p[${j}]`);
  });

  expectClose(classical.rSquared, reference.r_squared, rtol, `${name} R2`);
  expectClose(
    classical.adjustedRSquared,
    reference.adjusted_r_squared,
    rtol,
    `${name} adj R2`,
  );
  expectClose(
    classical.residualStandardError,
    reference.residual_standard_error,
    rtol,
    `${name} residual SE`,
  );
  expectClose(classical.fStatistic, reference.f_classical, rtol, `${name} F`);
  expectClose(classical.fPValue, reference.f_p_classical, Math.max(rtol, 1e-9), `${name} F p`);
  expectClose(hac.fStatistic, reference.f_newey_west, rtol, `${name} HAC Wald F`);
  expectClose(
    hac.fPValue,
    reference.f_p_newey_west,
    Math.max(rtol, 1e-9),
    `${name} HAC Wald F p`,
  );
}

describe("defaultNeweyWestLags", () => {
  it("implements floor(4 * (n/100)^(2/9))", () => {
    expect(defaultNeweyWestLags(100)).toBe(4);
    expect(defaultNeweyWestLags(200)).toBe(4);
    expect(defaultNeweyWestLags(1000)).toBe(6);
    // 4 * 25^(2/9) = 8.179...
    expect(defaultNeweyWestLags(2500)).toBe(8);
  });
});

describe("ols against numpy and scipy", () => {
  it("fits a clean two-regressor model", () => {
    const c = cases.clean_two_regressor;
    checkAgainstReference("clean", c.reference as never, c.y, c.X, c.names, 1e-9);
  });

  it("fits Hubble 1929 with the same code path as a factor model", () => {
    const c = cases.hubble_1929;
    checkAgainstReference("hubble", c.reference as never, c.y, c.X, c.names, 1e-9);

    // The slope is Hubble's constant as he measured it: around 450 km/s/Mpc,
    // seven times the modern value, because his distance ladder was wrong.
    const fit = ols(c.y, c.X, { standardErrors: "classical", regressorNames: c.names });
    const slope = fit.coefficients[1];
    expect(slope.name).toBe("distance_mpc");
    expect(slope.estimate).toBeGreaterThan(400);
    expect(slope.estimate).toBeLessThan(500);
    expect(slope.pValue).toBeLessThan(1e-4);
  });

  it("handles strongly autocorrelated errors", () => {
    const c = cases.autocorrelated_errors;
    checkAgainstReference("ar1", c.reference as never, c.y, c.X, c.names, 1e-9);
  });

  it("honours an explicit Newey-West bandwidth", () => {
    const c = cases.autocorrelated_errors;
    checkAgainstReference(
      "ar1-lag8",
      (c as unknown as { reference_lag8: never }).reference_lag8,
      c.y,
      c.X,
      c.names,
      1e-9,
      8,
    );
  });

  /**
   * The reason for HAC being the default. With an AR(1) error of 0.85 the
   * classical standard error is materially too small, so the classical t is
   * materially too large - which is exactly the direction that turns noise
   * into a publishable result.
   */
  it("reports larger standard errors than classical ones under autocorrelation", () => {
    const c = cases.autocorrelated_errors;
    const classical = ols(c.y, c.X, { standardErrors: "classical", regressorNames: c.names });
    const hac = ols(c.y, c.X, { standardErrors: "newey_west", regressorNames: c.names });

    expect(hac.coefficients[1].standardError).toBeGreaterThan(
      classical.coefficients[1].standardError,
    );
    expect(Math.abs(hac.coefficients[1].tStatistic)).toBeLessThan(
      Math.abs(classical.coefficients[1].tStatistic),
    );
  });

  /**
   * Householder QR against near-collinear columns. The coefficients themselves
   * are genuinely unstable here - that is the nature of the design, not a bug -
   * so they get a loose tolerance, while the fitted values and R-squared, which
   * are well determined, get a tight one.
   */
  it("stays accurate on a near-collinear design", () => {
    const c = cases.near_collinear;
    const reference = c.reference as unknown as { beta: number[]; r_squared: number };
    const fit = ols(c.y, c.X, { standardErrors: "classical", regressorNames: c.names });

    expectClose(fit.rSquared, reference.r_squared, 1e-9, "collinear R2");
    reference.beta.forEach((expected, j) => {
      expectClose(fit.coefficients[j].estimate, expected, 1e-4, `collinear beta[${j}]`);
    });
    expect(fit.conditionWarning).toContain("collinear");
  });
});

describe("ols guard rails", () => {
  it("refuses a design with more parameters than observations", () => {
    expect(() => ols([1, 2], [[1, 2, 3], [4, 5, 6]])).toThrow(/more observations/);
  });

  it("refuses mismatched row counts", () => {
    expect(() => ols([1, 2, 3], [[1], [2]])).toThrow(/different row counts/);
  });

  it("recovers an exact fit with no residual", () => {
    // y = 3 + 2x exactly.
    const x = [0, 1, 2, 3, 4, 5];
    const y = x.map((v) => 3 + 2 * v);
    const fit = ols(y, x.map((v) => [v]), { standardErrors: "classical" });
    expectClose(fit.coefficients[0].estimate, 3, 1e-12, "intercept");
    expectClose(fit.coefficients[1].estimate, 2, 1e-12, "slope");
    expectClose(fit.rSquared, 1, 1e-12, "R2");
  });
});
