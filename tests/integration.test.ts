import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { USER_DATASET_ID, buildFrameFromCsv } from "../src/engine/loader";
import { useWorkspace } from "../src/state/workspace";
import { resetHostCache } from "../src/webmcp/host";
import { currentDescriptors, resetRegistry, syncTools } from "../src/webmcp/registry";

/**
 * End to end, against the real bundled CSVs, through the real tool surface.
 *
 * Nothing here is mocked except `fetch`, which is pointed at public/ instead of
 * at a server. Everything else - the parser, the factor join, the transforms,
 * the regression, the backtester, the approval gate, the report builder - is
 * the code that ships.
 *
 * The second half is the adversarial pass from the brief: wrong column names,
 * wrong types, calls made out of order, a forward-looking column used as a
 * predictor. Every one of those has to come back as readable guidance rather
 * than a throw, because an agent that gets a stack trace retries the same call.
 */

const PUBLIC_DIR = path.join(__dirname, "..", "public");

beforeAll(() => {
  // Same-origin absolute paths, served from disk.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    const file = path.join(PUBLIC_DIR, url.replace(/^\//, ""));
    try {
      const text = readFileSync(file, "utf-8");
      return { ok: true, status: 200, text: async () => text } as Response;
    } catch {
      return { ok: false, status: 404, text: async () => "" } as Response;
    }
  }) as typeof fetch;
});

beforeEach(async () => {
  await resetRegistry();
  resetHostCache();
  useWorkspace.getState().reset();
  await syncTools();
});

/** Invoke a tool by name, resolving the descriptor from the CURRENT surface. */
async function call(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const descriptor = currentDescriptors().find((d) => d.name === name);
  if (!descriptor) {
    throw new Error(
      `tool "${name}" is not registered right now; available: ${currentDescriptors().map((d) => d.name).join(", ")}`,
    );
  }
  const result = (await descriptor.execute(args)) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { text: result.content[0].text, isError: result.isError === true };
}

function toolNames(): string[] {
  return currentDescriptors().map((d) => d.name);
}

describe("a full session on the industry panel", () => {
  it("starts from a plain-language question and selects the matching dataset", async () => {
    const started = await call("set_hypothesis", {
      hypothesis: "Do Adelie and Gentoo penguins differ in body mass?",
    });

    expect(started.isError).toBe(false);
    expect(started.text).toContain("Dataset selection: matched");
    expect(started.text).toContain("Loaded penguins: 344 rows");
    expect(useWorkspace.getState().datasetId).toBe("penguins");
    expect(useWorkspace.getState().hypothesis).toContain("Gentoo");
    expect(toolNames()).toContain("hypothesis_test");

    const question = await call("set_hypothesis", {
      hypothesis: "Is there a momentum effect in US industry returns after transaction costs?",
    });
    expect(question.isError).toBe(false);
    expect(question.text).toContain("Loaded industries_daily: 135534 rows");
    expect(useWorkspace.getState().datasetId).toBe("industries_daily");
    expect(toolNames()).toContain("run_regression");
  }, 30000);

  it("loads the bundled panel with the factors joined on", async () => {
    expect(toolNames()).toHaveLength(4);

    const loaded = await call("load_dataset", { dataset_id: "industries_daily" });
    expect(loaded.isError).toBe(false);
    expect(loaded.text).toContain("135534 rows");
    expect(loaded.text).toContain("49 entities");
    // The factor join is what makes a market-beta control available without
    // the agent having to align a second dataset by hand.
    expect(loaded.text).toContain("mkt_rf");
    expect(loaded.text).toContain("rf");
    expect(toolNames()).toHaveLength(12);
  }, 30000);

  it("walks the whole research chain and grows the tool surface as it goes", async () => {
    await call("load_dataset", { dataset_id: "industries_daily" });
    expect(toolNames()).toHaveLength(12);
    expect(toolNames()).not.toContain("run_backtest");

    const described = await call("describe_dataset", { columns: ["ret", "mkt_rf"] });
    expect(described.text).toContain("ret:");
    expect(described.text).toContain("mkt_rf:");

    // A signal appears, and with it the tool that needs one.
    const feature = await call("add_feature", {
      transform: "momentum",
      source_column: "close",
      window: 252,
    });
    expect(feature.isError).toBe(false);
    expect(feature.text).toContain("close_mom252");
    expect(toolNames()).toContain("run_backtest");
    expect(toolNames()).toHaveLength(13);

    // The new column is inside the schema, not merely accepted by the code.
    const regression = currentDescriptors().find((d) => d.name === "run_regression");
    const dependent = regression?.inputSchema?.properties?.dependent as { enum: string[] };
    expect(dependent.enum).toContain("close_mom252");

    const fit = await call("run_regression", {
      dependent: "ret",
      independent: ["mkt_rf"],
    });
    expect(fit.isError).toBe(false);
    expect(fit.text).toContain("OLS ret ~ mkt_rf");
    expect(fit.text).toContain("MULTIPLE TESTING");
    // An industry portfolio regressed on the market has a beta near 1.
    const beta = Number(fit.text.match(/mkt_rf\s+est=([-\d.]+)/)?.[1]);
    expect(beta).toBeGreaterThan(0.7);
    expect(beta).toBeLessThan(1.3);
    expect(useWorkspace.getState().tests).toHaveLength(1);

    const backtest = await call("run_backtest", {
      signal_column: "close_mom252",
      holding_days: 21,
    });
    expect(backtest.isError).toBe(false);
    expect(backtest.text).toContain("IN (70%)");
    expect(backtest.text).toContain("OUT (30%)");
    expect(toolNames()).toContain("bootstrap_strategy");
    expect(toolNames()).toHaveLength(14);

    const bootstrap = await call("bootstrap_strategy", {
      n_simulations: 300,
      block_length_days: 21,
    });
    expect(bootstrap.isError).toBe(false);
    expect(bootstrap.text).toContain("Sharpe percentiles");

    // A finding has to cite a step that actually ran.
    const steps = useWorkspace.getState().steps.filter((s) => s.status === "ok");
    const finding = await call("record_finding", {
      finding: "Industry returns load on the market factor with a beta close to one.",
      supporting_steps: [steps[3].id],
    });
    expect(finding.isError).toBe(false);

    const report = await call("build_report", {
      conclusion: "Momentum on industry portfolios does not survive the out-of-sample split.",
    });
    expect(report.isError).toBe(false);

    const markdown = useWorkspace.getState().report ?? "";
    expect(markdown).toContain("## Multiple testing");
    expect(markdown).toContain("## Out-of-sample evidence");
    expect(markdown).toContain("## Limitations");
    expect(markdown).toContain("Momentum on industry portfolios");
  }, 60000);

  it("fits Hubble 1929 with the same tools and recovers his constant", async () => {
    const loaded = await call("load_dataset", { dataset_id: "hubble_1929" });
    expect(loaded.isError).toBe(false);
    expect(loaded.text).toContain("24 rows");

    const fit = await call("run_regression", {
      dependent: "velocity_km_s",
      independent: ["distance_mpc"],
      standard_errors: "classical",
    });
    expect(fit.isError).toBe(false);

    const slope = Number(fit.text.match(/distance_mpc\s+est=([-\d.]+)/)?.[1]);
    // Hubble's own value: about 450 km/s/Mpc, roughly seven times the modern one.
    expect(slope).toBeGreaterThan(400);
    expect(slope).toBeLessThan(500);

    // No time dimension, so the panel-only tools must not be offered.
    expect(toolNames()).not.toContain("run_backtest");
  }, 20000);
});

/**
 * The generality claim, tested rather than asserted.
 *
 * The same four tools that fit a factor model on an equity panel have to fit a
 * climate trend on an annual series and compare penguin species in a plain
 * cross-section, with nothing dataset-specific in the code path. If the loader
 * or the schemas were quietly finance-shaped, these fail.
 */
describe("the same tools on other domains", () => {
  it("regresses temperature on CO2 and reports the years it had to drop", async () => {
    const loaded = await call("load_dataset", { dataset_id: "climate_annual" });
    expect(loaded.isError).toBe(false);
    expect(loaded.text).toContain("co2_ppm");

    const fit = await call("run_regression", {
      dependent: "temp_gcag_c",
      independent: ["co2_ppm"],
    });
    expect(fit.isError).toBe(false);

    const slope = Number(fit.text.match(/co2_ppm\s+est=([-\d.]+)/)?.[1]);
    expect(slope).toBeGreaterThan(0);
    // The Mauna Loa record starts in 1959; the temperature record starts in
    // 1850. The overlap is what gets fitted, and the tool has to say so.
    expect(fit.text).toContain("rows dropped for missing values");

    // A panel-only tool must not be offered on a single series.
    expect(toolNames()).not.toContain("run_backtest");
  }, 30000);

  it("runs a paired test between two independent estimates of the same quantity", async () => {
    await call("load_dataset", { dataset_id: "climate_annual" });
    const result = await call("hypothesis_test", {
      test: "paired_t",
      column: "temp_gcag_c",
      other_column: "temp_gistemp_c",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("H0: the mean of (temp_gcag_c - temp_gistemp_c) is zero.");
    expect(result.text).toContain("MULTIPLE TESTING");
  }, 30000);

  it("detects categorical columns in a cross-section without being told", async () => {
    const loaded = await call("load_dataset", { dataset_id: "penguins" });
    expect(loaded.isError).toBe(false);
    expect(loaded.text).toContain("344 rows");

    const described = await call("describe_dataset");
    expect(described.isError).toBe(false);
    // species/island/sex are labels; the measurements are numeric. Nothing in
    // the loader knows the word "species".
    expect(described.text).toContain("species: category");
    expect(described.text).toContain("island: category");
    expect(described.text).toMatch(/body_mass_g: n=\d+/);
  }, 30000);

  it("compares two groups of one measurement", async () => {
    await call("load_dataset", { dataset_id: "penguins" });

    // group_column only appears in the schema when the dataset has categories.
    const descriptor = currentDescriptors().find((d) => d.name === "hypothesis_test");
    const groupColumn = descriptor?.inputSchema?.properties?.group_column as {
      enum: string[];
    };
    expect(groupColumn.enum).toContain("species");
    expect(groupColumn.enum).not.toContain("body_mass_g");

    const result = await call("hypothesis_test", {
      test: "two_sample_t",
      column: "body_mass_g",
      group_column: "species",
      group_a: "Adelie",
      group_b: "Gentoo",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain(
      "H0: mean body_mass_g is the same for Adelie and Gentoo.",
    );
    // Gentoo are markedly heavier; this is not a marginal result.
    expect(result.text).toMatch(/p=0\.0000|p=\d\.\d+e-/);
  }, 30000);

  it("teaches when a group is named wrongly", async () => {
    await call("load_dataset", { dataset_id: "penguins" });

    const unknown = await call("hypothesis_test", {
      test: "two_sample_t", column: "body_mass_g",
      group_column: "species", group_a: "Adelie", group_b: "Emperor",
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("Emperor");
    expect(unknown.text).toContain("Chinstrap");

    const same = await call("hypothesis_test", {
      test: "two_sample_t", column: "body_mass_g",
      group_column: "species", group_a: "Adelie", group_b: "Adelie",
    });
    expect(same.isError).toBe(true);
    expect(same.text).toContain("no null hypothesis");

    const notCategorical = await call("hypothesis_test", {
      test: "two_sample_t", column: "body_mass_g",
      group_column: "bill_length_mm", group_a: "a", group_b: "b",
    });
    expect(notCategorical.isError).toBe(true);
    expect(notCategorical.text).toContain("not a categorical column");
  }, 30000);

  it("offers no group arguments at all when the dataset has no categories", async () => {
    await call("load_dataset", { dataset_id: "climate_annual" });
    const descriptor = currentDescriptors().find((d) => d.name === "hypothesis_test");
    expect(descriptor?.inputSchema?.properties?.group_column).toBeUndefined();
  }, 30000);
});

describe("comparing more than two groups", () => {
  /**
   * The reason anova exists here. Penguins has three species, so answering
   * "do the species differ in body mass" with pairwise t-tests takes three
   * tests - which is precisely the multiple-comparison behaviour the session
   * counter exists to police. The omnibus test answers it with one.
   */
  it("runs a one-way F test across every group at once", async () => {
    await call("load_dataset", { dataset_id: "penguins" });

    const result = await call("hypothesis_test", {
      test: "anova",
      column: "body_mass_g",
      group_column: "species",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain(
      "H0: mean body_mass_g is the same across all 3 groups of species.",
    );
    expect(result.text).toMatch(/F=\d/);
    // Gentoo are far heavier than the other two; this is not marginal.
    expect(result.text).toMatch(/p=0\.0000|p=\d\.\d+e-/);
    // One test, not three.
    expect(useWorkspace.getState().tests).toHaveLength(1);
    expect(result.text).toContain("would have been 3 tests");
  }, 30000);

  it("refuses a group column that is not categorical", async () => {
    await call("load_dataset", { dataset_id: "penguins" });
    const result = await call("hypothesis_test", {
      test: "anova", column: "body_mass_g", group_column: "bill_length_mm",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not a categorical column");
  }, 30000);
});

describe("relating two categorical columns", () => {
  it("tests independence with chi-square", async () => {
    await call("load_dataset", { dataset_id: "penguins" });

    const result = await call("hypothesis_test", {
      test: "chi_square",
      group_column: "species",
      second_group_column: "island",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("H0: species and island are independent.");
    // Chinstrap live only on Dream and Gentoo only on Biscoe, so species and
    // island are about as dependent as two columns can be.
    expect(result.text).toMatch(/p=0\.0000|p=\d\.\d+e-/);
    expect(result.text).toContain("chi-square=");
  }, 30000);

  it("refuses to test a column against itself", async () => {
    await call("load_dataset", { dataset_id: "penguins" });
    const result = await call("hypothesis_test", {
      test: "chi_square", group_column: "species", second_group_column: "species",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("perfectly dependent on itself");
  }, 30000);

  it("does not offer either test on a dataset with no categories", async () => {
    await call("load_dataset", { dataset_id: "climate_annual" });
    const descriptor = currentDescriptors().find((d) => d.name === "hypothesis_test");
    const tests = descriptor?.inputSchema?.properties?.test as { enum: string[] };

    expect(tests.enum).toContain("one_sample_t");
    expect(tests.enum).not.toContain("anova");
    expect(tests.enum).not.toContain("chi_square");
    expect(descriptor?.inputSchema?.properties?.second_group_column).toBeUndefined();
  }, 30000);
});

describe("refusing to guess the data", () => {
  /**
   * The failure this prevents: asking about education spending and silently
   * receiving 135,534 rows of equity returns. On a bench whose claim is that
   * an agent's numbers should be checkable, quietly analysing the nearest data
   * is the one failure that cannot be allowed to be quiet.
   */
  it("loads nothing and lists the options when no dataset matches", async () => {
    const result = await call("set_hypothesis", {
      hypothesis: "Does higher education spending improve student test scores?",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("NO DATA LOADED");
    expect(useWorkspace.getState().frame).toBeNull();

    // It names everything available rather than picking one.
    for (const id of ["penguins", "climate_annual", "industries_daily", "hubble_1929"]) {
      expect(result.text).toContain(id);
    }
    // The analysis tools stay unregistered, because there is nothing to analyse.
    expect(toolNames()).not.toContain("run_regression");
  }, 30000);

  it("still records the question so the human can see what was asked", async () => {
    await call("set_hypothesis", { hypothesis: "Is there any pattern in the noise?" });
    expect(useWorkspace.getState().hypothesis).toBe("Is there any pattern in the noise?");
  }, 30000);

  it("routes confidently when the question names a domain", async () => {
    const result = await call("set_hypothesis", {
      hypothesis: "Do Adelie and Gentoo penguins differ in body mass?",
    });
    expect(result.text).toContain("Dataset selection: matched");
    expect(useWorkspace.getState().datasetId).toBe("penguins");
  }, 30000);
});

/**
 * A log you can only read tells you a result existed. A log you can walk back
 * through lets you check it, which is the difference this project argues for.
 */
describe("walking back through the session", () => {
  it("remembers what each step put on screen and can bring it back", async () => {
    await call("load_dataset", { dataset_id: "penguins" });
    await call("summary_stats", { columns: ["body_mass_g"] });

    const store = useWorkspace.getState();
    const [first, second] = store.steps.filter((s) => s.status === "ok");

    // Two different results, both remembered.
    expect(store.viewByStep[first.id]).toBeDefined();
    expect(store.viewByStep[second.id]).toBeDefined();
    expect(store.viewByStep[first.id]).not.toEqual(store.viewByStep[second.id]);

    // The newest is on screen and we are in the present.
    expect(useWorkspace.getState().viewingStep).toBeNull();
    expect(useWorkspace.getState().view).toEqual(store.viewByStep[second.id]);

    useWorkspace.getState().restoreStep(first.id);
    expect(useWorkspace.getState().view).toEqual(store.viewByStep[first.id]);
    expect(useWorkspace.getState().viewingStep).toBe(first.id);

    useWorkspace.getState().returnToLatest();
    expect(useWorkspace.getState().view).toEqual(store.viewByStep[second.id]);
    expect(useWorkspace.getState().viewingStep).toBeNull();
  }, 30000);

  it("returns to the present when a new result arrives", async () => {
    await call("load_dataset", { dataset_id: "penguins" });
    const first = useWorkspace.getState().steps.filter((s) => s.status === "ok")[0];

    useWorkspace.getState().restoreStep(first.id);
    expect(useWorkspace.getState().viewingStep).toBe(first.id);

    // Reading history must not leave a later result hidden behind it.
    await call("summary_stats", { columns: ["flipper_length_mm"] });
    expect(useWorkspace.getState().viewingStep).toBeNull();
  }, 30000);

  it("does not offer to restore a step that failed", async () => {
    await call("load_dataset", { dataset_id: "penguins" });
    const before = Object.keys(useWorkspace.getState().viewByStep).length;

    const failed = await call("summary_stats", { columns: ["no_such_column"] });
    expect(failed.isError).toBe(true);

    expect(Object.keys(useWorkspace.getState().viewByStep)).toHaveLength(before);
  }, 30000);

  it("clears the session so a new question starts clean", async () => {
    await call("load_dataset", { dataset_id: "penguins" });
    await call("summary_stats", { columns: ["body_mass_g"] });
    expect(useWorkspace.getState().steps.length).toBeGreaterThan(0);

    // What the back button does.
    useWorkspace.getState().reset();

    const after = useWorkspace.getState();
    expect(after.frame).toBeNull();
    expect(after.steps).toEqual([]);
    expect(after.viewByStep).toEqual({});
    expect(after.viewingStep).toBeNull();
    expect(after.view.kind).toBe("empty");
    expect(after.tests).toEqual([]);
  }, 30000);
});

/**
 * The report is the one artifact that leaves the page, and the project's claim
 * for it is that it is assembled from what actually happened. Fixed prose
 * written for one dataset breaks that claim the moment a second dataset exists.
 */
describe("the report describes the session it came from", () => {
  const reportAfter = async (
    datasetId: string,
    work: () => Promise<unknown>,
  ): Promise<string> => {
    await call("load_dataset", { dataset_id: datasetId });
    await work();
    const steps = useWorkspace.getState().steps.filter((s) => s.status === "ok");
    await call("record_finding", {
      finding: "A finding, for the report to carry.",
      supporting_steps: [steps[steps.length - 1].id],
    });
    await call("build_report", { conclusion: "A conclusion." });
    return useWorkspace.getState().report ?? "";
  };

  it("does not claim finance limitations for a biology dataset", async () => {
    const markdown = await reportAfter("penguins", () =>
      call("hypothesis_test", {
        test: "anova", column: "body_mass_g", group_column: "species",
      }),
    );

    // The old fixed list asserted all of these about whatever was loaded.
    expect(markdown).not.toContain("industry portfolio");
    expect(markdown).not.toContain("value-weighted");
    expect(markdown).not.toContain("wealth index");
    expect(markdown).not.toContain("Transaction costs");

    // And says what is actually true of these data.
    expect(markdown).toContain("three islands of one archipelago");
  }, 40000);

  it("carries the finance limitations when the data is financial", async () => {
    const markdown = await reportAfter("industries_daily", () =>
      call("run_regression", { dependent: "ret", independent: ["mkt_rf"] }),
    );
    expect(markdown).toContain("not tradeable instruments");
    expect(markdown).toContain("wealth index reconstructed");
    // No backtest ran, so no cost model to caveat.
    expect(markdown).not.toContain("Transaction costs");
  }, 40000);

  it("describes only the methods that were actually used", async () => {
    const markdown = await reportAfter("penguins", () =>
      call("hypothesis_test", {
        test: "two_sample_t", column: "body_mass_g",
        group_column: "species", group_a: "Adelie", group_b: "Gentoo",
      }),
    );

    expect(markdown).toContain("Welch");
    // Nothing was regressed, derived, backtested or resampled.
    expect(markdown).not.toContain("Householder QR");
    expect(markdown).not.toContain("forward_return");
    expect(markdown).not.toContain("block bootstrap");
    expect(markdown).not.toContain("70/30");
  }, 40000);
});

describe("backtesting a panel that is not the bundled one", () => {
  /** A synthetic long panel with no column called `ret`. */
  const panelCsv = () => {
    const rows = ["date,site,level"];
    for (let d = 0; d < 320; d++) {
      const date = new Date(Date.UTC(2020, 0, 1) + d * 86400000)
        .toISOString()
        .slice(0, 10);
      for (const [i, site] of ["north", "south", "east", "west"].entries()) {
        rows.push(`${date},${site},${(100 + i * 10 + Math.sin(d / 9 + i) * 5).toFixed(3)}`);
      }
    }
    return rows.join("\n");
  };

  const loadPanel = async () => {
    const frame = buildFrameFromCsv("sites.csv", panelCsv());
    useWorkspace.getState().loadFrame(frame, USER_DATASET_ID, "sites.csv");
    await syncTools();
    await call("add_feature", {
      transform: "momentum", source_column: "level", window: 60,
    });
  };

  it("asks which column is the return instead of failing on a missing `ret`", async () => {
    await loadPanel();
    expect(toolNames()).toContain("run_backtest");

    const result = await call("run_backtest", {
      signal_column: "level_mom60", holding_days: 21,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("has no column called `ret`");
    expect(result.text).toContain("return_column");
    // And it names the columns that could be one.
    expect(result.text).toContain("level");
  }, 40000);

  it("runs once the return column is named", async () => {
    await loadPanel();
    await call("add_feature", {
      transform: "log_return", source_column: "level",
    });

    const result = await call("run_backtest", {
      signal_column: "level_mom60",
      return_column: "level_logret",
      holding_days: 21,
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("IN (70%)");
    expect(result.text).toContain("OUT (30%)");
    expect(toolNames()).toContain("bootstrap_strategy");
  }, 40000);

  it("refuses to sort on the very return it is about to earn", async () => {
    await loadPanel();
    const result = await call("run_backtest", {
      signal_column: "level_mom60",
      return_column: "level_mom60",
      holding_days: 21,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("look-ahead bias with extra steps");
  }, 40000);
});

/**
 * Findings, the run log and the test counter all survive a dataset change. If
 * the data can be swapped silently, a finding citing step 3 ends up printed in
 * a report about a dataset step 3 never touched.
 */
describe("changing dataset mid-session", () => {
  it("re-routes on a new question, but never silently", async () => {
    await call("set_hypothesis", {
      hypothesis: "Do Adelie and Gentoo penguins differ in body mass?",
    });
    await call("hypothesis_test", {
      test: "two_sample_t", column: "body_mass_g",
      group_column: "species", group_a: "Adelie", group_b: "Gentoo",
    });

    const result = await call("set_hypothesis", {
      hypothesis: "Does industry momentum survive out of sample transaction costs?",
    });

    // Asking a new question moves the data - that is the design.
    expect(useWorkspace.getState().datasetId).toBe("industries_daily");
    // But the record from the previous dataset survives, so it is flagged.
    expect(result.text).toContain("REPLACED penguins with industries_daily");
  }, 40000);

  it("does not reload, and so does not discard derived columns, on the same data", async () => {
    await call("set_hypothesis", {
      hypothesis: "How much of global temperature variation is explained by CO2?",
    });
    expect(useWorkspace.getState().datasetId).toBe("climate_annual");

    const feature = await call("add_feature", {
      transform: "lag", source_column: "temp_gcag_c", window: 1,
    });
    expect(feature.isError).toBe(false);
    expect(useWorkspace.getState().frame?.columnOrder).toContain("temp_gcag_c_lag1");

    const result = await call("set_hypothesis", {
      hypothesis: "Has the rate of warming changed in recent decades?",
    });

    expect(result.text).toContain("Still working on climate_annual");
    // A reload would silently have thrown the derived column away.
    expect(useWorkspace.getState().frame?.columnOrder).toContain("temp_gcag_c_lag1");
  }, 40000);

  it("keeps the loaded data when a later question matches nothing", async () => {
    await call("load_dataset", { dataset_id: "penguins" });
    const result = await call("set_hypothesis", {
      hypothesis: "Does higher education spending improve student test scores?",
    });

    expect(result.text).toContain("still holds penguins");
    expect(useWorkspace.getState().datasetId).toBe("penguins");
  }, 40000);

  it("warns loudly when a deliberate load replaces data with recorded work", async () => {
    await call("load_dataset", { dataset_id: "penguins" });
    await call("hypothesis_test", {
      test: "anova", column: "body_mass_g", group_column: "species",
    });

    const result = await call("load_dataset", { dataset_id: "climate_annual" });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("REPLACED penguins with climate_annual");
    expect(result.text).toContain("do not present them as results about");
    // The swap is allowed; it is just not silent.
    expect(useWorkspace.getState().datasetId).toBe("climate_annual");
  }, 40000);

  it("says nothing about replacement on a first load", async () => {
    const result = await call("load_dataset", { dataset_id: "penguins" });
    expect(result.text).not.toContain("REPLACED");
    expect(result.text.split("\n").filter((l) => l === "")).toHaveLength(0);
  }, 40000);
});

describe("the human grabbing the wheel", () => {
  /**
   * Narrowing the sample window must change what the next tool call computes
   * over, without changing the tool surface. There is one workspace and no
   * synchronisation step.
   */
  it("changes what the next call sees without re-registering anything", async () => {
    await call("load_dataset", { dataset_id: "industries_daily" });
    const before = toolNames();

    const full = await call("describe_dataset", { columns: ["ret"] });
    const fullRows = Number(full.text.match(/(\d+) rows in window/)?.[1]);

    useWorkspace.getState().setSampleWindow("2020-01-01", "2020-12-31");

    const narrowed = await call("describe_dataset", { columns: ["ret"] });
    const narrowedRows = Number(narrowed.text.match(/(\d+) rows in window/)?.[1]);

    expect(narrowedRows).toBeLessThan(fullRows);
    expect(narrowedRows).toBeGreaterThan(0);
    expect(toolNames()).toEqual(before);
  }, 30000);
});

describe("approval gates", () => {
  async function prepareBacktest() {
    await call("load_dataset", { dataset_id: "industries_daily" });
    await call("add_feature", {
      transform: "momentum", source_column: "close", window: 252,
    });
    await call("run_backtest", { signal_column: "close_mom252", holding_days: 21 });
  }

  it("suspends a large bootstrap until a human clicks, then runs it", async () => {
    await prepareBacktest();

    const pending = call("bootstrap_strategy", {
      n_simulations: 2500, block_length_days: 21,
    });

    // The card is rendered and the tool call really is waiting on it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const card = useWorkspace.getState().pendingApproval;
    expect(card).not.toBeNull();
    expect(card?.tool).toBe("bootstrap_strategy");
    expect(card?.title).toContain("2,500");

    useWorkspace.getState().resolveApproval(true);
    const result = await pending;
    expect(result.isError).toBe(false);
    expect(result.text).toContain("2,500 stationary block bootstrap paths");
  }, 60000);

  it("reports a declined approval as a recoverable error, not a crash", async () => {
    await prepareBacktest();

    const pending = call("bootstrap_strategy", { n_simulations: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    useWorkspace.getState().resolveApproval(false);

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.text).toContain("declined");
    expect(result.text).toContain("HINT:");
  }, 60000);

  /**
   * Hosts do issue tool calls in parallel. Only one card can be shown, and the
   * second call must not report a refusal that no human made - the agent would
   * relay "you declined" to someone who was never asked.
   */
  it("reports a second concurrent gated call as busy, not as a decline", async () => {
    await prepareBacktest();

    const first = call("bootstrap_strategy", { n_simulations: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useWorkspace.getState().pendingApproval).not.toBeNull();

    const second = await call("bootstrap_strategy", { n_simulations: 3000 });
    expect(second.isError).toBe(true);
    expect(second.text).toContain("already open");
    expect(second.text).toContain("retry");
    // The hint says "nobody has declined anything", so match the attribution
    // itself rather than the bare word.
    expect(second.text).not.toContain("the human declined");

    useWorkspace.getState().resolveApproval(false);
    const firstResult = await first;
    expect(firstResult.text).toContain("declined");
  }, 60000);

  it("runs a small bootstrap without asking", async () => {
    await prepareBacktest();
    const result = await call("bootstrap_strategy", { n_simulations: 200 });
    expect(useWorkspace.getState().pendingApproval).toBeNull();
    expect(result.isError).toBe(false);
  }, 60000);
});

describe("adversarial pass", () => {
  it("refuses analysis tools before a dataset is loaded, by not having them", () => {
    expect(toolNames()).not.toContain("run_regression");
    expect(toolNames()).not.toContain("run_backtest");
  });

  it("teaches rather than throws on a misspelled column", async () => {
    await call("load_dataset", { dataset_id: "industries_daily" });
    const result = await call("run_regression", {
      dependent: "returns", independent: ["mkt_rf"],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("ERROR:");
    expect(result.text).toContain("HINT:");
    expect(result.text).toContain("VALID VALUES:");
    expect(result.text).toContain("ret");
  }, 30000);

  it("refuses a forward-looking column as a predictor and explains why", async () => {
    await call("load_dataset", { dataset_id: "industries_daily" });
    await call("add_feature", {
      transform: "forward_return", source_column: "close", horizon: 21,
    });

    // It is not even in the regressor enum.
    const regression = currentDescriptors().find((d) => d.name === "run_regression");
    const independent = regression?.inputSchema?.properties?.independent as {
      items: { enum: string[] };
    };
    expect(independent.items.enum).not.toContain("close_fwd21");

    // And it is refused if asked for anyway.
    const result = await call("run_regression", {
      dependent: "ret", independent: ["close_fwd21"],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("future");
  }, 30000);

  it("refuses a forward-looking column as a backtest signal", async () => {
    await call("load_dataset", { dataset_id: "industries_daily" });
    await call("add_feature", {
      transform: "forward_return", source_column: "close", horizon: 21,
    });
    // A forward-looking column must not make run_backtest appear.
    expect(toolNames()).not.toContain("run_backtest");
  }, 30000);

  it("refuses a regression of a variable on itself", async () => {
    await call("load_dataset", { dataset_id: "industries_daily" });
    const result = await call("run_regression", {
      dependent: "ret", independent: ["ret", "mkt_rf"],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("both sides");
  }, 30000);

  it("refuses a finding with no supporting step", async () => {
    await call("load_dataset", { dataset_id: "industries_daily" });

    const noSteps = await call("record_finding", {
      finding: "Momentum works.", supporting_steps: [],
    });
    expect(noSteps.isError).toBe(true);
    expect(noSteps.text).toContain("cite");

    const invented = await call("record_finding", {
      finding: "Momentum works.", supporting_steps: [9999],
    });
    expect(invented.isError).toBe(true);
    expect(invented.text).toContain("did not run successfully");
  }, 30000);

  it("handles wrong argument types without throwing", async () => {
    await call("load_dataset", { dataset_id: "industries_daily" });

    const badWindow = await call("add_feature", {
      transform: "momentum", source_column: "close", window: "lots",
    });
    expect(badWindow.isError).toBe(true);
    expect(badWindow.text).toContain("HINT:");

    const badTransform = await call("add_feature", {
      transform: "fourier", source_column: "close",
    });
    expect(badTransform.isError).toBe(true);
    expect(badTransform.text).toContain("VALID VALUES:");

    // A bare string where an array was expected is a common slip and is tolerated.
    const singleString = await call("summary_stats", { columns: "ret" });
    expect(singleString.isError).toBe(false);
  }, 30000);

  it("refuses an unknown dataset id and lists the real ones", async () => {
    const result = await call("load_dataset", { dataset_id: "sp500" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("industries_daily");
    expect(result.text).toContain("hubble_1929");
  });

  it("recovers state after the agent loses track", async () => {
    await call("load_dataset", { dataset_id: "industries_daily" });
    await call("add_feature", {
      transform: "momentum", source_column: "close", window: 252,
    });

    const state = await call("get_state");
    expect(state.isError).toBe(false);
    expect(state.text).toContain("industries_daily");
    expect(state.text).toContain("close_mom252");
    expect(state.text).toContain("Tools:");
    expect(state.text).toContain("run_backtest");
  }, 30000);

  it("carries the state echo on every result", async () => {
    await call("load_dataset", { dataset_id: "industries_daily" });
    for (const [name, args] of [
      ["list_datasets", {}],
      ["describe_dataset", { columns: ["ret"] }],
      ["summary_stats", { columns: ["ret"] }],
    ] as [string, Record<string, unknown>][]) {
      const result = await call(name, args);
      expect(result.text).toContain("STATE |");
      expect(result.text).toContain("tests_run=");
    }
  }, 30000);

  it("keeps every result inside the payload cap", async () => {
    await call("load_dataset", { dataset_id: "industries_daily" });
    await call("add_feature", {
      transform: "momentum", source_column: "close", window: 252,
    });

    const results = [
      await call("get_state"),
      await call("describe_dataset"),
      await call("run_regression", {
        dependent: "ret", independent: ["mkt_rf", "smb", "hml"],
      }),
      await call("correlate", { columns: ["ret", "mkt_rf", "smb", "hml"] }),
      await call("run_backtest", { signal_column: "close_mom252", holding_days: 21 }),
    ];
    for (const result of results) {
      expect(result.text.length).toBeLessThanOrEqual(1500);
    }
  }, 60000);
});
