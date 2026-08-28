/**
 * Cross-sectional long-short backtest.
 *
 * This is the correctness bar for the whole project, and the whole of it comes
 * down to one line: a position formed on date t earns the return of date t+1.
 * Off-by-one here is look-ahead bias, it inflates every metric, it is invisible
 * in the output, and it is the first thing anyone who does this for a living
 * will check. The alignment is asserted in tests/backtest.test.ts against a
 * signal that is pure noise (Sharpe near zero) and against a signal built from
 * tomorrow's return (Sharpe absurdly high), because a backtester that cannot
 * detect a deliberately cheating signal cannot be trusted on an honest one.
 */

import { IN_SAMPLE_FRACTION, TRADING_DAYS_PER_YEAR } from "../config";
import { dateGroups, getColumn, uniqueSortedDates, type Frame } from "./frame";
import { annualisedSharpe, maxDrawdown, mean, standardDeviation } from "./stats";

export interface BacktestParams {
  signalColumn: string;
  returnColumn?: string;
  holdingDays: number;
  nQuantiles: number;
  costBps: number;
}

export interface PeriodMetrics {
  label: string;
  startDate: string | null;
  endDate: string | null;
  nDays: number;
  cagr: number;
  annualisedVolatility: number;
  sharpe: number;
  maxDrawdown: number;
  hitRate: number;
  nRebalances: number;
  averageTurnover: number;
  totalCostDrag: number;
}

export interface BacktestResult {
  params: BacktestParams;
  /** Daily portfolio returns, net of costs, aligned with `dates`. */
  dailyReturns: number[];
  dates: string[];
  equityCurve: number[];
  drawdown: number[];
  /** Chronological 70/30 boundary. */
  splitDate: string | null;
  full: PeriodMetrics;
  inSample: PeriodMetrics;
  outOfSample: PeriodMetrics;
  averageLongCount: number;
  averageShortCount: number;
  warnings: string[];
}

export type BacktestOutcome =
  | { ok: true; result: BacktestResult }
  | { ok: false; error: string; hint: string; valid?: unknown };

interface Weights {
  byEntity: Map<string, number>;
  longCount: number;
  shortCount: number;
}

/**
 * Form dollar-neutral weights from one cross-section of the signal.
 *
 * Equal weight inside each quantile, long the top, short the bottom, half a
 * unit of capital on each side so gross exposure is 1 and net exposure is 0.
 */
function formWeights(
  values: { entity: string; signal: number }[],
  nQuantiles: number,
): Weights | null {
  const usable = values.filter((v) => Number.isFinite(v.signal));
  if (usable.length < nQuantiles * 2) return null;

  const sorted = [...usable].sort((a, b) => a.signal - b.signal);
  const bucketSize = sorted.length / nQuantiles;

  const shorts = sorted.slice(0, Math.floor(bucketSize));
  const longs = sorted.slice(sorted.length - Math.floor(bucketSize));
  if (longs.length === 0 || shorts.length === 0) return null;

  const byEntity = new Map<string, number>();
  for (const item of longs) byEntity.set(item.entity, 0.5 / longs.length);
  for (const item of shorts) {
    // An entity cannot be in both buckets unless the quantiles overlap, which
    // only happens when there are fewer entities than quantiles - already
    // excluded above.
    byEntity.set(item.entity, -0.5 / shorts.length);
  }
  return { byEntity, longCount: longs.length, shortCount: shorts.length };
}

function turnoverBetween(previous: Map<string, number>, next: Map<string, number>): number {
  const names = new Set([...previous.keys(), ...next.keys()]);
  let total = 0;
  for (const name of names) {
    total += Math.abs((next.get(name) ?? 0) - (previous.get(name) ?? 0));
  }
  return total / 2;
}

function metricsFor(
  label: string,
  returns: number[],
  dates: string[],
  rebalanceCount: number,
  turnovers: number[],
  costs: number[],
): PeriodMetrics {
  const n = returns.length;
  if (n === 0) {
    return {
      label, startDate: null, endDate: null, nDays: 0, cagr: NaN,
      annualisedVolatility: NaN, sharpe: NaN, maxDrawdown: NaN, hitRate: NaN,
      nRebalances: rebalanceCount, averageTurnover: NaN, totalCostDrag: 0,
    };
  }

  let wealth = 1;
  const curve: number[] = [];
  for (const r of returns) {
    wealth *= 1 + r;
    curve.push(wealth);
  }

  const dailySd = standardDeviation(returns);
  const years = n / TRADING_DAYS_PER_YEAR;

  return {
    label,
    startDate: dates[0],
    endDate: dates[n - 1],
    nDays: n,
    cagr: wealth > 0 ? Math.pow(wealth, 1 / years) - 1 : -1,
    annualisedVolatility: dailySd * Math.sqrt(TRADING_DAYS_PER_YEAR),
    /**
     * No risk-free subtraction. The portfolio is dollar neutral and therefore
     * self-financing, so its return is already an excess return; subtracting
     * the risk-free rate again would understate the Sharpe ratio.
     */
    sharpe: annualisedSharpe(returns),
    maxDrawdown: maxDrawdown(curve).maxDrawdown,
    hitRate: returns.filter((r) => r > 0).length / n,
    nRebalances: rebalanceCount,
    averageTurnover: turnovers.length > 0 ? mean(turnovers) : 0,
    totalCostDrag: costs.reduce((a, b) => a + b, 0),
  };
}

export function runBacktest(frame: Frame, params: BacktestParams): BacktestOutcome {
  const { signalColumn, holdingDays, nQuantiles, costBps } = params;
  const returnColumn = params.returnColumn ?? "ret";

  if (!frame.dates || !frame.entities) {
    return {
      ok: false,
      error: "this dataset is not a panel, so there is no cross-section to sort",
      hint: "run_backtest needs a dataset with both dates and multiple entities. Load industries_daily.",
    };
  }

  const signal = getColumn(frame, signalColumn);
  if (!signal) {
    return {
      ok: false,
      error: `signal column "${signalColumn}" does not exist`,
      hint: "Create one with add_feature first, then retry. get_state lists the current columns.",
      valid: frame.columnOrder,
    };
  }
  if (signal.forwardLooking) {
    return {
      ok: false,
      error: `"${signalColumn}" is a forward-looking column and cannot be a trading signal`,
      hint: "A signal has to be knowable at the moment the position is formed. forward_return is legal only as a regression dependent variable. Use momentum, realised_vol or a z-score of one of them.",
      valid: frame.columnOrder.filter((n) => !frame.columns[n].forwardLooking),
    };
  }

  const returns = getColumn(frame, returnColumn);
  if (!returns) {
    return {
      ok: false,
      error: `return column "${returnColumn}" does not exist`,
      hint: "The backtester needs a per-entity daily return column. On industries_daily this is `ret`.",
      valid: frame.columnOrder,
    };
  }

  if (!Number.isInteger(holdingDays) || holdingDays < 1) {
    return {
      ok: false,
      error: `holding_days must be a positive integer, got ${holdingDays}`,
      hint: "Try 21 for monthly rebalancing.",
    };
  }
  if (!Number.isInteger(nQuantiles) || nQuantiles < 2) {
    return {
      ok: false,
      error: `n_quantiles must be an integer of at least 2, got ${nQuantiles}`,
      hint: "Try 5 for quintile sorts.",
    };
  }

  const dates = uniqueSortedDates(frame);
  if (dates.length < holdingDays * 4) {
    return {
      ok: false,
      error: `only ${dates.length} dates in the current sample window, too few for ${holdingDays}-day rebalancing`,
      hint: "Widen the sample window in the brief panel, or reduce holding_days.",
    };
  }

  const rowsByDate = dateGroups(frame);
  const dateIndex = new Map(dates.map((d, i) => [d, i]));

  // Signal cross-section per date, built once.
  const crossSections = new Map<string, { entity: string; signal: number }[]>();
  for (const [date, rows] of rowsByDate) {
    crossSections.set(
      date,
      rows.map((i) => ({ entity: frame.entities![i], signal: signal.values[i] })),
    );
  }

  // Return lookup: date -> entity -> return.
  const returnsByDate = new Map<string, Map<string, number>>();
  for (const [date, rows] of rowsByDate) {
    const map = new Map<string, number>();
    for (const i of rows) map.set(frame.entities![i], returns.values[i]);
    returnsByDate.set(date, map);
  }

  const warnings: string[] = [];
  const dailyReturns: number[] = [];
  const heldDates: string[] = [];
  const turnovers: number[] = [];
  const costs: number[] = [];
  const longCounts: number[] = [];
  const shortCounts: number[] = [];

  let currentWeights = new Map<string, number>();
  let rebalanceCount = 0;
  let skippedRebalances = 0;

  /**
   * The alignment, stated once.
   *
   * `formationIndex` is the last date whose data the signal may use. The
   * position it implies is then held over dates formationIndex+1 onward. The
   * loop below never reads a signal at an index greater than or equal to the
   * day whose return it is earning.
   */
  for (
    let formationIndex = 0;
    formationIndex < dates.length - 1;
    formationIndex += holdingDays
  ) {
    const formationDate = dates[formationIndex];
    const section = crossSections.get(formationDate) ?? [];
    const weights = formWeights(section, nQuantiles);

    if (!weights) {
      skippedRebalances++;
      // Hold nothing rather than holding stale positions on a date whose
      // cross-section was unusable.
      currentWeights = new Map();
    } else {
      const turnover = turnoverBetween(currentWeights, weights.byEntity);
      turnovers.push(turnover);
      const cost = (costBps / 10000) * turnover;
      costs.push(cost);
      currentWeights = weights.byEntity;
      longCounts.push(weights.longCount);
      shortCounts.push(weights.shortCount);
      rebalanceCount++;
    }

    const holdUntil = Math.min(formationIndex + holdingDays, dates.length - 1);
    for (let d = formationIndex + 1; d <= holdUntil; d++) {
      const date = dates[d];
      const dayReturns = returnsByDate.get(date);
      let portfolioReturn = 0;
      if (dayReturns && currentWeights.size > 0) {
        for (const [entity, weight] of currentWeights) {
          const r = dayReturns.get(entity);
          if (Number.isFinite(r)) portfolioReturn += weight * (r as number);
        }
      }
      // Charge the rebalance cost on the first held day.
      if (d === formationIndex + 1 && costs.length > 0 && currentWeights.size > 0) {
        portfolioReturn -= costs[costs.length - 1];
      }
      dailyReturns.push(portfolioReturn);
      heldDates.push(date);
    }
  }

  if (dailyReturns.length === 0) {
    return {
      ok: false,
      error: "the backtest produced no holding days",
      hint: "The signal column is probably empty over this sample window - check that its warm-up period fits inside the window.",
    };
  }

  if (skippedRebalances > 0) {
    warnings.push(
      `${skippedRebalances} rebalance dates were skipped because the signal had too few finite values to fill ${nQuantiles} quantiles.`,
    );
  }

  // Equity curve and drawdown over the whole held period.
  const equityCurve: number[] = [];
  let wealth = 1;
  for (const r of dailyReturns) {
    wealth *= 1 + r;
    equityCurve.push(wealth);
  }
  const drawdown: number[] = [];
  let peak = -Infinity;
  for (const value of equityCurve) {
    if (value > peak) peak = value;
    drawdown.push(peak > 0 ? value / peak - 1 : 0);
  }

  /**
   * Chronological 70/30, fixed. Not a parameter.
   *
   * Making the split settable would let it be tuned, and a tuned split is not
   * an out-of-sample test - it is one more thing that has been fitted.
   */
  const splitAt = Math.floor(dailyReturns.length * IN_SAMPLE_FRACTION);
  const splitDate = heldDates[splitAt] ?? null;
  const splitIndexInDates = splitDate ? (dateIndex.get(splitDate) ?? 0) : 0;

  /**
   * Approximate. This indexes the full date list while `splitAt` indexes the
   * held days, and the two differ by the days before the first position was
   * formed and by any skipped rebalances. Returns, Sharpe, CAGR and drawdown
   * are all sliced by `splitAt` and are exact; only the per-period
   * `nRebalances` and `averageTurnover` inherit this drift, so do not read
   * those two to the decimal.
   */
  const rebalancesBeforeSplit = Math.ceil(splitIndexInDates / holdingDays);

  return {
    ok: true,
    result: {
      params: { ...params, returnColumn },
      dailyReturns,
      dates: heldDates,
      equityCurve,
      drawdown,
      splitDate,
      full: metricsFor("full", dailyReturns, heldDates, rebalanceCount, turnovers, costs),
      inSample: metricsFor(
        "in_sample",
        dailyReturns.slice(0, splitAt),
        heldDates.slice(0, splitAt),
        Math.min(rebalancesBeforeSplit, rebalanceCount),
        turnovers.slice(0, rebalancesBeforeSplit),
        costs.slice(0, rebalancesBeforeSplit),
      ),
      outOfSample: metricsFor(
        "out_of_sample",
        dailyReturns.slice(splitAt),
        heldDates.slice(splitAt),
        Math.max(0, rebalanceCount - rebalancesBeforeSplit),
        turnovers.slice(rebalancesBeforeSplit),
        costs.slice(rebalancesBeforeSplit),
      ),
      averageLongCount: longCounts.length ? mean(longCounts) : 0,
      averageShortCount: shortCounts.length ? mean(shortCounts) : 0,
      warnings,
    },
  };
}
