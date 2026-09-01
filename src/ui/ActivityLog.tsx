import { useEffect, useRef } from "react";

import { formatClock } from "../state/runlog";
import { useWorkspace } from "../state/workspace";

/**
 * The session record, in plain language, and navigable.
 *
 * This is provenance rather than a debug console: it says what happened to the
 * research, not which function ran with which JSON. Findings cite these step
 * numbers, and `record_finding` refuses a claim whose citation is not here.
 *
 * Every step that put something on screen can be clicked to bring it back. A
 * log you can only read tells you a result existed; a log you can walk back
 * through lets you check it, which is the difference the whole project is
 * arguing for.
 */
export function ActivityLog() {
  const steps = useWorkspace((s) => s.steps);
  const viewByStep = useWorkspace((s) => s.viewByStep);
  const viewingStep = useWorkspace((s) => s.viewingStep);
  const restoreStep = useWorkspace((s) => s.restoreStep);
  const returnToLatest = useWorkspace((s) => s.returnToLatest);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Follow the newest step, but not while the operator is reading an old one.
    if (viewingStep === null && scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [steps.length, viewingStep]);

  return (
    <div className="h-full flex items-center gap-4 px-4 overflow-hidden">
      <span className="label shrink-0">Session</span>

      <div
        ref={scrollRef}
        className="flex-1 flex items-center gap-1 overflow-x-auto whitespace-nowrap scroll-smooth"
      >
        {steps.length === 0 ? (
          <span className="text-[12px] text-ink3">
            Nothing recorded yet. Every step is numbered so a finding can cite it.
          </span>
        ) : (
          steps.map((step) => {
            const restorable = viewByStep[step.id] !== undefined;
            const active = viewingStep === step.id;

            const body = (
              <>
                <span className="tnum text-2xs text-ink3">
                  {formatClock(step.startedAt)}
                </span>{" "}
                <span className="tnum text-ink3">{step.id}</span>{" "}
                <span
                  className={
                    step.status === "error"
                      ? "text-neg"
                      : step.status === "running"
                        ? "text-info"
                        : active
                          ? "text-accent"
                          : "text-ink2"
                  }
                >
                  {step.status === "running" ? `${step.tool}…` : step.digest || step.tool}
                </span>
              </>
            );

            if (!restorable) {
              return (
                <span key={step.id} className="text-[12px] shrink-0 px-1.5 py-0.5">
                  {body}
                </span>
              );
            }

            return (
              <button
                key={step.id}
                onClick={() => restoreStep(step.id)}
                title={`Show what step ${step.id} produced`}
                className={`text-[12px] shrink-0 px-1.5 py-0.5 rounded transition-colors ${
                  active ? "bg-accent/[0.12]" : "hover:bg-hair"
                }`}
              >
                {body}
              </button>
            );
          })
        )}
      </div>

      {viewingStep !== null && (
        <button
          onClick={returnToLatest}
          className="shrink-0 px-2 py-[3px] text-[11.5px] rounded border border-hair text-ink3 hover:text-ink hover:border-hair2 transition"
        >
          Back to latest
        </button>
      )}
    </div>
  );
}
