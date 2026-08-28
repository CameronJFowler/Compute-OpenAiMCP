import { describe, expect, it } from "vitest";

import {
  MOMENTUM_SKIP_DAYS,
  TRANSFORM_KINDS,
  buildFeature,
  defaultFeatureName,
  type FeatureSpec,
} from "../src/engine/features";
import {
  makeColumn,
  sliceByDateRange,
  type Column,
  type Frame,
} from "../src/engine/frame";
import { mean, standardDeviation } from "../src/engine/stats";

const TICKERS = ["AAA", "BBB", "CCC", "DDD"];
const BASE = { AAA: 100, BBB: 50, CCC: 200, DDD: 25 };
const GROWTH = { AAA: 1.01, BBB: 1.02, CCC: 0.995, DDD: 1.003 };

function isoDate(index: number): string {
  const start = Date.UTC(2020, 0, 1);
  return new Date(start + index * 86400000).toISOString().slice(0, 10);
}

/**
 * A panel laid out date-major, so rows for different tickers are interleaved.
 * Any transform that diffs adjacent rows instead of grouping by entity will
 * produce garbage on this frame, which is the point.
 */
function makePanel(nDates = 80): Frame {
  const dates: string[] = [];
  const entities: string[] = [];
  const price: number[] = [];
  const rf: number[] = [];

  for (let t = 0; t < nDates; t++) {
    for (const ticker of TICKERS) {
      dates.push(isoDate(t));
      entities.push(ticker);
      price.push(
        BASE[ticker as keyof typeof BASE] *
          Math.pow(GROWTH[ticker as keyof typeof GROWTH], t),
      );
      rf.push(0.0001);
    }
  }

  const columns: Record<string, Column> = {
    price: makeColumn("price", price, "Adjusted close."),
    rf: makeColumn("rf", rf, "Daily risk-free rate."),
  };

  return {
    id: "test_panel",
    name: "Test panel",
    domain: "test",
    nRows: dates.length,
    dates,
    entities,
    columnOrder: ["price", "rf"],
    columns,
    source: "synthetic",
  };
}

function makeSeries(nDates = 40): Frame {
  const dates: string[] = [];
  const level: number[] = [];
  for (let t = 0; t < nDates; t++) {
    dates.push(isoDate(t));
    level.push(100 * Math.pow(1.005, t));
  }
  return {
    id: "test_series",
    name: "Test series",
    domain: "test",
    nRows: nDates,
    dates,
    entities: null,
    columnOrder: ["level"],
    columns: { level: makeColumn("level", level, "A level.") },
    source: "synthetic",
  };
}

function build(frame: Frame, spec: FeatureSpec): Column {
  const outcome = buildFeature(frame, spec);
  if (!outcome.ok) throw new Error(`${outcome.error} | ${outcome.hint}`);
  return outcome.column;
}

/** Row indices for one ticker, in date order. */
function rowsFor(frame: Frame, ticker: string): number[] {
  const rows: number[] = [];
  for (let i = 0; i < frame.nRows; i++) if (frame.entities?.[i] === ticker) rows.push(i);
  return rows;
}

describe("defaultFeatureName", () => {
  it("names every transform distinctly", () => {
    const names = TRANSFORM_KINDS.map((transform) =>
      defaultFeatureName({ transform, sourceColumn: "price" }),
    );
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("log_return", () => {
  it("computes within each entity and never across the boundary", () => {
    const frame = makePanel();
    const column = build(frame, { transform: "log_return", sourceColumn: "price" });

    for (const ticker of TICKERS) {
      const rows = rowsFor(frame, ticker);
      // The first observation of each entity has no predecessor.
      expect(Number.isNaN(column.values[rows[0]])).toBe(true);
      const expected = Math.log(GROWTH[ticker as keyof typeof GROWTH]);
      for (let k = 1; k < rows.length; k++) {
        expect(Math.abs(column.values[rows[k]] - expected)).toBeLessThan(1e-12);
      }
    }
  });

  it("marks itself as not forward looking", () => {
    const column = build(makePanel(), { transform: "log_return", sourceColumn: "price" });
    expect(column.forwardLooking).toBe(false);
    expect(column.derived).toBe(true);
  });
});

describe("momentum", () => {
  it("skips the most recent month, as 12-1 momentum requires", () => {
    const frame = makePanel();
    const window = 40;
    const column = build(frame, {
      transform: "momentum",
      sourceColumn: "price",
      window,
    });

    const rows = rowsFor(frame, "AAA");
    for (let k = 0; k < window; k++) {
      expect(Number.isNaN(column.values[rows[k]])).toBe(true);
    }
    // From t-window to t-21 is window-21 periods of compounding.
    const expected = Math.pow(GROWTH.AAA, window - MOMENTUM_SKIP_DAYS) - 1;
    for (let k = window; k < rows.length; k++) {
      expect(Math.abs(column.values[rows[k]] - expected)).toBeLessThan(1e-12);
    }
  });

  it("refuses a window inside the skip period", () => {
    const outcome = buildFeature(makePanel(), {
      transform: "momentum",
      sourceColumn: "price",
      window: 10,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.hint).toContain("252");
  });
});

describe("forward_return", () => {
  it("looks ahead and says so", () => {
    const frame = makePanel();
    const horizon = 5;
    const column = build(frame, {
      transform: "forward_return",
      sourceColumn: "price",
      horizon,
    });

    expect(column.forwardLooking).toBe(true);
    expect(column.note).toContain("FORWARD LOOKING");

    const rows = rowsFor(frame, "BBB");
    const expected = Math.pow(GROWTH.BBB, horizon) - 1;
    expect(Math.abs(column.values[rows[0]] - expected)).toBeLessThan(1e-12);
    // The last `horizon` observations have no future to look at.
    for (let k = rows.length - horizon; k < rows.length; k++) {
      expect(Number.isNaN(column.values[rows[k]])).toBe(true);
    }
  });
});

describe("lag", () => {
  it("takes the value from window rows earlier in the same entity", () => {
    const frame = makePanel();
    const column = build(frame, { transform: "lag", sourceColumn: "price", window: 3 });
    const rows = rowsFor(frame, "CCC");
    const price = frame.columns.price.values;
    for (let k = 3; k < rows.length; k++) {
      expect(column.values[rows[k]]).toBe(price[rows[k - 3]]);
    }
    expect(Number.isNaN(column.values[rows[2]])).toBe(true);
  });
});

describe("realised_vol", () => {
  it("is zero for a deterministic geometric series", () => {
    const column = build(makePanel(), {
      transform: "realised_vol",
      sourceColumn: "price",
      window: 21,
    });
    const finite = column.values.filter(Number.isFinite);
    expect(finite.length).toBeGreaterThan(0);
    for (const v of finite) expect(Math.abs(v)).toBeLessThan(1e-9);
  });

  it("annualises by sqrt(252)", () => {
    // Alternating returns give a known daily standard deviation.
    const nDates = 60;
    const dates: string[] = [];
    const price: number[] = [];
    let p = 100;
    for (let t = 0; t < nDates; t++) {
      dates.push(isoDate(t));
      price.push(p);
      p *= t % 2 === 0 ? 1.01 : 1 / 1.01;
    }
    const frame: Frame = {
      id: "alt", name: "alt", domain: "test", nRows: nDates,
      dates, entities: null, columnOrder: ["price"],
      columns: { price: makeColumn("price", price, "") }, source: "synthetic",
    };
    const column = build(frame, {
      transform: "realised_vol",
      sourceColumn: "price",
      window: 20,
    });
    const value = column.values[40];
    // Returns alternate +/- log(1.01) about a mean of zero.
    const expected = Math.log(1.01) * Math.sqrt(20 / 19) * Math.sqrt(252);
    expect(Math.abs(value - expected)).toBeLessThan(1e-6);
  });
});

describe("zscore", () => {
  it("standardises across entities within each date", () => {
    const frame = makePanel();
    const column = build(frame, { transform: "zscore", sourceColumn: "price" });

    const byDate = new Map<string, number[]>();
    for (let i = 0; i < frame.nRows; i++) {
      const v = column.values[i];
      if (!Number.isFinite(v)) continue;
      const d = frame.dates![i];
      byDate.set(d, [...(byDate.get(d) ?? []), v]);
    }
    expect(byDate.size).toBeGreaterThan(50);
    for (const values of byDate.values()) {
      expect(values.length).toBe(TICKERS.length);
      expect(Math.abs(mean(values))).toBeLessThan(1e-12);
      expect(Math.abs(standardDeviation(values) - 1)).toBeLessThan(1e-12);
    }
  });

  it("explains itself when there is no cross-section", () => {
    const outcome = buildFeature(makeSeries(), {
      transform: "zscore",
      sourceColumn: "level",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("cross-sectional");
      expect(outcome.hint).toContain("single entity");
    }
  });
});

describe("excess_return", () => {
  it("subtracts the risk-free column", () => {
    const frame = makePanel();
    const returns = build(frame, { transform: "log_return", sourceColumn: "price" });
    const withReturns: Frame = {
      ...frame,
      columnOrder: [...frame.columnOrder, returns.name],
      columns: { ...frame.columns, [returns.name]: returns },
    };
    const excess = build(withReturns, {
      transform: "excess_return",
      sourceColumn: returns.name,
    });
    for (let i = 0; i < frame.nRows; i++) {
      if (!Number.isFinite(returns.values[i])) continue;
      expect(Math.abs(excess.values[i] - (returns.values[i] - 0.0001))).toBeLessThan(1e-15);
    }
    expect(excess.note).toContain("rf");
  });

  it("names the problem when no risk-free column exists", () => {
    const outcome = buildFeature(makeSeries(), {
      transform: "excess_return",
      sourceColumn: "level",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("risk-free");
      expect(outcome.valid).toEqual(["level"]);
    }
  });
});

describe("error reporting", () => {
  it("lists the legal columns when given an unknown one", () => {
    const outcome = buildFeature(makePanel(), {
      transform: "log_return",
      sourceColumn: "clsoe",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("clsoe");
      expect(outcome.hint).toContain("describe_dataset");
      expect(outcome.valid).toEqual(["price", "rf"]);
    }
  });

  it("never throws, whatever it is handed", () => {
    for (const transform of TRANSFORM_KINDS) {
      expect(() =>
        buildFeature(makePanel(20), { transform, sourceColumn: "nope", window: -5 }),
      ).not.toThrow();
    }
  });
});

/**
 * The property that matters more than any individual formula.
 *
 * Recompute each causal transform on a frame truncated to an earlier end date.
 * Every value that survives the truncation must be bit-identical, because a
 * causal transform at date t cannot depend on anything after t. forward_return
 * must fail this test, and is checked separately to prove the test can fail.
 */
describe("causality", () => {
  const frame = makePanel(80);
  const cutoff = isoDate(59);
  const truncated = sliceByDateRange(frame, undefined, cutoff);

  const causalSpecs: FeatureSpec[] = [
    { transform: "log_return", sourceColumn: "price" },
    { transform: "momentum", sourceColumn: "price", window: 40 },
    { transform: "realised_vol", sourceColumn: "price", window: 21 },
    { transform: "lag", sourceColumn: "price", window: 5 },
    { transform: "zscore", sourceColumn: "price" },
  ];

  for (const spec of causalSpecs) {
    it(`${spec.transform} does not change when future data is removed`, () => {
      const full = build(frame, spec);
      const partial = build(truncated, spec);

      let compared = 0;
      for (let i = 0, j = 0; i < frame.nRows; i++) {
        if (frame.dates![i] > cutoff) continue;
        expect(truncated.dates![j]).toBe(frame.dates![i]);
        expect(truncated.entities![j]).toBe(frame.entities![i]);
        const a = full.values[i];
        const b = partial.values[j];
        if (Number.isNaN(a)) expect(Number.isNaN(b)).toBe(true);
        else expect(b).toBe(a);
        compared++;
        j++;
      }
      expect(compared).toBe(60 * TICKERS.length);
    });
  }

  it("forward_return fails the same test, which is how we know the test works", () => {
    const spec: FeatureSpec = {
      transform: "forward_return",
      sourceColumn: "price",
      horizon: 5,
    };
    const full = build(frame, spec);
    const partial = build(truncated, spec);

    let differences = 0;
    for (let i = 0, j = 0; i < frame.nRows; i++) {
      if (frame.dates![i] > cutoff) continue;
      const a = full.values[i];
      const b = partial.values[j];
      if (Number.isNaN(a) !== Number.isNaN(b) || (!Number.isNaN(a) && a !== b)) {
        differences++;
      }
      j++;
    }
    // The last five dates of the truncated frame lost the future they needed.
    expect(differences).toBe(5 * TICKERS.length);
  });
});
