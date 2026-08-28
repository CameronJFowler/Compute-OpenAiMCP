/**
 * WebMCP host adapter.
 *
 * The spec is young and moved twice in 2026:
 *
 *   - 2026-04-23  unregisterTool(name) was removed from the draft. Tools are
 *                 now torn down by aborting an AbortSignal handed to
 *                 registerTool(tool, { signal }).
 *   - 2026-05-27  the modelContext getter moved from Navigator to Document
 *                 (webmachinelearning/webmcp#184). navigator.modelContext
 *                 survives as a deprecated alias; Chrome 150 warns on it.
 *
 * Per index.bs on main:
 *
 *   partial interface Document {
 *     [SecureContext, SameObject] readonly attribute ModelContext modelContext;
 *   };
 *
 *   interface ModelContext : EventTarget {
 *     Promise<undefined> registerTool(ModelContextTool tool,
 *                                     optional ModelContextRegisterToolOptions options = {});
 *     Promise<sequence<RegisteredTool>> getTools(...);
 *     attribute EventHandler ontoolchange;
 *   };
 *
 * Plenty of secondary documentation still describes the old shapes, and
 * polyfills in the wild still ship unregisterTool. Everything in here is
 * written to work against either, so that a spec revision costs one function
 * rather than a rewrite of the registry.
 */

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolExecuteOptions {
  signal?: AbortSignal;
}

export interface ToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
  execute: (input: Record<string, unknown>, options?: ToolExecuteOptions) => Promise<unknown>;
}

export interface RegisterToolOptions {
  signal?: AbortSignal;
  exposedTo?: string[];
}

/**
 * The subset of ModelContext we actually touch. Every member is optional
 * because we cannot rely on which revision the host implements.
 */
export interface ModelContextLike {
  registerTool(tool: ToolDescriptor, options?: RegisterToolOptions): Promise<void> | void;
  /** Removed from the draft in April 2026, still present in polyfills. */
  unregisterTool?(name: string): Promise<void> | void;
  getTools?(): Promise<unknown[]> | unknown[];
  addEventListener?(type: string, listener: () => void): void;
}

export type HostFlavour = "document" | "navigator" | "none";

let cached: ModelContextLike | null = null;
let flavour: HostFlavour = "none";

/**
 * Resolve the entry point, preferring the canonical location.
 *
 * Order matters: document first because that is what the spec says now, and
 * navigator second because the alias is what older Chrome builds expose. They
 * return the same object where both exist, so the order only decides which
 * name we report in the UI.
 *
 * A successful resolution is cached; a failed one is NOT. An agent browser can
 * inject modelContext after the page has started executing - the spec has a
 * toolchange event, which implies setup is not necessarily synchronous with
 * document creation - and caching a miss would wedge the page as permanently
 * unavailable for a host that showed up 50ms late.
 */
export function getModelContext(): ModelContextLike | null {
  if (cached) return cached;

  const g = globalThis as unknown as {
    document?: { modelContext?: ModelContextLike };
    navigator?: { modelContext?: ModelContextLike };
  };

  const fromDocument = g.document?.modelContext;
  if (fromDocument && typeof fromDocument.registerTool === "function") {
    cached = fromDocument;
    flavour = "document";
    return cached;
  }

  const fromNavigator = g.navigator?.modelContext;
  if (fromNavigator && typeof fromNavigator.registerTool === "function") {
    cached = fromNavigator;
    flavour = "navigator";
    return cached;
  }

  cached = null;
  flavour = "none";
  return null;
}

/**
 * Forget the resolved host so the next call probes again.
 *
 * Needed when a host goes away, and used by the tests to swap in a mock that
 * implements the spec as written.
 */
export function resetHostCache(): void {
  cached = null;
  flavour = "none";
}

/** Which spelling the host actually provided. Rendered in the status bar. */
export function getHostFlavour(): HostFlavour {
  getModelContext();
  return flavour;
}

/**
 * Poll for a host that has not appeared yet, then run `onFound` once.
 * Returns a cancel function. Gives up quietly after `timeoutMs`.
 */
export function waitForHost(
  onFound: () => void,
  timeoutMs = 10000,
  intervalMs = 250,
): () => void {
  if (getModelContext()) {
    onFound();
    return () => {};
  }
  const deadline = Date.now() + timeoutMs;
  const timer = setInterval(() => {
    if (getModelContext()) {
      clearInterval(timer);
      onFound();
    } else if (Date.now() > deadline) {
      clearInterval(timer);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

export function webmcpAvailable(): boolean {
  return getModelContext() !== null;
}

/** True when the page can register tools at all. WebMCP needs a secure context. */
export function isSecureContext(): boolean {
  const g = globalThis as unknown as { isSecureContext?: boolean };
  return g.isSecureContext !== false;
}

/**
 * A single registered tool, holding whatever teardown mechanism the host
 * supports. The registry only ever calls `dispose()`.
 */
export interface ToolHandle {
  name: string;
  dispose: () => Promise<void>;
}

/**
 * Register one tool and return a handle that removes it again.
 *
 * Teardown prefers the AbortController the spec now mandates, and falls back
 * to unregisterTool for hosts that predate the change. Both are attempted on
 * dispose because a host that ignores the signal would otherwise leak the tool
 * and make the next registration of that name reject as a duplicate.
 */
export async function registerTool(tool: ToolDescriptor): Promise<ToolHandle> {
  const host = getModelContext();
  if (!host) throw new Error("WebMCP is not available in this browser");

  const controller = new AbortController();
  let disposed = false;

  try {
    await host.registerTool(tool, { signal: controller.signal });
  } catch (err) {
    // A duplicate name rejects rather than replacing. Clear it and retry once
    // so that a hot reload or a re-entrant state update is not fatal.
    const message = err instanceof Error ? err.message : String(err);
    if (/exist|duplicate|InvalidStateError/i.test(message) && host.unregisterTool) {
      await host.unregisterTool(tool.name);
      await host.registerTool(tool, { signal: controller.signal });
    } else {
      throw err;
    }
  }

  return {
    name: tool.name,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      controller.abort();
      if (host.unregisterTool) {
        try {
          await host.unregisterTool(tool.name);
        } catch {
          // Expected on spec-current hosts, where the abort already did it.
        }
      }
    },
  };
}

/** Tool names the host currently reports, for the UI to display. */
export async function listHostTools(): Promise<string[]> {
  const host = getModelContext();
  if (!host?.getTools) return [];
  try {
    const tools = await host.getTools();
    return tools
      .map((t) => (t as { name?: string }).name)
      .filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
}
