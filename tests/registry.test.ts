import { beforeEach, describe, expect, it } from "vitest";

import { makeColumn, type Column, type Frame } from "../src/engine/frame";
import { useWorkspace } from "../src/state/workspace";
import { ALL_TOOL_NAMES, availability } from "../src/webmcp/availability";
import { resetHostCache, type RegisterToolOptions, type ToolDescriptor } from "../src/webmcp/host";
import {
  computeToolSignature,
  currentDescriptors,
  registeredHandleNames,
  resetRegistry,
  syncTools,
} from "../src/webmcp/registry";

/**
 * A mock host implementing index.bs as written:
 *
 *   Promise<undefined> registerTool(ModelContextTool tool,
 *                                   optional ModelContextRegisterToolOptions options = {});
 *   dictionary ModelContextRegisterToolOptions { AbortSignal signal; ... };
 *
 * Specifically: registerTool returns a promise, a duplicate name REJECTS rather
 * than replacing, there is no unregisterTool, and teardown happens by aborting
 * the signal handed in at registration. Those are the three behaviours most
 * likely to break the reactive registry, so they are the three the mock
 * enforces.
 */
class SpecFaithfulHost {
  tools = new Map<string, ToolDescriptor>();
  registerAttempts = 0;
  duplicateRejections: string[] = [];

  async registerTool(tool: ToolDescriptor, options?: RegisterToolOptions): Promise<void> {
    this.registerAttempts++;
    // A microtask boundary, so interleaved syncs really can interleave.
    await Promise.resolve();

    if (this.tools.has(tool.name)) {
      this.duplicateRejections.push(tool.name);
      throw new Error(`InvalidStateError: a tool named ${tool.name} is already registered`);
    }
    this.tools.set(tool.name, tool);
    options?.signal?.addEventListener("abort", () => {
      this.tools.delete(tool.name);
    });
  }

  async getTools(): Promise<{ name: string }[]> {
    return [...this.tools.keys()].map((name) => ({ name }));
  }
}

function installHost(host: SpecFaithfulHost | null): void {
  const g = globalThis as unknown as { document?: { modelContext?: unknown } };
  if (!g.document) g.document = {};
  g.document.modelContext = host ?? undefined;
  resetHostCache();
}

/** A minimal two-entity panel, enough to make the tool surface move. */
function makeFrame(extraColumns: Record<string, Column> = {}): Frame {
  const dates: string[] = [];
  const entities: string[] = [];
  const ret: number[] = [];
  for (let d = 0; d < 40; d++) {
    for (const e of ["AAA", "BBB", "CCC"]) {
      dates.push(`2020-01-${String(d + 1).padStart(2, "0")}`);
      entities.push(e);
      ret.push(0.001 * (d % 5));
    }
  }
  return {
    id: "test_panel", name: "Test panel", domain: "test",
    nRows: dates.length, dates, entities,
    columnOrder: ["ret", ...Object.keys(extraColumns)],
    columns: { ret: makeColumn("ret", ret, "Daily return."), ...extraColumns },
    source: "synthetic",
  };
}

function derivedColumn(name: string, nRows: number): Column {
  return {
    ...makeColumn(name, new Array(nRows).fill(0.5), "Derived signal."),
    derived: true,
  };
}

beforeEach(async () => {
  await resetRegistry();
  installHost(null);
  useWorkspace.getState().reset();
});

describe("tool availability", () => {
  it("exposes only the four always-on tools before a dataset is loaded", () => {
    const surface = availability();
    expect(surface.names).toEqual([
      "list_datasets", "get_state", "load_dataset", "set_hypothesis",
    ]);
    expect(surface.hasDataset).toBe(false);
  });

  /**
   * The tick that the whole demo hangs on. Loading a dataset takes the surface
   * from 4 tools to 12 without the agent doing anything.
   */
  it("grows from 4 to 12 tools when a dataset loads", () => {
    expect(availability().names).toHaveLength(4);
    useWorkspace.getState().loadFrame(makeFrame(), "test_panel", "Test panel");
    expect(availability().names).toHaveLength(12);
    expect(availability().names).toContain("run_regression");
    expect(availability().names).not.toContain("run_backtest");
  });

  it("adds run_backtest only once a derived causal signal exists", () => {
    const frame = makeFrame();
    useWorkspace.getState().loadFrame(frame, "test_panel", "Test panel");
    expect(availability().hasSignal).toBe(false);

    useWorkspace.getState().addColumn(derivedColumn("momentum", frame.nRows));
    expect(availability().hasSignal).toBe(true);
    expect(availability().names).toContain("run_backtest");
    expect(availability().names).toHaveLength(13);
  });

  it("does not treat a forward-looking column as a signal", () => {
    const frame = makeFrame();
    useWorkspace.getState().loadFrame(frame, "test_panel", "Test panel");
    useWorkspace.getState().addColumn({
      ...derivedColumn("fwd21", frame.nRows),
      forwardLooking: true,
    });
    expect(availability().hasSignal).toBe(false);
    expect(availability().names).not.toContain("run_backtest");
  });

  it("reaches all 14 tools once a backtest exists", () => {
    const frame = makeFrame();
    useWorkspace.getState().loadFrame(frame, "test_panel", "Test panel");
    useWorkspace.getState().addColumn(derivedColumn("momentum", frame.nRows));
    useWorkspace.getState().setLastBacktest({ dailyReturns: [0.01] } as never);

    expect(availability().names).toHaveLength(14);
    expect(new Set(availability().names)).toEqual(new Set(ALL_TOOL_NAMES));
  });
});

describe("schemas bound to live columns", () => {
  /**
   * The mechanism, asserted directly: the column name is inside the schema, not
   * merely accepted by the implementation.
   */
  it("puts the dataset's real column names into the enums", () => {
    const frame = makeFrame();
    useWorkspace.getState().loadFrame(frame, "test_panel", "Test panel");

    const regression = currentDescriptors().find((t) => t.name === "run_regression");
    const dependent = regression?.inputSchema?.properties?.dependent as { enum: string[] };
    expect(dependent.enum).toContain("ret");
    expect(dependent.enum).not.toContain("momentum");

    useWorkspace.getState().addColumn(derivedColumn("momentum", frame.nRows));

    const updated = currentDescriptors().find((t) => t.name === "run_regression");
    const updatedDependent = updated?.inputSchema?.properties?.dependent as { enum: string[] };
    expect(updatedDependent.enum).toContain("momentum");
  });

  it("keeps forward-looking columns out of the regressor enum but allows them as dependent", () => {
    const frame = makeFrame();
    useWorkspace.getState().loadFrame(frame, "test_panel", "Test panel");
    useWorkspace.getState().addColumn({
      ...derivedColumn("fwd21", frame.nRows),
      forwardLooking: true,
    });

    const regression = currentDescriptors().find((t) => t.name === "run_regression");
    const dependent = regression?.inputSchema?.properties?.dependent as { enum: string[] };
    const independent = regression?.inputSchema?.properties?.independent as {
      items: { enum: string[] };
    };

    expect(dependent.enum).toContain("fwd21");
    expect(independent.items.enum).not.toContain("fwd21");
  });
});

describe("tool signature", () => {
  it("changes when a column is added", () => {
    const frame = makeFrame();
    useWorkspace.getState().loadFrame(frame, "test_panel", "Test panel");
    const before = computeToolSignature();
    useWorkspace.getState().addColumn(derivedColumn("momentum", frame.nRows));
    expect(computeToolSignature()).not.toBe(before);
  });

  /**
   * The human moving the sample window must NOT cause a re-registration. It
   * changes what the tools compute over, not what they accept, and tearing the
   * surface down every time someone drags a date would be both wasteful and
   * visible to the agent as a tool list that will not sit still.
   */
  it("does not change when the human narrows the sample window", () => {
    useWorkspace.getState().loadFrame(makeFrame(), "test_panel", "Test panel");
    const before = computeToolSignature();
    useWorkspace.getState().setSampleWindow("2020-01-10", "2020-01-30");
    expect(computeToolSignature()).toBe(before);
  });

  it("does not change when the view or the run log changes", () => {
    useWorkspace.getState().loadFrame(makeFrame(), "test_panel", "Test panel");
    const before = computeToolSignature();
    useWorkspace.getState().setView({ kind: "empty" });
    useWorkspace.getState().beginStep("get_state", {}, "human");
    useWorkspace.getState().setProgress({ label: "x", value: 0.5 });
    expect(computeToolSignature()).toBe(before);
  });
});

describe("registry with no host", () => {
  /**
   * The page has to be honest and legible in a browser with no WebMCP at all -
   * which, today, is most of them. The intended surface is published to the
   * store regardless, so the count in the UI describes what this page offers.
   */
  it("still publishes the intended tool list", async () => {
    await syncTools();
    expect(useWorkspace.getState().registeredTools).toHaveLength(4);

    useWorkspace.getState().loadFrame(makeFrame(), "test_panel", "Test panel");
    await syncTools();
    expect(useWorkspace.getState().registeredTools).toHaveLength(12);
    expect(registeredHandleNames()).toHaveLength(0);
  });
});

describe("registry against a spec-faithful host", () => {
  it("registers every intended tool", async () => {
    const host = new SpecFaithfulHost();
    installHost(host);

    await syncTools();
    expect([...host.tools.keys()].sort()).toEqual(
      ["get_state", "list_datasets", "load_dataset", "set_hypothesis"].sort(),
    );
    expect(host.duplicateRejections).toEqual([]);
  });

  /**
   * Re-registration is the dangerous path. Duplicate names reject rather than
   * replace, so every previous tool has to be torn down - by aborting its
   * signal, since unregisterTool no longer exists - before the new set goes in.
   */
  it("tears down and re-registers cleanly when the columns change", async () => {
    const host = new SpecFaithfulHost();
    installHost(host);

    await syncTools();
    const frame = makeFrame();
    useWorkspace.getState().loadFrame(frame, "test_panel", "Test panel");
    await syncTools();

    expect(host.duplicateRejections).toEqual([]);
    expect(host.tools.size).toBe(12);

    useWorkspace.getState().addColumn(derivedColumn("momentum", frame.nRows));
    await syncTools();

    expect(host.duplicateRejections).toEqual([]);
    expect(host.tools.size).toBe(13);
    expect(host.tools.has("run_backtest")).toBe(true);
  });

  it("removes tools by aborting the signal, with no unregisterTool available", async () => {
    const host = new SpecFaithfulHost();
    installHost(host);
    expect("unregisterTool" in host).toBe(false);

    useWorkspace.getState().loadFrame(makeFrame(), "test_panel", "Test panel");
    await syncTools();
    expect(host.tools.size).toBe(12);

    await resetRegistry();
    expect(host.tools.size).toBe(0);
  });

  /**
   * Zustand fires on every store write, so syncTools is called far more often
   * than the surface actually changes. Without serialisation two syncs would
   * interleave and the second would try to register names the first had not
   * finished removing - which, given duplicates reject, is a real failure and
   * not a cosmetic one.
   */
  it("serialises concurrent syncs without duplicate rejections", async () => {
    const host = new SpecFaithfulHost();
    installHost(host);
    const frame = makeFrame();

    const inFlight: Promise<void>[] = [];
    inFlight.push(syncTools());
    useWorkspace.getState().loadFrame(frame, "test_panel", "Test panel");
    inFlight.push(syncTools());
    useWorkspace.getState().addColumn(derivedColumn("momentum", frame.nRows));
    inFlight.push(syncTools());
    inFlight.push(syncTools());
    useWorkspace.getState().setLastBacktest({ dailyReturns: [0.01] } as never);
    inFlight.push(syncTools());

    await Promise.all(inFlight);

    expect(host.duplicateRejections).toEqual([]);
    expect(host.tools.size).toBe(14);
    expect(useWorkspace.getState().registeredTools).toHaveLength(14);
  });

  it("skips the work entirely when the signature has not moved", async () => {
    const host = new SpecFaithfulHost();
    installHost(host);
    useWorkspace.getState().loadFrame(makeFrame(), "test_panel", "Test panel");

    await syncTools();
    const attemptsAfterFirst = host.registerAttempts;

    useWorkspace.getState().setSampleWindow("2020-01-05", "2020-01-20");
    useWorkspace.getState().setView({ kind: "empty" });
    await syncTools();
    await syncTools();

    expect(host.registerAttempts).toBe(attemptsAfterFirst);
  });
});
