import { describe, expect, it } from "vitest";

import {
  bootstrapStrategy,
  makeRng,
  resample,
  sharpeOf,
  terminalWealthOf,
} from "../src/engine/bootstrap";

function seededReturns(n: number, drift: number, scale: number, seed = 3): number[] {
  const rng = makeRng(seed);
  return Array.from({ length: n }, () => drift + (rng() - 0.5) * scale);
}

describe("makeRng", () => {
  it("is deterministic and stays inside the unit interval", () => {
    const a = Array.from({ length: 500 }, makeRng(42));
    const b = Array.from({ length: 500 }, makeRng(42));
    expect(a).toEqual(b);
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("gives different streams for different seeds", () => {
    expect(Array.from({ length: 20 }, makeRng(1))).not.toEqual(
      Array.from({ length: 20 }, makeRng(2)),
    );
  });
});

describe("resample", () => {
  it("returns a series of the same length", () => {
    const series = seededReturns(300, 0, 0.02);
    expect(resample(series, 21, makeRng(1))).toHaveLength(300);
  });

  it("draws only values that were in the original series", () => {
    const series = [1, 2, 3, 4, 5];
    const drawn = resample(series, 2, makeRng(9));
    for (const v of drawn) expect(series).toContain(v);
  });

  /**
   * A block length of 1 makes every step a fresh draw, so the result is an iid
   * bootstrap. Long blocks keep runs of consecutive observations together,
   * which is the whole reason to use this method on a return series.
   */
  it("preserves consecutive runs when the block is long", () => {
    const series = Array.from({ length: 200 }, (_, i) => i);
    const longBlocks = resample(series, 50, makeRng(4));

    let consecutive = 0;
    for (let i = 1; i < longBlocks.length; i++) {
      if (longBlocks[i] === (longBlocks[i - 1] + 1) % series.length) consecutive++;
    }
    expect(consecutive / longBlocks.length).toBeGreaterThan(0.9);

    const iid = resample(series, 1, makeRng(4));
    let iidConsecutive = 0;
    for (let i = 1; i < iid.length; i++) {
      if (iid[i] === (iid[i - 1] + 1) % series.length) iidConsecutive++;
    }
    expect(iidConsecutive / iid.length).toBeLessThan(0.2);
  });
});

describe("sharpeOf and terminalWealthOf", () => {
  it("annualises by sqrt(252)", () => {
    const constant = new Array(100).fill(0.001);
    // Zero variance has no defined Sharpe ratio.
    expect(Number.isNaN(sharpeOf(constant))).toBe(true);

    const series = [0.01, -0.01, 0.02, -0.005, 0.015];
    const expected =
      (series.reduce((a, b) => a + b, 0) / series.length) /
      Math.sqrt(
        series.reduce((acc, v) => {
          const m = series.reduce((a, b) => a + b, 0) / series.length;
          return acc + (v - m) ** 2;
        }, 0) /
          (series.length - 1),
      ) *
      Math.sqrt(252);
    expect(Math.abs(sharpeOf(series) - expected)).toBeLessThan(1e-12);
  });

  it("compounds terminal wealth", () => {
    expect(Math.abs(terminalWealthOf([0.1, 0.1]) - 1.21)).toBeLessThan(1e-12);
    expect(Math.abs(terminalWealthOf([0.5, -0.5]) - 0.75)).toBeLessThan(1e-12);
  });
});

describe("bootstrapStrategy", () => {
  it("is reproducible for a given seed", () => {
    const series = seededReturns(500, 0.0004, 0.02);
    const a = bootstrapStrategy(series, { nSimulations: 200, blockLengthDays: 21, seed: 7 });
    const b = bootstrapStrategy(series, { nSimulations: 200, blockLengthDays: 21, seed: 7 });
    expect(a.sharpePercentiles).toEqual(b.sharpePercentiles);
    expect(a.fractionNonPositiveSharpe).toBe(b.fractionNonPositiveSharpe);
  });

  it("brackets the observed Sharpe ratio", () => {
    const series = seededReturns(750, 0.0005, 0.02);
    const result = bootstrapStrategy(series, { nSimulations: 400, blockLengthDays: 21 });
    expect(result.sharpePercentiles.p5).toBeLessThan(result.observedSharpe);
    expect(result.sharpePercentiles.p95).toBeGreaterThan(result.observedSharpe);
  });

  it("orders its percentiles", () => {
    const result = bootstrapStrategy(seededReturns(400, 0.0002, 0.03), {
      nSimulations: 300,
      blockLengthDays: 10,
    });
    const p = result.sharpePercentiles;
    expect(p.p5).toBeLessThanOrEqual(p.p25);
    expect(p.p25).toBeLessThanOrEqual(p.p50);
    expect(p.p50).toBeLessThanOrEqual(p.p75);
    expect(p.p75).toBeLessThanOrEqual(p.p95);

    const w = result.terminalWealthPercentiles;
    expect(w.p5).toBeLessThanOrEqual(w.p50);
    expect(w.p50).toBeLessThanOrEqual(w.p95);
  });

  /**
   * The number the tool actually reports. A strategy with no edge should have
   * roughly half its resampled paths come back with a non-positive Sharpe
   * ratio, and a strategy with a real edge should have very few.
   */
  it("reports how often a resampled path fails", () => {
    const noEdge = bootstrapStrategy(seededReturns(1000, 0, 0.02, 12), {
      nSimulations: 500,
      blockLengthDays: 21,
    });
    expect(noEdge.fractionNonPositiveSharpe).toBeGreaterThan(0.25);
    expect(noEdge.fractionNonPositiveSharpe).toBeLessThan(0.75);

    const strongEdge = bootstrapStrategy(seededReturns(1000, 0.004, 0.01, 12), {
      nSimulations: 500,
      blockLengthDays: 21,
    });
    expect(strongEdge.fractionNonPositiveSharpe).toBeLessThan(0.05);
  });

  it("reports progress and finishes at 1", () => {
    const seen: number[] = [];
    bootstrapStrategy(seededReturns(200, 0.0003, 0.02), {
      nSimulations: 100,
      blockLengthDays: 5,
    }, (fraction) => seen.push(fraction));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen[0]).toBe(0);
  });

  it("builds a histogram covering every simulation", () => {
    const result = bootstrapStrategy(seededReturns(300, 0.0003, 0.02), {
      nSimulations: 250,
      blockLengthDays: 21,
    });
    const total = result.histogram.reduce((acc, bin) => acc + bin.count, 0);
    expect(total).toBe(result.sharpeSamples.filter(Number.isFinite).length);
  });
});
