/**
 * The workspace: one object, two operators.
 *
 * There is no agent-side copy of any of this and no synchronisation protocol.
 * When the human drags the sample window, the next tool call reads the new
 * window because it reads this store. When a tool computes a regression, the
 * chart redraws because it reads this store. That is the whole design, and it
 * is only available to a tool that runs inside the page.
 *
 * Zustand rather than React context, because tool functions are plain
 * non-React code that has to read and write React state from outside the
 * component tree. useWorkspace.getState() does that in one line.
 */

import { create } from "zustand";

import { DEFAULT_ALPHA } from "../config";
import type { Column, Frame } from "../engine/frame";
import { sliceByDateRange } from "../engine/frame";
import type { BacktestResult } from "../engine/backtest";
import type { CorrelationMatrix } from "../engine/stats";
import type { OlsResult } from "../engine/ols";
import {
  summariseTests,
  type MultipleTestingSummary,
  type RecordedTest,
} from "../engine/multipletests";
import type { RunStep, StepStatus } from "./runlog";

/** What the workspace panel is currently showing. */
export type WorkspaceView =
  | { kind: "empty" }
  | {
      kind: "dataset";
      title: string;
      rows: { label: string; values: string[] }[];
      headers: string[];
      note: string;
    }
  | {
      kind: "series";
      title: string;
      /** One line per entity, capped for legibility. */
      series: { label: string; points: { x: string; y: number }[] }[];
      note: string;
    }
  | {
      kind: "regression";
      title: string;
      result: OlsResult;
      dependentName: string;
      /** Sampled for the scatter; the full series never leaves the page. */
      scatter: { x: number; y: number }[];
      scatterXLabel: string;
      residualPoints: { x: number; y: number }[];
    }
  | { kind: "correlation"; title: string; matrix: CorrelationMatrix }
  | {
      kind: "backtest";
      title: string;
      equityCurve: { x: string; y: number }[];
      drawdown: { x: string; y: number }[];
      splitDate: string | null;
      metrics: { label: string; full: string; inSample: string; outOfSample: string }[];
    }
  | {
      kind: "bootstrap";
      title: string;
      histogram: { binStart: number; binEnd: number; count: number }[];
      percentiles: { label: string; value: number }[];
      observed: number;
      fractionNonPositive: number;
    }
  | { kind: "report"; title: string; markdown: string };

export interface Finding {
  id: number;
  text: string;
  /** Run-log step numbers that support it. */
  supportingSteps: number[];
  createdAt: number;
}

/**
 * Why an approval-gated call ended.
 *
 * `gate_busy` is distinct from `declined` on purpose. If a host issues two
 * gated calls at once, only one card can be shown, and reporting the second as
 * "the human declined" would put words in the operator's mouth - the agent
 * would relay a refusal that nobody made. A busy gate is a retryable condition
 * and has to be described as one.
 */
export type ApprovalOutcome = "approved" | "declined" | "gate_busy";

export interface ApprovalRequest {
  id: number;
  tool: string;
  title: string;
  detail: string;
  /** Rendered on the button. */
  confirmLabel: string;
  resolve: (outcome: ApprovalOutcome) => void;
}

export type WebmcpStatus =
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; entryPoint: "document" | "navigator" };

export type Author = "agent" | "human";

interface WorkspaceState {
  // ---- dataset -----------------------------------------------------------
  datasetId: string | null;
  datasetName: string | null;
  /** The full loaded frame. Never narrowed in place. */
  frame: Frame | null;
  /** Human-editable sample window. Read by every subsequent tool call. */
  sampleStart: string | null;
  sampleEnd: string | null;
  /** Bounds of the loaded data, for the slider extents. */
  dataStart: string | null;
  dataEnd: string | null;

  // ---- brief -------------------------------------------------------------
  hypothesis: string;
  findings: Finding[];
  report: string | null;

  /**
   * Who last touched the shared fields.
   *
   * Both parties write to the same hypothesis and the same sample window, and
   * the interesting thing is not that they can but that they take turns. An
   * agent proposing a question and a human sharpening it is the collaboration,
   * and it is invisible unless the page says who wrote what.
   */
  hypothesisAuthor: Author | null;
  windowAuthor: Author | null;

  // ---- multiple testing --------------------------------------------------
  alpha: number;
  tests: RecordedTest[];

  /**
   * The most recent backtest. bootstrap_strategy is only registered once this
   * exists, because there is nothing to resample before it does.
   */
  lastBacktest: BacktestResult | null;

  // ---- run log -----------------------------------------------------------
  steps: RunStep[];

  // ---- presentation ------------------------------------------------------
  view: WorkspaceView;

  /**
   * What each completed step put on screen.
   *
   * The run log has always recorded that a step happened; this records what it
   * showed, which is what makes the log navigable rather than merely auditable.
   * Views are already downsampled for the charts, so keeping one per step costs
   * little and turns "provenance" into something you can actually walk back
   * through.
   */
  viewByStep: Record<number, WorkspaceView>;

  /** The step being re-examined, or null when looking at the latest result. */
  viewingStep: number | null;
  pendingApproval: ApprovalRequest | null;
  registeredTools: string[];
  webmcpStatus: WebmcpStatus;
  /** Progress for long worker jobs, 0..1, or null when idle. */
  progress: { label: string; value: number } | null;

  // ---- actions -----------------------------------------------------------
  loadFrame: (frame: Frame, datasetId: string, datasetName: string) => void;
  setSampleWindow: (start: string | null, end: string | null, author?: Author) => void;
  setHypothesis: (text: string, author?: Author) => void;
  addColumn: (column: Column) => void;
  recordTest: (label: string, pValue: number, step: number) => void;
  beginStep: (tool: string, args: Record<string, unknown>, actor: "agent" | "human") => number;
  completeStep: (
    id: number,
    digest: string,
    status: StepStatus,
    pValue?: number | null,
  ) => void;
  setView: (view: WorkspaceView) => void;
  setLastBacktest: (result: BacktestResult | null) => void;
  /** Re-display what a completed step showed. */
  restoreStep: (id: number) => void;
  /** Return to the most recent result. */
  returnToLatest: () => void;
  addFinding: (text: string, supportingSteps: number[]) => Finding;
  setReport: (markdown: string) => void;
  setRegisteredTools: (names: string[]) => void;
  setWebmcpStatus: (status: WebmcpStatus) => void;
  setProgress: (progress: { label: string; value: number } | null) => void;
  requestApproval: (
    request: Omit<ApprovalRequest, "id" | "resolve">,
  ) => Promise<ApprovalOutcome>;
  resolveApproval: (approved: boolean) => void;
  reset: () => void;
}

let stepCounter = 0;
let findingCounter = 0;
let approvalCounter = 0;

export const useWorkspace = create<WorkspaceState>()((set, get) => ({
  datasetId: null,
  datasetName: null,
  frame: null,
  sampleStart: null,
  sampleEnd: null,
  dataStart: null,
  dataEnd: null,

  hypothesis: "",
  findings: [],
  report: null,
  hypothesisAuthor: null,
  windowAuthor: null,

  alpha: DEFAULT_ALPHA,
  tests: [],
  lastBacktest: null,

  steps: [],

  view: { kind: "empty" },
  viewByStep: {},
  viewingStep: null,
  pendingApproval: null,
  registeredTools: [],
  webmcpStatus: { kind: "unavailable", reason: "not checked yet" },
  progress: null,

  loadFrame: (frame, datasetId, datasetName) => {
    const dates = frame.dates ? [...new Set(frame.dates)].sort() : [];
    set({
      frame,
      datasetId,
      datasetName,
      dataStart: dates[0] ?? null,
      dataEnd: dates[dates.length - 1] ?? null,
      sampleStart: null,
      sampleEnd: null,
    });
  },

  setSampleWindow: (start, end, author = "human") =>
    set({ sampleStart: start, sampleEnd: end, windowAuthor: author }),

  setHypothesis: (text, author = "human") =>
    set({ hypothesis: text, hypothesisAuthor: author }),

  addColumn: (column) => {
    const frame = get().frame;
    if (!frame) return;
    const exists = column.name in frame.columns;
    set({
      frame: {
        ...frame,
        columnOrder: exists ? frame.columnOrder : [...frame.columnOrder, column.name],
        columns: { ...frame.columns, [column.name]: column },
      },
    });
  },

  recordTest: (label, pValue, step) =>
    set((state) => ({
      tests: [...state.tests, { step, label, pValue, timestamp: Date.now() }],
    })),

  beginStep: (tool, args, actor) => {
    const id = ++stepCounter;
    set((state) => ({
      steps: [
        ...state.steps,
        {
          id,
          tool,
          args,
          status: "running",
          digest: "",
          startedAt: Date.now(),
          durationMs: null,
          pValue: null,
          actor,
        },
      ],
    }));
    return id;
  },

  completeStep: (id, digest, status, pValue = null) =>
    set((state) => ({
      steps: state.steps.map((s) =>
        s.id === id
          ? { ...s, digest, status, pValue, durationMs: Date.now() - s.startedAt }
          : s,
      ),
      // Snapshot what this step put on screen. Tools call setView before they
      // return, so by the time the step closes the view is the one it produced.
      viewByStep:
        status === "ok" && state.view.kind !== "empty"
          ? { ...state.viewByStep, [id]: state.view }
          : state.viewByStep,
    })),

  // A new result always takes you back to the present.
  setView: (view) => set({ view, viewingStep: null }),

  restoreStep: (id) =>
    set((state) => {
      const snapshot = state.viewByStep[id];
      return snapshot ? { view: snapshot, viewingStep: id } : {};
    }),

  returnToLatest: () =>
    set((state) => {
      const ids = Object.keys(state.viewByStep).map(Number);
      if (ids.length === 0) return { viewingStep: null };
      const latest = Math.max(...ids);
      return { view: state.viewByStep[latest], viewingStep: null };
    }),

  setLastBacktest: (result) => set({ lastBacktest: result }),

  addFinding: (text, supportingSteps) => {
    const finding: Finding = {
      id: ++findingCounter,
      text,
      supportingSteps,
      createdAt: Date.now(),
    };
    set((state) => ({ findings: [...state.findings, finding] }));
    return finding;
  },

  setReport: (markdown) => set({ report: markdown }),

  setRegisteredTools: (names) => set({ registeredTools: [...names].sort() }),

  setWebmcpStatus: (status) => set({ webmcpStatus: status }),

  setProgress: (progress) => set({ progress }),

  /**
   * Render an approval card and block the tool call until a human clicks.
   *
   * The returned promise is what the tool awaits, so from the agent's point of
   * view the call simply takes a while. Chrome's own guidance asks for exactly
   * this on expensive or destructive operations.
   */
  requestApproval: (request) =>
    new Promise<ApprovalOutcome>((resolve) => {
      const existing = get().pendingApproval;
      if (existing) {
        // Only one card at a time. This is reported as gate_busy, never as a
        // decline: no human has seen anything, so no human has refused.
        resolve("gate_busy");
        return;
      }
      set({
        pendingApproval: { ...request, id: ++approvalCounter, resolve },
      });
    }),

  resolveApproval: (approved) => {
    const pending = get().pendingApproval;
    if (!pending) return;
    set({ pendingApproval: null });
    pending.resolve(approved ? "approved" : "declined");
  },

  reset: () =>
    set({
      datasetId: null,
      datasetName: null,
      frame: null,
      sampleStart: null,
      sampleEnd: null,
      dataStart: null,
      dataEnd: null,
      hypothesis: "",
      findings: [],
      report: null,
      hypothesisAuthor: null,
      windowAuthor: null,
      tests: [],
      lastBacktest: null,
      steps: [],
      view: { kind: "empty" },
      viewByStep: {},
      viewingStep: null,
      pendingApproval: null,
      progress: null,
    }),
}));

// ---------------------------------------------------------------------------
// Derived reads. Tools call these rather than touching the store directly, so
// that "what the agent sees" and "what the human sees" cannot drift apart.
// ---------------------------------------------------------------------------

/**
 * The frame as narrowed by the current sample window.
 *
 * This is where the human grabs the wheel. Editing the date range in the brief
 * panel changes the return value of this function, and therefore changes what
 * the agent's very next tool call operates on, with nothing to synchronise.
 */
export function getEffectiveFrame(): Frame | null {
  const { frame, sampleStart, sampleEnd } = useWorkspace.getState();
  if (!frame) return null;
  if (!sampleStart && !sampleEnd) return frame;
  return sliceByDateRange(frame, sampleStart ?? undefined, sampleEnd ?? undefined);
}

export function getTestingSummary(): MultipleTestingSummary {
  const { tests, alpha } = useWorkspace.getState();
  return summariseTests(tests.map((t) => t.pValue), alpha);
}

/** The compact state block echoed by every tool result. */
export function getStateEcho(): {
  dataset: string | null;
  n_rows: number;
  columns_n: number;
  tests_run: number;
  adjusted_alpha: number;
} {
  const state = useWorkspace.getState();
  const effective = getEffectiveFrame();
  const summary = getTestingSummary();
  return {
    dataset: state.datasetId,
    n_rows: effective?.nRows ?? 0,
    columns_n: effective?.columnOrder.length ?? 0,
    tests_run: summary.testsRun,
    adjusted_alpha: summary.bonferroniAlpha,
  };
}

/** True once at least one column looks like a usable cross-sectional signal. */
export function hasSignalColumn(): boolean {
  return signalColumnNames().length > 0;
}

/**
 * Columns eligible to be a backtest signal.
 *
 * A signal has to be a derived, causal, numeric column on a panel: you cannot
 * sort a cross-section that has only one entity, and you must never sort on
 * something that looked into the future.
 */
export function signalColumnNames(): string[] {
  const frame = useWorkspace.getState().frame;
  if (!frame || !frame.entities || !frame.dates) return [];
  return frame.columnOrder.filter((name) => {
    const column = frame.columns[name];
    return (
      column.kind === "numeric" &&
      column.derived &&
      !column.forwardLooking
    );
  });
}

/**
 * Categorical columns, which are what a group comparison splits on.
 *
 * This is what lets `hypothesis_test` ask "do these two species differ in body
 * mass" rather than only "do these two columns differ", and it is populated
 * from whatever the loaded dataset happens to have.
 */
export function categoryColumnNames(): string[] {
  const frame = getEffectiveFrame();
  if (!frame) return [];
  return frame.columnOrder.filter((n) => frame.columns[n].kind === "category");
}

/** The distinct labels present in a categorical column, for schema enums. */
export function categoryValues(columnName: string): string[] {
  const frame = getEffectiveFrame();
  const column = frame?.columns[columnName];
  if (!column || column.kind !== "category" || !column.labels) return [];
  return [...new Set(column.labels.filter((l) => l !== ""))].sort();
}

/** Columns legal as a regression dependent variable. */
export function dependentCandidates(): string[] {
  const frame = getEffectiveFrame();
  if (!frame) return [];
  return frame.columnOrder.filter((n) => frame.columns[n].kind === "numeric");
}

/** Columns legal on the right-hand side. Forward-looking columns are excluded. */
export function regressorCandidateNames(): string[] {
  const frame = getEffectiveFrame();
  if (!frame) return [];
  return frame.columnOrder.filter(
    (n) => frame.columns[n].kind === "numeric" && !frame.columns[n].forwardLooking,
  );
}
