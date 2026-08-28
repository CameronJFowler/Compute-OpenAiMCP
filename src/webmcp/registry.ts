/**
 * The reactive tool registry.
 *
 * The tool list is the agent's user interface, and this module renders it the
 * same way React renders the human's: derive it from state, and re-render when
 * the state that determines it changes.
 *
 * Three details that are not optional.
 *
 * 1. The signature is computed BEFORE any await. Zustand fires on every store
 *    write - every progress tick, every view change - and an async sync that
 *    read state after awaiting would see a different world than the one that
 *    triggered it.
 *
 * 2. Syncs are serialized on a promise chain. Registering a name that is
 *    already registered REJECTS rather than replacing it (per index.bs), so two
 *    interleaved syncs would have the second one fail against tools the first
 *    had not finished tearing down.
 *
 * 3. The list of INTENDED tools is published to the store whether or not a host
 *    accepted them. The count in the UI is a statement about what this page
 *    offers, not about what a particular browser managed to take, and the page
 *    has to be honest and legible in a browser with no WebMCP at all.
 */

import { useWorkspace } from "../state/workspace";
import { getModelContext, registerTool, type ToolDescriptor, type ToolHandle } from "./host";
import { buildToolSet } from "./tools";

let handles: ToolHandle[] = [];
let appliedSignature: string | null = null;
let chain: Promise<void> = Promise.resolve();
let started = false;

/**
 * Everything that changes either which tools exist or what is inside their
 * schemas. Deliberately NOT including the sample window: narrowing the dates
 * changes what the tools compute, not what they accept, so it must not cause a
 * re-registration.
 */
export function computeToolSignature(): string {
  const state = useWorkspace.getState();
  const frame = state.frame;

  if (!frame) return "no-dataset";

  const columns = frame.columnOrder
    .map((name) => {
      const column = frame.columns[name];
      return `${name}:${column.kind}${column.forwardLooking ? ":fwd" : ""}${column.derived ? ":d" : ""}`;
    })
    .join(",");

  const panel = frame.entities ? "panel" : "flat";
  const backtest = state.lastBacktest ? "bt" : "no-bt";
  return `${state.datasetId}|${panel}|${columns}|${backtest}`;
}

async function applyToolSet(): Promise<void> {
  // Read the world once, synchronously, before anything can await.
  const signature = computeToolSignature();
  if (signature === appliedSignature) return;

  const descriptors = buildToolSet();
  appliedSignature = signature;

  // Publish intent first. This is what the UI counts, and it must be correct
  // even when there is no host to register with.
  useWorkspace.getState().setRegisteredTools(descriptors.map((d) => d.name));

  const previous = handles;
  handles = [];
  for (const handle of previous) {
    try {
      await handle.dispose();
    } catch {
      // A host that has already dropped the tool is not an error.
    }
  }

  const host = getModelContext();
  if (!host) return;

  for (const descriptor of descriptors) {
    try {
      handles.push(await registerTool(descriptor));
    } catch (err) {
      console.warn(`[compute] could not register ${descriptor.name}:`, err);
    }
  }
}

/** Queue a sync. Safe to call as often as the store changes. */
export function syncTools(): Promise<void> {
  const run = () =>
    applyToolSet().catch((err) => {
      console.warn("[compute] tool sync failed:", err);
    });
  chain = chain.then(run, run);
  return chain;
}

/**
 * Force the next sync to rebuild even if the signature has not moved. Used when
 * a host appears after the page has already settled.
 */
export function invalidateToolSet(): void {
  appliedSignature = null;
}

/** Names the host currently reports, for the dev console to compare against. */
export function registeredHandleNames(): string[] {
  return handles.map((h) => h.name);
}

/** Drop every registration and forget the applied signature. */
export async function resetRegistry(): Promise<void> {
  const previous = handles;
  handles = [];
  appliedSignature = null;
  for (const handle of previous) {
    try {
      await handle.dispose();
    } catch {
      // Already gone.
    }
  }
}

/** Start watching the store. Idempotent. */
export function startRegistry(): () => void {
  if (started) return () => {};
  started = true;

  const unsubscribe = useWorkspace.subscribe(() => {
    void syncTools();
  });
  void syncTools();

  return () => {
    started = false;
    unsubscribe();
  };
}

/** Exposed for tests and the dev console: the current descriptor set. */
export function currentDescriptors(): ToolDescriptor[] {
  return buildToolSet();
}
