/**
 * Shared plumbing for every tool.
 *
 * Wrapping each tool in `defineTool` guarantees four things that are easy to
 * get wrong one tool at a time:
 *
 *   - the call is logged before it runs and closed out after, so the run log is
 *     complete even when a tool fails
 *   - nothing ever throws across the WebMCP boundary; failures come back as
 *     readable text with a hint and the legal values
 *   - every result carries the state echo, so an agent that has drifted can
 *     re-anchor without a second call
 *   - every result ends with the tools that are legal next
 */

import { getStateEcho, useWorkspace } from "../../state/workspace";
import type { JsonSchema, ToolAnnotations, ToolDescriptor } from "../host";
import { formatStateEcho, toolError, toolResult, withNext } from "../result";

export type ToolOutcome =
  | {
      ok: true;
      summary: string;
      structured?: Record<string, unknown>;
      /** Annotates the run-log step. Tests are registered by the tool itself. */
      pValue?: number;
      next?: string[];
      /** Overrides the run-log line. Defaults to the first line of the summary. */
      digest?: string;
    }
  | { ok: false; error: string; hint: string; valid?: unknown };

/**
 * Handed to every tool so it can attribute what it does to the step it is in.
 *
 * A tool that performs statistical tests registers them itself, through
 * `ctx.recordTest`, rather than reporting them back for the wrapper to file.
 * The ordering is the reason: the multiple-testing block a tool prints has to
 * include the tests that tool just ran, which means the counter must be
 * incremented before the summary is written.
 */
export interface ToolContext {
  stepId: number;
  recordTest: (label: string, pValue: number) => void;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
  run: (
    input: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolOutcome> | ToolOutcome;
}

/**
 * Who the next tool call belongs to.
 *
 * Defaults to the agent. The dev console sets it to "human" immediately before
 * invoking a tool; `defineTool` reads and clears it synchronously at the top of
 * execute, before any await, so it cannot leak into a concurrent call.
 */
let nextActor: "agent" | "human" = "agent";

export function setNextActor(actor: "agent" | "human"): void {
  nextActor = actor;
}

function takeActor(): "agent" | "human" {
  const actor = nextActor;
  nextActor = "agent";
  return actor;
}

function firstLine(text: string, limit = 140): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}...` : line;
}

export function defineTool(spec: ToolSpec): ToolDescriptor {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema ?? { type: "object", properties: {} },
    annotations: spec.annotations,
    execute: async (rawInput) => {
      const input = (rawInput ?? {}) as Record<string, unknown>;
      const store = useWorkspace.getState();
      const stepId = store.beginStep(spec.name, input, takeActor());

      const ctx: ToolContext = {
        stepId,
        recordTest: (label, pValue) => {
          if (Number.isFinite(pValue)) {
            useWorkspace.getState().recordTest(label, pValue, stepId);
          }
        },
      };

      try {
        const outcome = await spec.run(input, ctx);

        if (!outcome.ok) {
          useWorkspace.getState().completeStep(stepId, outcome.error, "error");
          return toolError(outcome.error, outcome.hint, outcome.valid);
        }

        // Read the echo AFTER the tool has mutated state, so the counts the
        // agent sees are the ones it just caused.
        const echo = formatStateEcho(getStateEcho());
        const text = withNext(
          `${outcome.summary}\n${echo}`,
          outcome.next ?? [],
        );

        useWorkspace
          .getState()
          .completeStep(
            stepId,
            outcome.digest ?? firstLine(outcome.summary),
            "ok",
            outcome.pValue ?? null,
          );

        return toolResult(text, {
          ok: true,
          step: stepId,
          ...(outcome.structured ?? {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        useWorkspace.getState().completeStep(stepId, message, "error");
        return toolError(
          `${spec.name} failed: ${message}`,
          "This is a bug rather than a usage error. Call get_state to see the current workspace, and try a simpler form of the same call.",
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Argument coercion.
//
// The schema constrains what a well-behaved host will send, but nothing
// guarantees the host validated it, so every value is checked here too.
// ---------------------------------------------------------------------------

export function readString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function readNumber(input: Record<string, unknown>, key: string): number | null {
  const value = input[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function readInteger(input: Record<string, unknown>, key: string): number | null {
  const value = readNumber(input, key);
  return value !== null && Number.isInteger(value) ? value : null;
}

export function readStringArray(
  input: Record<string, unknown>,
  key: string,
): string[] | null {
  const value = input[key];
  if (Array.isArray(value)) {
    const strings = value.filter((v): v is string => typeof v === "string");
    return strings.length === value.length ? strings : null;
  }
  // A single string where an array was expected is a common and harmless slip.
  if (typeof value === "string" && value.trim() !== "") return [value.trim()];
  return null;
}

export function readIntegerArray(
  input: Record<string, unknown>,
  key: string,
): number[] | null {
  const value = input[key];
  if (Array.isArray(value)) {
    const numbers = value
      .map((v) => (typeof v === "number" ? v : Number(v)))
      .filter((v) => Number.isInteger(v));
    return numbers.length === value.length ? numbers : null;
  }
  if (typeof value === "number" && Number.isInteger(value)) return [value];
  return null;
}

/**
 * Catch an argument that is present but uninterpretable.
 *
 * Without this, `window: "lots"` parses to null, the tool falls back to its
 * default, and the agent gets a 252-day momentum column while believing it
 * asked for something else. Silently substituting a default for an argument
 * nobody could parse is worse than failing: it produces a wrong answer that
 * looks like a right one. An omitted argument still takes the default.
 */
export function malformedArgument(
  input: Record<string, unknown>,
  key: string,
  kind: "integer" | "number",
): { ok: false; error: string; hint: string } | null {
  if (!(key in input)) return null;
  const raw = input[key];
  if (raw === undefined || raw === null) return null;

  const parsed = kind === "integer" ? readInteger(input, key) : readNumber(input, key);
  if (parsed !== null) return null;

  return {
    ok: false,
    error: `${key} must be ${kind === "integer" ? "an integer" : "a number"}, but received ${JSON.stringify(raw)}`,
    hint: `Pass ${key} as a bare ${kind}, or omit it entirely to use the default. It was not silently ignored.`,
  };
}

/** Run malformedArgument over several keys, returning the first problem. */
export function checkNumericArguments(
  input: Record<string, unknown>,
  keys: [string, "integer" | "number"][],
): { ok: false; error: string; hint: string } | null {
  for (const [key, kind] of keys) {
    const problem = malformedArgument(input, key, kind);
    if (problem) return problem;
  }
  return null;
}

/** Number formatting shared by every result, so the payloads stay compact. */
export function fmt(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return "n/a";
  if (value !== 0 && Math.abs(value) < 1e-4) return value.toExponential(2);
  if (Math.abs(value) >= 1e6) return value.toExponential(2);
  return value.toFixed(digits);
}

export function pct(value: number, digits = 2): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "n/a";
}
