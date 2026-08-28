import { describe, expect, it } from "vitest";

import fixtures from "./fixtures/fixtures.json";
import {
  chi2Cdf,
  erf,
  fCdf,
  logGamma,
  normalCdf,
  normalInv,
  regularizedGammaP,
  regularizedIncompleteBeta,
  studentTCdf,
  studentTTwoSidedP,
} from "../src/engine/dist";

/**
 * Every expected value in this file came from scipy.stats via
 * scripts/make_fixtures.py. Nothing here is a value the implementation
 * produced and was then blessed.
 */
function expectClose(actual: number, expected: number, rtol = 1e-11, atol = 1e-13): void {
  const tolerance = atol + rtol * Math.abs(expected);
  const difference = Math.abs(actual - expected);
  if (difference > tolerance) {
    throw new Error(
      `expected ${actual} to be within ${tolerance} of ${expected} (off by ${difference})`,
    );
  }
  expect(difference).toBeLessThanOrEqual(tolerance);
}

const d = fixtures.distributions;

describe("logGamma", () => {
  it("matches known exact values", () => {
    // Gamma(n) = (n-1)! so log Gamma of a small integer is exact.
    expectClose(logGamma(1), 0, 1e-12, 1e-12);
    expectClose(logGamma(2), 0, 1e-12, 1e-12);
    expectClose(logGamma(5), Math.log(24), 1e-12);
    expectClose(logGamma(11), Math.log(3628800), 1e-12);
    // Gamma(1/2) = sqrt(pi)
    expectClose(logGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-12);
  });
});

describe("regularizedIncompleteBeta", () => {
  it("matches scipy beta.cdf", () => {
    for (const c of d.regularized_incomplete_beta) {
      expectClose(regularizedIncompleteBeta(c.x, c.a, c.b), c.expected);
    }
  });

  it("respects the boundary values and the symmetry relation", () => {
    expect(regularizedIncompleteBeta(0, 2, 3)).toBe(0);
    expect(regularizedIncompleteBeta(1, 2, 3)).toBe(1);
    for (const [x, a, b] of [
      [0.3, 2, 5],
      [0.7, 4, 1.5],
      [0.5, 0.5, 0.5],
    ] as [number, number, number][]) {
      expectClose(
        regularizedIncompleteBeta(x, a, b) + regularizedIncompleteBeta(1 - x, b, a),
        1,
        1e-12,
      );
    }
  });
});

describe("regularizedGammaP", () => {
  it("matches scipy gamma.cdf", () => {
    for (const c of d.regularized_gamma_p) {
      expectClose(regularizedGammaP(c.s, c.x), c.expected);
    }
  });
});

describe("erf and the normal distribution", () => {
  it("matches scipy norm.cdf", () => {
    for (const c of d.normal_cdf) {
      expectClose(normalCdf(c.x), c.expected);
    }
  });

  it("reproduces the textbook 1.96 value", () => {
    expectClose(normalCdf(1.96), 0.9750021048517795, 1e-12);
  });

  it("is antisymmetric", () => {
    for (const x of [0.1, 0.9, 2.3, 4.5]) {
      expectClose(erf(-x), -erf(x), 1e-14, 1e-16);
    }
  });

  it("inverts itself", () => {
    for (const c of d.normal_inv) {
      expectClose(normalInv(c.p), c.expected, 1e-9, 1e-11);
    }
    for (const x of [-2.5, -0.3, 0.0, 1.1, 3.2]) {
      expectClose(normalInv(normalCdf(x)), x, 1e-8, 1e-9);
    }
  });
});

describe("studentTCdf", () => {
  it("matches scipy t.cdf", () => {
    for (const c of d.student_t_cdf) {
      expectClose(studentTCdf(c.t, c.df), c.expected);
    }
  });

  it("reproduces the documented t.cdf(2.0, 10) value", () => {
    // scipy.stats.t.cdf(2.0, 10) to full double precision.
    expectClose(studentTCdf(2.0, 10), 0.9633059826146297, 1e-12);
  });

  it("is 0.5 at zero for every df", () => {
    for (const df of [1, 2, 7, 30, 500]) {
      expectClose(studentTCdf(0, df), 0.5, 1e-14);
    }
  });

  it("approaches the normal as df grows", () => {
    expectClose(studentTCdf(1.5, 5_000_000), normalCdf(1.5), 1e-6);
  });
});

describe("studentTTwoSidedP", () => {
  it("matches 2 * scipy t.sf(|t|)", () => {
    for (const c of d.student_t_two_sided_p) {
      expectClose(studentTTwoSidedP(c.t, c.df), c.expected);
    }
  });

  it("is symmetric in the sign of t", () => {
    expectClose(studentTTwoSidedP(2.3, 17), studentTTwoSidedP(-2.3, 17), 1e-14);
  });

  it("equals 1 at t = 0", () => {
    expectClose(studentTTwoSidedP(0, 12), 1, 1e-14);
  });
});

describe("fCdf", () => {
  it("matches scipy f.cdf", () => {
    for (const c of d.f_cdf) {
      expectClose(fCdf(c.f, c.d1, c.d2), c.expected);
    }
  });

  it("relates to the t distribution: F(1, m) is t(m) squared", () => {
    const t = 2.4;
    const df = 15;
    expectClose(fCdf(t * t, 1, df), 1 - studentTTwoSidedP(t, df), 1e-11);
  });
});

describe("chi2Cdf", () => {
  it("matches scipy chi2.cdf", () => {
    for (const c of d.chi2_cdf) {
      expectClose(chi2Cdf(c.x, c.k), c.expected);
    }
  });

  it("puts the 5% critical value of one df at 3.841", () => {
    expectClose(chi2Cdf(3.841458820694124, 1), 0.95, 1e-10);
  });
});
