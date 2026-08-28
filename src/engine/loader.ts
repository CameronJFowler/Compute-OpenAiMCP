/**
 * CSV parsing and dataset construction.
 *
 * Three bundled files, three shapes, one Frame out the other end. Everything
 * downstream - transforms, regression, the backtester, the charts - sees the
 * same structure regardless of whether it is looking at industry portfolios or
 * at Hubble's 24 galaxies.
 */

import type { DatasetManifestEntry } from "../config";
import { makeColumn, type Column, type Frame } from "./frame";

/** Minimal RFC-4180-ish parser. Handles quoted fields; our files do not use them. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else if (c !== "\r") {
      field += c;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

function toNumber(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") return NaN;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : NaN;
}

/** Factor columns joined onto a panel, keyed by date. */
export interface FactorJoin {
  names: string[];
  byDate: Map<string, number[]>;
}

export function parseFactorJoin(csvText: string): FactorJoin {
  const rows = parseCsv(csvText);
  const header = rows[0].map((h) => h.trim());
  const names = header.slice(1);
  const byDate = new Map<string, number[]>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length < header.length) continue;
    byDate.set(row[0].trim(), names.map((_, j) => toNumber(row[j + 1])));
  }
  return { names, byDate };
}

const FACTOR_NOTES: Record<string, string> = {
  mkt_rf: "Market return in excess of the risk-free rate (Fama-French). Same for every entity on a date.",
  smb: "Small minus big, the size factor (Fama-French). Same for every entity on a date.",
  hml: "High minus low book-to-market, the value factor (Fama-French). Same for every entity on a date.",
  rf: "Daily risk-free rate (Fama-French). Same for every entity on a date.",
};

/**
 * Wide panel: one row per date, one column per entity, cells are returns.
 *
 * Expanded into a long panel, and given a derived `close` column - a cumulative
 * wealth index per entity starting at 100 - so that momentum and realised
 * volatility, which are defined on prices, have something to operate on.
 */
function buildWidePanel(
  entry: DatasetManifestEntry,
  csvText: string,
  factors: FactorJoin | null,
): Frame {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error(`${entry.id}: no data rows`);

  const header = rows[0].map((h) => h.trim());
  const entityNames = header.slice(1);
  const dataRows = rows.slice(1).filter((r) => r.length === header.length);
  dataRows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const nRows = dataRows.length * entityNames.length;
  const dates: string[] = new Array(nRows);
  const entities: string[] = new Array(nRows);
  const ret: number[] = new Array(nRows);
  const close: number[] = new Array(nRows);

  // Running wealth index per entity, in date order.
  const level = new Map<string, number>(entityNames.map((n) => [n, 100]));

  let cursor = 0;
  for (const row of dataRows) {
    const date = row[0].trim();
    for (let e = 0; e < entityNames.length; e++) {
      const name = entityNames[e];
      const r = toNumber(row[e + 1]);
      dates[cursor] = date;
      entities[cursor] = name;
      ret[cursor] = r;
      if (Number.isFinite(r)) {
        const next = (level.get(name) as number) * (1 + r);
        level.set(name, next);
        close[cursor] = next;
      } else {
        // A gap does not reset the index; it just does not advance it.
        close[cursor] = level.get(name) as number;
      }
      cursor++;
    }
  }

  const columns: Record<string, Column> = {
    ret: makeColumn("ret", ret, "Daily value-weighted return, decimal."),
    close: makeColumn(
      "close",
      close,
      "Cumulative wealth index from ret, starting at 100. Derived, not a traded price.",
    ),
  };
  const columnOrder = ["ret", "close"];

  if (factors) {
    for (let f = 0; f < factors.names.length; f++) {
      const name = factors.names[f];
      const values = new Array<number>(nRows);
      for (let i = 0; i < nRows; i++) {
        const row = factors.byDate.get(dates[i]);
        values[i] = row ? row[f] : NaN;
      }
      columns[name] = makeColumn(
        name,
        values,
        FACTOR_NOTES[name] ?? "Fama-French daily factor, joined on date.",
      );
      columnOrder.push(name);
    }
  }

  return {
    id: entry.id,
    name: entry.name,
    domain: entry.domain,
    nRows,
    dates,
    entities,
    columnOrder,
    columns,
    source: "Kenneth R. French Data Library. See public/data/SOURCES.md.",
  };
}

/** Single time series: one row per date, every other column numeric. */
function buildSeries(entry: DatasetManifestEntry, csvText: string): Frame {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error(`${entry.id}: no data rows`);

  const header = rows[0].map((h) => h.trim());
  const names = header.slice(1);
  const dataRows = rows.slice(1).filter((r) => r.length === header.length);
  dataRows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const dates = dataRows.map((r) => r[0].trim());
  const columns: Record<string, Column> = {};
  for (let j = 0; j < names.length; j++) {
    columns[names[j]] = makeColumn(
      names[j],
      dataRows.map((r) => toNumber(r[j + 1])),
      FACTOR_NOTES[names[j]] ?? "Daily series, decimal.",
    );
  }

  return {
    id: entry.id,
    name: entry.name,
    domain: entry.domain,
    nRows: dataRows.length,
    dates,
    entities: null,
    columnOrder: names,
    columns,
    source: "Kenneth R. French Data Library. See public/data/SOURCES.md.",
  };
}

/**
 * Plain cross-section: no time dimension at all.
 *
 * The first column is a label rather than a date, which is what makes this
 * dataset the honest generality test - none of the time-series machinery
 * applies, and the regression tools work anyway.
 */
function buildCrossSection(entry: DatasetManifestEntry, csvText: string): Frame {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error(`${entry.id}: no data rows`);

  const header = rows[0].map((h) => h.trim());
  const dataRows = rows.slice(1).filter((r) => r.length === header.length);

  const columns: Record<string, Column> = {};
  const columnOrder: string[] = [];

  // Column 0 is the label.
  columns[header[0]] = {
    name: header[0],
    kind: "category",
    values: dataRows.map(() => NaN),
    labels: dataRows.map((r) => r[0].trim()),
    derived: false,
    forwardLooking: false,
    note: "Object identifier.",
  };
  columnOrder.push(header[0]);

  for (let j = 1; j < header.length; j++) {
    columns[header[j]] = makeColumn(
      header[j],
      dataRows.map((r) => toNumber(r[j])),
      header[j] === "distance_mpc"
        ? "Distance in megaparsecs, from Hubble's own calibration."
        : header[j] === "velocity_km_s"
          ? "Radial velocity in km/s, positive meaning recession."
          : "Numeric measurement.",
    );
    columnOrder.push(header[j]);
  }

  return {
    id: entry.id,
    name: entry.name,
    domain: entry.domain,
    nRows: dataRows.length,
    dates: null,
    entities: dataRows.map((r) => r[0].trim()),
    columnOrder,
    columns,
    source: "Hubble (1929) PNAS 15(3):168-173, Table 1. See public/data/SOURCES.md.",
  };
}

export function buildFrame(
  entry: DatasetManifestEntry,
  csvText: string,
  factors: FactorJoin | null = null,
): Frame {
  switch (entry.layout) {
    case "panel_wide":
      return buildWidePanel(entry, csvText, factors);
    case "series":
      return buildSeries(entry, csvText);
    case "cross_section":
      return buildCrossSection(entry, csvText);
  }
}

/** Fetch and build. The only network the app does, and it is same-origin. */
export async function loadDataset(entry: DatasetManifestEntry): Promise<Frame> {
  const response = await fetch(entry.file);
  if (!response.ok) {
    throw new Error(`could not load ${entry.file}: HTTP ${response.status}`);
  }
  const csvText = await response.text();

  let factors: FactorJoin | null = null;
  if (entry.layout === "panel_wide") {
    // The factor join is what makes a market-beta control available without
    // the agent having to load and align a second dataset by hand.
    try {
      const factorResponse = await fetch("/data/ff_factors_daily.csv");
      if (factorResponse.ok) {
        factors = parseFactorJoin(await factorResponse.text());
      }
    } catch {
      factors = null;
    }
  }

  return buildFrame(entry, csvText, factors);
}
