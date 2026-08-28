/**
 * The table model everything else operates on.
 *
 * One shape covers all three bundled datasets, which is what lets the same
 * run_regression tool fit a factor model on an equity panel and Hubble's 1929
 * velocity-distance relation without knowing which it is looking at:
 *
 *   - a panel  (dates + entities): equities, one row per date per ticker
 *   - a series (dates, no entities): Fama-French factors, one row per date
 *   - a cross-section (neither): 24 galaxies
 *
 * Missing numeric values are NaN rather than null, so that every numeric column
 * is a flat number[] and the hot loops never branch on type.
 */

export type ColumnKind = "numeric" | "date" | "category";

export interface Column {
  name: string;
  kind: ColumnKind;
  /** NaN marks missing. Empty for category columns. */
  values: number[];
  /** Parallel labels for category columns. */
  labels?: string[];
  derived: boolean;
  transform?: string;
  sourceColumn?: string;
  /**
   * True only for forward_return. A forward-looking column is legal as a
   * dependent variable and never as a regressor or a signal, and the tools
   * refuse it in those positions rather than trusting anyone to remember.
   */
  forwardLooking: boolean;
  /** One line an agent can read to know what the column means. */
  note: string;
}

export interface Frame {
  id: string;
  name: string;
  domain: string;
  nRows: number;
  /** ISO yyyy-mm-dd per row, or null for a plain cross-section. */
  dates: string[] | null;
  /** Entity label per row (a ticker), or null for a single-entity dataset. */
  entities: string[] | null;
  columnOrder: string[];
  columns: Record<string, Column>;
  /** Provenance line shown in the UI and returned by describe_dataset. */
  source: string;
}

export function makeColumn(
  name: string,
  values: number[],
  note: string,
  extra: Partial<Column> = {},
): Column {
  return {
    name,
    kind: "numeric",
    values,
    derived: false,
    forwardLooking: false,
    note,
    ...extra,
  };
}

export function getColumn(frame: Frame, name: string): Column | undefined {
  return frame.columns[name];
}

export function numericColumnNames(frame: Frame): string[] {
  return frame.columnOrder.filter((n) => frame.columns[n]?.kind === "numeric");
}

/** Numeric columns that are legal on the right-hand side of a regression. */
export function regressorCandidates(frame: Frame): string[] {
  return numericColumnNames(frame).filter((n) => !frame.columns[n].forwardLooking);
}

export function isPanel(frame: Frame): boolean {
  return frame.entities !== null;
}

/**
 * Row indices grouped by entity, each group in ascending date order.
 *
 * Every time-series transform runs through here. Computing a return across an
 * entity boundary - the last row of AAPL against the first row of ABBV - is the
 * single easiest way to silently corrupt a panel, so no transform is allowed to
 * index rows directly.
 */
export function entityGroups(frame: Frame): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  const entities = frame.entities;
  const key = (i: number) => (entities ? entities[i] : "__single__");

  for (let i = 0; i < frame.nRows; i++) {
    const k = key(i);
    let group = groups.get(k);
    if (!group) {
      group = [];
      groups.set(k, group);
    }
    group.push(i);
  }

  if (frame.dates) {
    const dates = frame.dates;
    for (const group of groups.values()) {
      group.sort((a, b) => (dates[a] < dates[b] ? -1 : dates[a] > dates[b] ? 1 : 0));
    }
  }
  return groups;
}

/** Row indices grouped by date, for cross-sectional operations. */
export function dateGroups(frame: Frame): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  if (!frame.dates) return groups;
  for (let i = 0; i < frame.nRows; i++) {
    const d = frame.dates[i];
    let group = groups.get(d);
    if (!group) {
      group = [];
      groups.set(d, group);
    }
    group.push(i);
  }
  return groups;
}

export function uniqueSortedDates(frame: Frame): string[] {
  if (!frame.dates) return [];
  return [...new Set(frame.dates)].sort();
}

export function uniqueEntities(frame: Frame): string[] {
  if (!frame.entities) return [];
  return [...new Set(frame.entities)].sort();
}

export function dateRange(frame: Frame): { start: string; end: string } | null {
  const dates = uniqueSortedDates(frame);
  if (dates.length === 0) return null;
  return { start: dates[0], end: dates[dates.length - 1] };
}

/** A new frame with the column added or replaced. Underlying arrays are shared. */
export function withColumn(frame: Frame, column: Column): Frame {
  const exists = column.name in frame.columns;
  return {
    ...frame,
    columnOrder: exists ? frame.columnOrder : [...frame.columnOrder, column.name],
    columns: { ...frame.columns, [column.name]: column },
  };
}

export function withoutColumn(frame: Frame, name: string): Frame {
  const columns = { ...frame.columns };
  delete columns[name];
  return {
    ...frame,
    columnOrder: frame.columnOrder.filter((n) => n !== name),
    columns,
  };
}

/**
 * Restrict to a date window. Derived columns are carried through as already
 * computed, which is correct: a momentum value at date t was built from data
 * before t, and recomputing it inside a narrowed window would throw away the
 * warm-up history and quietly change the number.
 */
export function sliceByDateRange(frame: Frame, start?: string, end?: string): Frame {
  if (!frame.dates || (!start && !end)) return frame;
  const dates = frame.dates;

  const keep: number[] = [];
  for (let i = 0; i < frame.nRows; i++) {
    const d = dates[i];
    if (start && d < start) continue;
    if (end && d > end) continue;
    keep.push(i);
  }

  return selectRows(frame, keep);
}

export function selectRows(frame: Frame, keep: number[]): Frame {
  const columns: Record<string, Column> = {};
  for (const name of frame.columnOrder) {
    const col = frame.columns[name];
    columns[name] = {
      ...col,
      values: keep.map((i) => col.values[i]),
      ...(col.labels ? { labels: keep.map((i) => col.labels![i]) } : {}),
    };
  }
  return {
    ...frame,
    nRows: keep.length,
    dates: frame.dates ? keep.map((i) => frame.dates![i]) : null,
    entities: frame.entities ? keep.map((i) => frame.entities![i]) : null,
    columns,
  };
}

/** Count of finite values in a column. */
export function countFinite(values: number[]): number {
  let n = 0;
  for (const v of values) if (Number.isFinite(v)) n++;
  return n;
}
