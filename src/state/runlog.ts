/**
 * The run log.
 *
 * Every tool call lands here with its arguments, a digest of what came back,
 * and a timestamp. Two reasons, and the second is the real one:
 *
 *   1. A judge watching the video needs to see that something happened.
 *   2. Research produced by an agent is worth nothing if it cannot be
 *      reproduced. record_finding refuses to attach a claim that has no step
 *      behind it, which is only possible because every step is here.
 */

export type StepStatus = "running" | "ok" | "error" | "awaiting_approval" | "rejected";

export interface RunStep {
  /** 1-based, and stable: findings cite these numbers. */
  id: number;
  tool: string;
  args: Record<string, unknown>;
  status: StepStatus;
  /** One line, the same summary the agent saw. */
  digest: string;
  /** Milliseconds. */
  startedAt: number;
  durationMs: number | null;
  /** p-value produced by this step, when it produced one. */
  pValue: number | null;
  /** Who initiated it. The human can drive the same tools from the dev console. */
  actor: "agent" | "human";
}

export function formatClock(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** One line per step, for the run-log strip and for build_report. */
export function formatStep(step: RunStep): string {
  const argKeys = Object.entries(step.args)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${formatArgValue(v)}`)
    .join(" ");
  return `${step.id}. ${formatClock(step.startedAt)} ${step.tool}${argKeys ? `(${argKeys})` : ""}`;
}

function formatArgValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(formatArgValue).join(",")}]`;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

/** Compact transcript of the session, used by build_report. */
export function formatTranscript(steps: RunStep[]): string {
  return steps
    .filter((s) => s.status === "ok")
    .map((s) => `${formatStep(s)}\n   -> ${s.digest}`)
    .join("\n");
}
