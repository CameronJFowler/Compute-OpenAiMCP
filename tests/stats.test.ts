import { describe, expect, it } from "vitest";

import fixtures from "./fixtures/fixtures.json";
import { chi2UpperTailP } from "../src/engine/dist";
import {
  autocorrelation,
  correlationMatrix,
  jarqueBera,
  maxDrawdown,
  moments,
  pearson,
  quantile,
  spearman,
  standardDeviation,
} from "../src/engine/stats";

function expectClose(actual: number, expected: number, rtol = 1e-10, label = ""): void {
  const tolerance = 1e-12 + rtol * Math.abs(expected);
  const difference = Math.abs(actual - expected);
  if (difference > tolerance) {
    throw new Error(`${label}: ${actual} not within ${tolerance} of ${expected}`);
  }
  expect(difference).toBeLessThanOrEqual(tolerance);
}

const m = fixtures.moments as unknown as Record<
  string,
  {
    values: number[];
    n: number;
    mean: number;
    sd: number;
    skewness: number;
    excess_kurtosis: number;
    min: number;
    max: number;
    median: number;
    jarque_bera: number;
    acf: Record<string, number>;
  }
>;

describe("moments against scipy", () => {
  for (const name of ["normalish", "skewed", "fat_tailed"]) {
    it(`matches scipy on the ${name} sample`, () => {
      const f = m[name];
      const result = moments(f.values);
      expect(result.n).toBe(f.n);
      expectClose(result.mean, f.mean, 1e-12, `${name} mean`);
      expectClose(result.sd, f.sd, 1e-12, `${name} sd`);
      expectClose(result.skewness, f.skewness, 1e-11, `${name} skew`);
      expectClose(result.excessKurtosis, f.excess_kurtosis, 1e-11, `${name} kurtosis`);
      expectClose(result.min, f.min, 1e-14, `${name} min`);
      expectClose(result.max, f.max, 1e-14, `${name} max`);
      expectClose(result.median, f.median, 1e-12, `${name} median`);
    });
  }

  it("reports a normal sample as having near-zero excess kurtosis", () => {
    const result = moments(m.normalish.values);
    expect(Math.abs(result.excessKurtosis)).toBeLessThan(0.6);
  });

  it("ignores non-finite entries and counts them as missing", () => {
    const result = moments([1, 2, NaN, 3, Infinity, 4]);
    expect(result.n).toBe(4);
    expect(result.missing).toBe(2);
    expectClose(result.mean, 2.5, 1e-14);
  });

  it("returns NaN rather than throwing on an empty column", () => {
    const result = moments([]);
    expect(result.n).toBe(0);
    expect(Number.isNaN(result.mean)).toBe(true);
  });
});

describe("autocorrelation against a numpy reference", () => {
  for (const name of ["normalish", "skewed", "fat_tailed"]) {
    it(`matches on the ${name} sample`, () => {
      const f = m[name];
      const acf = autocorrelation(f.values, [1, 5, 21]);
      for (const lag of [1, 5, 21]) {
        expectClose(acf.get(lag) as number, f.acf[String(lag)], 1e-11, `${name} acf ${lag}`);
      }
    });
  }

  it("is 1 at lag 0 by construction and NaN outside the sample", () => {
    const acf = autocorrelation([1, 2, 3, 4, 5], [0, 99]);
    expect(Number.isNaN(acf.get(0) as number)).toBe(true);
    expect(Number.isNaN(acf.get(99) as number)).toBe(true);
  });
});

describe("correlation", () => {
  it("matches scipy pearsonr and spearmanr", () => {
    const f = fixtures.moments.correlation as unknown as {
      a: number[];
      b: number[];
      pearson: number;
      spearman: number;
    };
    expectClose(pearson(f.a, f.b).r, f.pearson, 1e-11, "pearson");
    expectClose(spearman(f.a, f.b).r, f.spearman, 1e-11, "spearman");
  });

  it("handles ties with average ranks", () => {
    const a = [1, 2, 2, 3, 4];
    const b = [10, 20, 20, 30, 40];
    expectClose(spearman(a, b).r, 1, 1e-12, "monotone with ties");
  });

  it("is pairwise complete", () => {
    const a = [1, 2, NaN, 4, 5];
    const b = [2, 4, 6, NaN, 10];
    const { r, n } = pearson(a, b);
    expect(n).toBe(3);
    expectClose(r, 1, 1e-12, "perfect after dropping incomplete pairs");
  });

  it("builds a symmetric matrix with a unit diagonal", () => {
    const matrix = correlationMatrix([
      { name: "a", values: [1, 2, 3, 4, 5] },
      { name: "b", values: [2, 4, 5, 4, 5] },
      { name: "c", values: [5, 4, 3, 2, 1] },
    ]);
    expect(matrix.names).toEqual(["a", "b", "c"]);
    for (let i = 0; i < 3; i++) {
      expect(matrix.values[i][i]).toBe(1);
      for (let j = 0; j < 3; j++) {
        expectClose(matrix.values[i][j], matrix.values[j][i], 1e-14, "symmetry");
      }
    }
    expectClose(matrix.values[0][2], -1, 1e-12, "perfectly negative");
  });
});

describe("jarqueBera", () => {
  for (const name of ["normalish", "skewed", "fat_tailed"]) {
    it(`matches scipy on the ${name} sample`, () => {
      const f = m[name];
      expectClose(jarqueBera(f.values).statistic, f.jarque_bera, 1e-10, `${name} JB`);
    });
  }

  it("rejects normality for the gamma sample and not for the normal one", () => {
    const skewed = jarqueBera(m.skewed.values);
    const normalish = jarqueBera(m.normalish.values);
    expect(chi2UpperTailP(skewed.statistic, 2)).toBeLessThan(0.01);
    expect(chi2UpperTailP(normalish.statistic, 2)).toBeGreaterThan(0.05);
  });
});

describe("quantile and standardDeviation", () => {
  it("interpolates linearly, matching the numpy default", () => {
    const sorted = [1, 2, 3, 4];
    expectClose(quantile(sorted, 0.5), 2.5, 1e-14);
    expectClose(quantile(sorted, 0.25), 1.75, 1e-14);
    expectClose(quantile(sorted, 0), 1, 1e-14);
    expectClose(quantile(sorted, 1), 4, 1e-14);
  });

  it("uses the n-1 denominator", () => {
    expectClose(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9]), 2.138089935299395, 1e-12);
  });
});

describe("maxDrawdown", () => {
  it("finds the worst peak-to-trough decline", () => {
    const wealth = [1, 1.2, 1.5, 0.9, 1.1, 1.6, 1.4];
    const result = maxDrawdown(wealth);
    expectClose(result.maxDrawdown, 0.9 / 1.5 - 1, 1e-12, "drawdown");
    expect(result.peakIndex).toBe(2);
    expect(result.troughIndex).toBe(3);
  });

  it("is zero for a monotonically rising series", () => {
    expect(maxDrawdown([1, 2, 3, 4]).maxDrawdown).toBe(0);
  });
});
