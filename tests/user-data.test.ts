import { beforeEach, describe, expect, it } from "vitest";

import { USER_DATASET_ID, buildFrameFromCsv } from "../src/engine/loader";
import { useWorkspace } from "../src/state/workspace";
import { resetHostCache } from "../src/webmcp/host";
import { currentDescriptors, resetRegistry, syncTools } from "../src/webmcp/registry";

/**
 * Data the page has never seen.
 *
 * This is where the bench stops being a demo over five bundled files. The
 * important assertion is not that the CSV parses - it is that the agent's tool
 * schemas end up carrying column names that exist nowhere in this repository.
 */

beforeEach(async () => {
  await resetRegistry();
  resetHostCache();
  useWorkspace.getState().reset();
  await syncTools();
});

describe("buildFrameFromCsv", () => {
  it("reads a plain cross-section and infers column types from content", () => {
    const frame = buildFrameFromCsv(
      "trial.csv",
      [
        "patient,arm,age,systolic_bp",
        "p1,placebo,54,142",
        "p2,treatment,61,128",
        "p3,placebo,47,151",
        "p4,treatment,58,131",
      ].join("\n"),
    );

    expect(frame.id).toBe(USER_DATASET_ID);
    expect(frame.nRows).toBe(4);
    expect(frame.dates).toBeNull();
    expect(frame.columns.patient.kind).toBe("category");
    expect(frame.columns.arm.kind).toBe("category");
    expect(frame.columns.age.kind).toBe("numeric");
    expect(frame.columns.systolic_bp.values).toEqual([142, 128, 151, 131]);
    // The first categorical column names the rows.
    expect(frame.entities?.[0]).toBe("p1");
  });

  it("recognises a leading date column and becomes a series", () => {
    const frame = buildFrameFromCsv(
      "readings.csv",
      [
        "date,reading",
        "2024-01-01,12.5",
        "2024-01-02,13.1",
        "2024-01-03,11.8",
      ].join("\n"),
    );

    expect(frame.dates).toEqual(["2024-01-01", "2024-01-02", "2024-01-03"]);
    expect(frame.entities).toBeNull();
    expect(frame.columnOrder).toEqual(["reading"]);
  });

  it("recognises dates plus a repeating label as a panel", () => {
    const frame = buildFrameFromCsv(
      "panel.csv",
      [
        "date,site,rainfall_mm",
        "2024-01-01,north,4.2",
        "2024-01-01,south,1.1",
        "2024-01-02,north,3.8",
        "2024-01-02,south,0.4",
      ].join("\n"),
    );

    expect(frame.dates).toHaveLength(4);
    expect(new Set(frame.entities ?? [])).toEqual(new Set(["north", "south"]));
  });

  it("treats a sparsely numeric column as categorical", () => {
    const frame = buildFrameFromCsv(
      "mixed.csv",
      [
        "label,value",
        "alpha,1",
        "beta,two",
        "gamma,three",
        "delta,four",
      ].join("\n"),
    );
    // Only one of four parses as a number, so it is a label column.
    expect(frame.columns.value.kind).toBe("category");
  });

  it("explains itself rather than throwing something opaque", () => {
    expect(() => buildFrameFromCsv("empty.csv", "a,b")).toThrow(/no data rows/);
    expect(() => buildFrameFromCsv("single.csv", "only\n1\n2")).toThrow(/two or more/);
    expect(() => buildFrameFromCsv("ragged.csv", "a,b,c\n1,2\n3,4")).toThrow(
      /same number of fields/,
    );
  });
});

/**
 * The notes are what `describe_dataset` returns, and the tool descriptions send
 * the agent there before it assumes what a column means. On an uploaded file
 * there are no hand-written notes, so they have to be read off the data - and
 * they have to say something the agent could not already see from the type.
 */
describe("column meaning, inferred from the data", () => {
  const meaningOf = (csv: string, column: string) =>
    buildFrameFromCsv("f.csv", csv).columns[column].note;

  it("names the levels of a grouping and says it can be grouped on", () => {
    const note = meaningOf(
      "arm,v\nplacebo,1\ntreatment,2\nplacebo,3\ntreatment,4",
      "arm",
    );
    expect(note).toContain("2 levels");
    expect(note).toContain("placebo, treatment");
    expect(note).toContain("group_column");
  });

  it("recognises a column that identifies rows rather than grouping them", () => {
    const note = meaningOf(
      "patient,v\np1,1\np2,2\np3,3\np4,4",
      "patient",
    );
    expect(note).toContain("identifies rows");
    expect(note).toContain("Not usable as a grouping");
  });

  it("warns that a binary column is an indicator, not a measurement", () => {
    const note = meaningOf(
      "flag,v\n1,10\n0,11\n1,12\n0,13",
      "flag",
    );
    expect(note).toContain("binary indicator");
    expect(note).toContain("proportion, not an average");
  });

  it("spots a calendar year", () => {
    const note = meaningOf(
      "year,v\n1990,1\n1991,2\n1992,3\n1993,4",
      "year",
    );
    expect(note).toContain("calendar-year range");
    expect(note).toContain("time trend");
  });

  it("spots a proportion", () => {
    const note = meaningOf(
      "share,v\n0.12,1\n0.44,2\n0.91,3\n0.05,4",
      "share",
    );
    expect(note).toContain("[0, 1]");
    expect(note).toContain("proportion or a rate");
  });

  it("gives range and mean for an ordinary measurement, and counts what is missing", () => {
    const note = meaningOf(
      "bp,v\n142,1\n128,2\n,3\n151,4",
      "bp",
    );
    expect(note).toContain("from 128 to 151");
    expect(note).toContain("1 missing");
  });

  it("says nothing it cannot see - no unit or domain is invented", () => {
    const note = meaningOf(
      "systolic_bp,v\n142,1\n128,2\n151,3\n131,4",
      "systolic_bp",
    );
    // The name suggests mmHg and a clinical setting. Neither is claimed.
    expect(note).not.toMatch(/mmHg|blood|clinical|patient/i);
    // Nor is a purpose guessed from the fact that the values happen to be whole.
    expect(note).not.toMatch(/count|percentage/i);
    expect(note).toContain("whole numbers");
  });

  it("does not mistake an age for a count", () => {
    const note = meaningOf("age,v\n54,1\n61,2\n47,3\n66,4", "age");
    expect(note).toContain("from 47 to 66");
    expect(note).not.toMatch(/count|percentage/i);
  });
});

describe("the tool surface adopts data the page has never seen", () => {
  it("puts the operator's own column names into the agent's schemas", async () => {
    const frame = buildFrameFromCsv(
      "trial.csv",
      [
        "patient,arm,age,systolic_bp",
        "p1,placebo,54,142",
        "p2,treatment,61,128",
        "p3,placebo,47,151",
        "p4,treatment,58,131",
        "p5,placebo,66,149",
        "p6,treatment,52,133",
      ].join("\n"),
    );

    useWorkspace.getState().loadFrame(frame, USER_DATASET_ID, "trial.csv");
    await syncTools();

    const regression = currentDescriptors().find((d) => d.name === "run_regression");
    const dependent = regression?.inputSchema?.properties?.dependent as { enum: string[] };

    // Column names that appear nowhere in this repository.
    expect(dependent.enum).toContain("systolic_bp");
    expect(dependent.enum).toContain("age");
    expect(dependent.enum).not.toContain("body_mass_g");

    // And the categorical column is offered as a grouping.
    const hypothesis = currentDescriptors().find((d) => d.name === "hypothesis_test");
    const groupColumn = hypothesis?.inputSchema?.properties?.group_column as {
      enum: string[];
    };
    expect(groupColumn.enum).toContain("arm");

    const groupA = hypothesis?.inputSchema?.properties?.group_a as { enum: string[] };
    expect(groupA.enum).toContain("treatment");
    expect(groupA.enum).toContain("placebo");
  });

  it("offers the full analysis surface once operator data is loaded", async () => {
    const frame = buildFrameFromCsv(
      "readings.csv",
      ["date,reading", "2024-01-01,1", "2024-01-02,2", "2024-01-03,3"].join("\n"),
    );
    useWorkspace.getState().loadFrame(frame, USER_DATASET_ID, "readings.csv");
    await syncTools();

    const names = currentDescriptors().map((d) => d.name);
    expect(names).toContain("run_regression");
    expect(names).toContain("summary_stats");
    // Single series, so nothing to sort cross-sectionally.
    expect(names).not.toContain("run_backtest");
  });
});
