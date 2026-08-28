import { describe, expect, it } from "vitest";

import { runBacktest, type BacktestResult } from "../src/engine/backtest";
import { makeColumn, type Column, type Frame } from "../src/engine/frame";
import { makeRng } from "../src/engine/bootstrap";

const ENTITIES = Array.from({ length: 20 }, (_, i) => `E${String(i).padStart(2, "0")}`);

function isoDate(index: number): string {
  return new Date(Date.UTC(2015, 0, 1) + index * 86400000).toISOString().slice(0, 10);
}

interface PanelSpec {
  nDates: number;
  /** Daily return for one entity on one date. */
  returnAt: (entityIndex: number, dateIndex: number, rng: () => number) => number;
  /**
   * Signal observed at the close of `dateIndex`. It is handed the full return
   * series so a test can deliberately build a cheating signal.
   */
  signalAt: (
    entityIndex: number,
    dateIndex: number,
    returns: number[][],
  ) => number;
  seed?: number;
}

function makePanel(spec: PanelSpec): Frame {
  const rng = makeRng(spec.seed ?? 1);
  const { nDates } = spec;

  // returns[entity][date]
  const returns: number[][] = ENTITIES.map((_, e) =>
    Array.from({ length: nDates }, (__, d) => spec.returnAt(e, d, rng)),
  );

  const dates: string[] = [];
  const entities: string[] = [];
  const ret: number[] = [];
  const signal: number[] = [];

  for (let d = 0; d < nDates; d++) {
    for (let e = 0; e < ENTITIES.length; e++) {
      dates.push(isoDate(d));
      entities.push(ENTITIES[e]);
      ret.push(returns[e][d]);
      signal.push(spec.signalAt(e, d, returns));
    }
  }

  const columns: Record<string, Column> = {
    ret: makeColumn("ret", ret, "Daily return."),
    signal: { ...makeColumn("signal", signal, "Test signal."), derived: true },
  };

  return {
    id: "test", name: "test", domain: "test",
    nRows: dates.length, dates, entities,
    columnOrder: ["ret", "signal"], columns, source: "synthetic",
  };
}

function run(frame: Frame, overrides: Partial<Parameters<typeof runBacktest>[1]> = {}): BacktestResult {
  const outcome = runBacktest(frame, {
    signalColumn: "signal",
    holdingDays: 5,
    nQuantiles: 5,
    costBps: 0,
    ...overrides,
  });
  if (!outcome.ok) throw new Error(`${outcome.error} | ${outcome.hint}`);
  return outcome.result;
}

describe("look-ahead alignment", () => {
  /**
   * The pair of tests that pin the off-by-one exactly.
   *
   * A signal equal to TOMORROW's return is perfect foresight, and must produce
   * an absurd Sharpe ratio. A signal equal to TODAY's return is knowable at
   * formation time but has no predictive content, and must produce roughly
   * nothing. If the backtester were off by one day in either direction, the two
   * results would swap.
   */
  it("turns a perfect-foresight signal into an absurd Sharpe ratio", () => {
    const frame = makePanel({
      nDates: 600,
      returnAt: (_e, _d, rng) => (rng() - 0.5) * 0.04,
      // Signal at date d is the return of date d+1: cheating, on purpose.
      signalAt: (e, d, returns) => (d + 1 < returns[e].length ? returns[e][d + 1] : NaN),
    });
    const result = run(frame, { holdingDays: 1 });
    expect(result.full.sharpe).toBeGreaterThan(8);
  });

  it("gets nothing from a contemporaneous signal, which is the honest case", () => {
    const frame = makePanel({
      nDates: 600,
      returnAt: (_e, _d, rng) => (rng() - 0.5) * 0.04,
      // Knowable at the close of date d, and uninformative about date d+1.
      signalAt: (e, d, returns) => returns[e][d],
    });
    const result = run(frame, { holdingDays: 1 });
    expect(Math.abs(result.full.sharpe)).toBeLessThan(2);
  });

  it("gets nothing from a pure-noise signal", () => {
    const noise = makeRng(99);
    const frame = makePanel({
      nDates: 800,
      returnAt: (_e, _d, rng) => (rng() - 0.5) * 0.03,
      signalAt: () => noise(),
    });
    const result = run(frame);
    expect(Math.abs(result.full.sharpe)).toBeLessThan(2);
  });
});

describe("portfolio construction", () => {
  /**
   * If every entity earns the same return on a day, a dollar-neutral portfolio
   * must earn exactly zero on that day. This is the neutrality check: it fails
   * immediately if the long and short legs are not equally sized.
   */
  it("is dollar neutral", () => {
    const frame = makePanel({
      nDates: 300,
      // Identical across entities, varying across days.
      returnAt: (_e, d) => Math.sin(d / 7) * 0.01,
      // Distinct per entity so the sort is well defined and stable.
      signalAt: (e) => e,
    });
    const result = run(frame);
    for (const r of result.dailyReturns) {
      expect(Math.abs(r)).toBeLessThan(1e-12);
    }
  });

  it("charges costs on turnover and only on turnover", () => {
    const noise = makeRng(5);
    const spec: PanelSpec = {
      nDates: 400,
      returnAt: (_e, _d, rng) => (rng() - 0.5) * 0.02,
      signalAt: () => noise(),
    };
    const free = run(makePanel(spec), { costBps: 0 });
    const expensive = run(makePanel(spec), { costBps: 50 });

    expect(expensive.full.cagr).toBeLessThan(free.full.cagr);
    expect(expensive.full.totalCostDrag).toBeGreaterThan(0);
    expect(free.full.totalCostDrag).toBe(0);

    // A signal that never changes rank has turnover only on the first trade.
    const stable = run(
      makePanel({
        nDates: 400,
        returnAt: (_e, _d, rng) => (rng() - 0.5) * 0.02,
        signalAt: (e) => e,
      }),
      { costBps: 50 },
    );
    expect(stable.full.averageTurnover).toBeLessThan(0.02);
  });

  it("uses equal-sized long and short legs", () => {
    const frame = makePanel({
      nDates: 200,
      returnAt: (_e, _d, rng) => (rng() - 0.5) * 0.02,
      signalAt: (e) => e,
    });
    const result = run(frame, { nQuantiles: 5 });
    expect(result.averageLongCount).toBe(4);
    expect(result.averageShortCount).toBe(4);
  });
});

describe("sample splitting", () => {
  it("splits 70/30 chronologically and reports both halves", () => {
    const noise = makeRng(11);
    const frame = makePanel({
      nDates: 1000,
      returnAt: (_e, _d, rng) => (rng() - 0.5) * 0.02,
      signalAt: () => noise(),
    });
    const result = run(frame);

    expect(result.inSample.nDays + result.outOfSample.nDays).toBe(result.full.nDays);
    const ratio = result.inSample.nDays / result.full.nDays;
    expect(ratio).toBeGreaterThan(0.69);
    expect(ratio).toBeLessThan(0.71);

    // Chronological, not random.
    expect(result.inSample.endDate! <= result.outOfSample.startDate!).toBe(true);
    expect(result.splitDate).toBe(result.outOfSample.startDate);
  });
});

describe("refusals", () => {
  it("refuses a forward-looking signal and says why", () => {
    const frame = makePanel({
      nDates: 200,
      returnAt: (_e, _d, rng) => rng() * 0.01,
      signalAt: (e) => e,
    });
    frame.columns.signal = { ...frame.columns.signal, forwardLooking: true };

    const outcome = runBacktest(frame, {
      signalColumn: "signal", holdingDays: 5, nQuantiles: 5, costBps: 5,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("forward-looking");
      expect(outcome.hint).toContain("momentum");
    }
  });

  it("refuses a dataset with no cross-section", () => {
    const frame = makePanel({
      nDates: 100, returnAt: () => 0.001, signalAt: (e) => e,
    });
    const outcome = runBacktest(
      { ...frame, entities: null },
      { signalColumn: "signal", holdingDays: 5, nQuantiles: 5, costBps: 5 },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.hint).toContain("industries_daily");
  });

  it("lists the legal columns for an unknown signal", () => {
    const frame = makePanel({ nDates: 100, returnAt: () => 0.001, signalAt: (e) => e });
    const outcome = runBacktest(frame, {
      signalColumn: "mmentum", holdingDays: 5, nQuantiles: 5, costBps: 5,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.valid).toEqual(["ret", "signal"]);
  });

  it("refuses a sample window too short for the holding period", () => {
    const frame = makePanel({ nDates: 30, returnAt: () => 0.001, signalAt: (e) => e });
    const outcome = runBacktest(frame, {
      signalColumn: "signal", holdingDays: 21, nQuantiles: 5, costBps: 5,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.hint).toContain("sample window");
  });
});
