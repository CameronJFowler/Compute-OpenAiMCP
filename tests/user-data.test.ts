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
