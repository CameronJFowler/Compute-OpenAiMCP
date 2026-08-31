import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

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
