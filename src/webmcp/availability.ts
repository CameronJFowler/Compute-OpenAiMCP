/**
 * Which tools exist right now.
 *
 * Kept in its own module so that both the registry (which builds the
 * descriptors) and the session tools (which tell the agent its surface just
 * changed) can read it without importing each other.
 *
 * The rule is craft rule 8: a tool that cannot succeed in the current state is
 * not visible. run_backtest does not exist until there is something to sort on;
 * bootstrap_strategy does not exist until there is a return series to resample.
 * Fewer always-valid tools beat more sometimes-broken ones, and an agent that
 * cannot see a tool cannot waste a turn discovering it was not ready.
 */

import { useWorkspace, signalColumnNames } from "../state/workspace";

export const ALWAYS_ON = [
  "list_datasets",
  "get_state",
  "load_dataset",
  "set_hypothesis",
] as const;

export const WITH_DATASET = [
  "describe_dataset",
  "add_feature",
  "summary_stats",
  "correlate",
  "run_regression",
  "hypothesis_test",
  "record_finding",
  "build_report",
] as const;

export const WITH_SIGNAL = ["run_backtest"] as const;

export const WITH_BACKTEST = ["bootstrap_strategy"] as const;

export const ALL_TOOL_NAMES: string[] = [
  ...ALWAYS_ON,
  ...WITH_DATASET,
  ...WITH_SIGNAL,
  ...WITH_BACKTEST,
];

export interface Availability {
  hasDataset: boolean;
  hasSignal: boolean;
  hasBacktest: boolean;
  names: string[];
}

export function availability(): Availability {
  const state = useWorkspace.getState();
  const hasDataset = state.frame !== null;
  const hasSignal = hasDataset && signalColumnNames().length > 0;
  const hasBacktest = state.lastBacktest !== null;

  const names = [
    ...ALWAYS_ON,
    ...(hasDataset ? WITH_DATASET : []),
    ...(hasSignal ? WITH_SIGNAL : []),
    ...(hasBacktest ? WITH_BACKTEST : []),
  ];

  return { hasDataset, hasSignal, hasBacktest, names };
}

/** Tools that became available between two snapshots of the surface. */
export function newlyAvailable(before: string[], after: string[]): string[] {
  const had = new Set(before);
  return after.filter((name) => !had.has(name));
}
