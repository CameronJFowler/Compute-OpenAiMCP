/**
 * Strategy tools: the backtest and its bootstrap.
 *
 * bootstrap_strategy is the approval-gated one. Above the configured number of
 * simulations it renders a card in the page and awaits a human click, which is
 * what Chrome's WebMCP security guidance asks for on expensive operations. From
 * the agent's point of view the call simply takes longer; from the human's, an
 * agent cannot spend a minute of their laptop without asking.
 */

import {
  APPROVAL_SIMULATION_THRESHOLD,
  IN_SAMPLE_FRACTION,
  MAX_SIMULATIONS,
} from "../../config";
import { runBacktest } from "../../engine/backtest";
import { bootstrapStrategyAsync } from "../../engine/bootstrap";
import {
  getEffectiveFrame,
  signalColumnNames,
  useWorkspace,
} from "../../state/workspace";
import { availability, newlyAvailable } from "../availability";
import type { ToolDescriptor } from "../host";
import { bootstrapStrategySchema, runBacktestSchema } from "../schemas";
import {
  checkNumericArguments,
  defineTool,
  fmt,
  pct,
  readInteger,
  readNumber,
  readString,
  type ToolOutcome,
} from "./common";

const MAX_CURVE_POINTS = 600;

function downsample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const stride = Math.ceil(items.length / max);
  return items.filter((_, i) => i % stride === 0);
}

export function runBacktestTool(
  signalColumns: string[],
  returnColumns: string[],
): ToolDescriptor {
  return defineTool({
    name: "run_backtest",
    description:
      "Sorts the cross-section on a signal column each rebalance, goes long the top quantile and short the bottom in equal dollar amounts, and holds for holding_days. Returns CAGR, annualised volatility, Sharpe, maximum drawdown, turnover and hit rate, reported separately for the full period, the first 70 per cent and the last 30 per cent. The in-sample and out-of-sample split is chronological and fixed at 70/30 and cannot be changed - a split you can tune is not an out-of-sample test. A position formed on a date earns returns from the following day onward. Only derived causal columns can be signals; forward-looking columns are refused.",
    inputSchema: runBacktestSchema(signalColumns, returnColumns),
    annotations: { readOnlyHint: true },
    run: (input): ToolOutcome => {
      const frame = getEffectiveFrame();
      if (!frame) {
        return { ok: false, error: "no dataset is loaded", hint: "Call load_dataset first." };
      }

      const malformed = checkNumericArguments(input, [
        ["holding_days", "integer"],
        ["n_quantiles", "integer"],
        ["cost_bps", "number"],
      ]);
      if (malformed) return malformed;

      const signalColumn = readString(input, "signal_column");
      if (!signalColumn) {
        return {
          ok: false,
          error: "signal_column is required",
          hint: "Create a signal with add_feature (momentum is the usual starting point), then pass its name.",
          valid: signalColumnNames(),
        };
      }

      // The return column used to be hardcoded to `ret`, which meant the tool
      // was offered on any panel with a signal and then failed on every panel
      // that was not the bundled equity one - including a file the operator
      // supplied. It is now an argument, defaulting only where it exists.
      const requestedReturn = readString(input, "return_column");
      const returnColumn = requestedReturn ?? (frame.columns.ret ? "ret" : null);
      if (!returnColumn) {
        return {
          ok: false,
          error: "this dataset has no column called `ret`, so the return column has to be named",
          hint: "Pass return_column: the per-entity periodic return that a position earns. The backtester will not guess which of several numeric columns is a return.",
          valid: frame.columnOrder.filter(
            (n) => frame.columns[n].kind === "numeric" && !frame.columns[n].forwardLooking,
          ),
        };
      }
      if (returnColumn === signalColumn) {
        return {
          ok: false,
          error: `signal_column and return_column are both "${signalColumn}"`,
          hint: "Sorting on the very return you are about to earn is look-ahead bias with extra steps. The signal must be knowable before the return it predicts.",
        };
      }

      const before = availability().names;
      const outcome = runBacktest(frame, {
        signalColumn,
        returnColumn,
        holdingDays: readInteger(input, "holding_days") ?? 21,
        nQuantiles: readInteger(input, "n_quantiles") ?? 5,
        costBps: readNumber(input, "cost_bps") ?? 5,
      });

      if (!outcome.ok) {
        return { ok: false, error: outcome.error, hint: outcome.hint, valid: outcome.valid };
      }

      const result = outcome.result;
      useWorkspace.getState().setLastBacktest(result);

      const indices = downsample(
        result.dates.map((_, i) => i),
        MAX_CURVE_POINTS,
      );
      useWorkspace.getState().setView({
        kind: "backtest",
        title: `${signalColumn}: long-short, ${result.params.holdingDays}d hold, ${result.params.nQuantiles} quantiles, ${result.params.costBps}bps`,
        equityCurve: indices.map((i) => ({ x: result.dates[i], y: result.equityCurve[i] })),
        drawdown: indices.map((i) => ({ x: result.dates[i], y: result.drawdown[i] })),
        splitDate: result.splitDate,
        metrics: [
          { label: "CAGR", full: pct(result.full.cagr), inSample: pct(result.inSample.cagr), outOfSample: pct(result.outOfSample.cagr) },
          { label: "Ann. vol", full: pct(result.full.annualisedVolatility), inSample: pct(result.inSample.annualisedVolatility), outOfSample: pct(result.outOfSample.annualisedVolatility) },
          { label: "Sharpe", full: fmt(result.full.sharpe, 2), inSample: fmt(result.inSample.sharpe, 2), outOfSample: fmt(result.outOfSample.sharpe, 2) },
          { label: "Max drawdown", full: pct(result.full.maxDrawdown), inSample: pct(result.inSample.maxDrawdown), outOfSample: pct(result.outOfSample.maxDrawdown) },
          { label: "Hit rate", full: pct(result.full.hitRate), inSample: pct(result.inSample.hitRate), outOfSample: pct(result.outOfSample.hitRate) },
          { label: "Avg turnover", full: fmt(result.full.averageTurnover, 3), inSample: fmt(result.inSample.averageTurnover, 3), outOfSample: fmt(result.outOfSample.averageTurnover, 3) },
        ],
      });

      const after = availability().names;
      const gained = newlyAvailable(before, after);

      const decayed =
        Number.isFinite(result.inSample.sharpe) &&
        Number.isFinite(result.outOfSample.sharpe) &&
        result.outOfSample.sharpe < result.inSample.sharpe * 0.5;

      return {
        ok: true,
        summary: [
          `Backtest ${signalColumn}: ${result.params.holdingDays}-day hold, ${result.params.nQuantiles} quantiles, ${result.params.costBps}bps, ${result.full.nRebalances} rebalances over ${result.full.nDays} days.`,
          `FULL      CAGR ${pct(result.full.cagr)} vol ${pct(result.full.annualisedVolatility)} Sharpe ${fmt(result.full.sharpe, 2)} maxDD ${pct(result.full.maxDrawdown)} turnover ${fmt(result.full.averageTurnover, 3)}`,
          `IN (70%)  CAGR ${pct(result.inSample.cagr)} Sharpe ${fmt(result.inSample.sharpe, 2)} maxDD ${pct(result.inSample.maxDrawdown)}  [${result.inSample.startDate} to ${result.inSample.endDate}]`,
          `OUT (30%) CAGR ${pct(result.outOfSample.cagr)} Sharpe ${fmt(result.outOfSample.sharpe, 2)} maxDD ${pct(result.outOfSample.maxDrawdown)}  [${result.outOfSample.startDate} to ${result.outOfSample.endDate}]`,
          `Long ${fmt(result.averageLongCount, 1)} / short ${fmt(result.averageShortCount, 1)} names, dollar neutral. Sharpe is not excess of the risk-free rate because the portfolio is self-financing.`,
          decayed
            ? "The out-of-sample Sharpe is less than half the in-sample one. Treat the in-sample number as fitted, not as evidence."
            : "",
          ...result.warnings,
          gained.length ? `TOOL SURFACE CHANGED. Now available: ${gained.join(", ")}.` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        structured: {
          signal: signalColumn,
          full_sharpe: result.full.sharpe,
          in_sample_sharpe: result.inSample.sharpe,
          out_of_sample_sharpe: result.outOfSample.sharpe,
          split_date: result.splitDate,
          in_sample_fraction: IN_SAMPLE_FRACTION,
          newly_available_tools: gained,
        },
        digest: `backtest ${signalColumn}: Sharpe ${fmt(result.full.sharpe, 2)} full, ${fmt(result.outOfSample.sharpe, 2)} out-of-sample`,
        next: ["bootstrap_strategy", "record_finding", "build_report"],
      };
    },
  });
}

export function bootstrapStrategyTool(): ToolDescriptor {
  return defineTool({
    name: "bootstrap_strategy",
    description:
      "Resamples the most recent backtest's daily returns with a stationary block bootstrap and reports the distribution of the Sharpe ratio and terminal wealth, plus the fraction of resampled paths where the Sharpe ratio is not positive. Blocks preserve the autocorrelation of the return series, which an ordinary bootstrap destroys. Use it to find out whether a single Sharpe ratio is distinguishable from luck. Above 2000 simulations this asks the human for approval before it runs and will wait for them.",
    inputSchema: bootstrapStrategySchema(MAX_SIMULATIONS),
    annotations: { readOnlyHint: false },
    run: async (input): Promise<ToolOutcome> => {
      const store = useWorkspace.getState();
      const backtest = store.lastBacktest;
      if (!backtest) {
        return {
          ok: false,
          error: "there is no backtest to resample",
          hint: "Call run_backtest first. This tool resamples that result.",
        };
      }

      const malformed = checkNumericArguments(input, [
        ["n_simulations", "integer"],
        ["block_length_days", "integer"],
      ]);
      if (malformed) return malformed;

      const nSimulations = readInteger(input, "n_simulations");
      if (nSimulations === null || nSimulations < 100) {
        return {
          ok: false,
          error: `n_simulations must be an integer of at least 100, got ${input.n_simulations}`,
          hint: "1000 is a reasonable starting point. Above 2000 a human has to approve it.",
        };
      }
      if (nSimulations > MAX_SIMULATIONS) {
        return {
          ok: false,
          error: `n_simulations is capped at ${MAX_SIMULATIONS}, got ${nSimulations}`,
          hint: `Ask for ${MAX_SIMULATIONS} or fewer.`,
        };
      }

      const blockLengthDays = readInteger(input, "block_length_days") ?? 21;
      if (blockLengthDays < 1 || blockLengthDays > 252) {
        return {
          ok: false,
          error: `block_length_days must be between 1 and 252, got ${blockLengthDays}`,
          hint: "21 is one trading month and is a sensible default.",
        };
      }

      if (nSimulations > APPROVAL_SIMULATION_THRESHOLD) {
        const outcome = await store.requestApproval({
          tool: "bootstrap_strategy",
          title: `Run ${nSimulations.toLocaleString()} bootstrap simulations?`,
          detail: `The agent has asked for ${nSimulations.toLocaleString()} resampled paths of ${backtest.dailyReturns.length} days each, in blocks averaging ${blockLengthDays} days. That is roughly ${((nSimulations * backtest.dailyReturns.length) / 1e6).toFixed(1)} million resampling steps and will run on this machine.`,
          confirmLabel: `Run ${nSimulations.toLocaleString()} simulations`,
        });

        if (outcome === "gate_busy") {
          return {
            ok: false,
            error: "another approval card is already open in the page",
            hint: "Only one approval can be shown at a time, and nobody has declined anything. Wait for the human to resolve the open card, then retry this call unchanged.",
          };
        }
        if (outcome === "declined") {
          return {
            ok: false,
            error: "the human declined to run this many simulations",
            hint: `Ask for ${APPROVAL_SIMULATION_THRESHOLD} or fewer to run without approval, or explain to the human why the larger run is worth it.`,
          };
        }
      }

      store.setProgress({ label: `bootstrap ${nSimulations} paths`, value: 0 });
      let result;
      try {
        result = await bootstrapStrategyAsync(
          backtest.dailyReturns,
          { nSimulations, blockLengthDays },
          (fraction) =>
            useWorkspace
              .getState()
              .setProgress({ label: `bootstrap ${nSimulations} paths`, value: fraction }),
        );
      } finally {
        useWorkspace.getState().setProgress(null);
      }

      useWorkspace.getState().setView({
        kind: "bootstrap",
        title: `${nSimulations.toLocaleString()} stationary block bootstrap paths, ${blockLengthDays}-day blocks`,
        histogram: result.histogram,
        percentiles: [
          { label: "5th", value: result.sharpePercentiles.p5 },
          { label: "25th", value: result.sharpePercentiles.p25 },
          { label: "median", value: result.sharpePercentiles.p50 },
          { label: "75th", value: result.sharpePercentiles.p75 },
          { label: "95th", value: result.sharpePercentiles.p95 },
        ],
        observed: result.observedSharpe,
        fractionNonPositive: result.fractionNonPositiveSharpe,
      });

      const s = result.sharpePercentiles;
      const w = result.terminalWealthPercentiles;

      return {
        ok: true,
        summary: [
          `${nSimulations.toLocaleString()} stationary block bootstrap paths, ${blockLengthDays}-day mean blocks, over ${backtest.dailyReturns.length} days.`,
          `Observed Sharpe ${fmt(result.observedSharpe, 2)}.`,
          `Sharpe percentiles: 5th ${fmt(s.p5, 2)} | 25th ${fmt(s.p25, 2)} | median ${fmt(s.p50, 2)} | 75th ${fmt(s.p75, 2)} | 95th ${fmt(s.p95, 2)}`,
          `Terminal wealth: 5th ${fmt(w.p5, 3)} | median ${fmt(w.p50, 3)} | 95th ${fmt(w.p95, 3)}`,
          `${pct(result.fractionNonPositiveSharpe)} of paths had a Sharpe ratio at or below zero; ${pct(result.fractionLosingMoney)} lost money outright.`,
          result.fractionNonPositiveSharpe > 0.1
            ? "More than one path in ten failed. A single positive Sharpe ratio from this strategy is not strong evidence of an edge."
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
        structured: {
          n_simulations: nSimulations,
          block_length_days: blockLengthDays,
          observed_sharpe: result.observedSharpe,
          sharpe_percentiles: result.sharpePercentiles,
          fraction_non_positive_sharpe: result.fractionNonPositiveSharpe,
        },
        digest: `bootstrap ${nSimulations} paths: median Sharpe ${fmt(s.p50, 2)}, ${pct(result.fractionNonPositiveSharpe)} non-positive`,
        next: ["record_finding", "build_report"],
      };
    },
  });
}
