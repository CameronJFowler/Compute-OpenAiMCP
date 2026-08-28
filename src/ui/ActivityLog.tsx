import { useEffect, useRef } from "react";

import { formatClock } from "../state/runlog";
import { useWorkspace } from "../state/workspace";

/**
 * The session record, in plain language.
 *
 * This is provenance, not a debug console: it says what happened to the
 * research, not which function was invoked with which JSON. Findings cite these
 * step numbers, and `record_finding` refuses a claim whose citation is not
 * here - which is the whole reason the numbering is visible at all.
 */
export function ActivityLog() {
  const steps = useWorkspace((s) => s.steps);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [steps.length]);

  return (
    <div className="h-full flex items-center gap-4 px-4 overflow-hidden">
      <span className="label shrink-0">Session</span>

      <div
        ref={scrollRef}
        className="flex-1 flex items-center gap-5 overflow-x-auto whitespace-nowrap scroll-smooth"
      >
        {steps.length === 0 ? (
          <span className="text-[12px] text-ink3">
            Nothing recorded yet. Every step is numbered so a finding can cite it.
          </span>
        ) : (
          steps.map((step) => (
            <span key={step.id} className="text-[12px] shrink-0 flex items-baseline gap-1.5">
              <span className="tnum text-2xs text-ink3">
                {formatClock(step.startedAt)}
              </span>
              <span className="tnum text-ink3">{step.id}</span>
              <span
                className={
                  step.status === "error"
                    ? "text-neg"
                    : step.status === "running"
                      ? "text-info"
                      : "text-ink2"
                }
              >
                {step.status === "running"
                  ? `${step.tool}…`
                  : step.digest || step.tool}
              </span>
            </span>
          ))
        )}
      </div>
    </div>
  );
}
