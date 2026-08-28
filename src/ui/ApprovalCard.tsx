import { useWorkspace } from "../state/workspace";

/**
 * The human-in-the-loop gate.
 *
 * The tool call is genuinely suspended on this: `requestApproval` returns a
 * promise that settles only when one of these buttons is clicked. From the
 * agent's side the call simply takes a while. Chrome's WebMCP guidance asks for
 * exactly this on expensive or destructive operations.
 */
export function ApprovalCard() {
  const pending = useWorkspace((s) => s.pendingApproval);
  const resolve = useWorkspace((s) => s.resolveApproval);
  if (!pending) return null;

  return (
    <div className="mb-5 border border-accent/45 bg-raised rounded-md">
      <div className="px-4 py-2 border-b border-accent/20 flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-accent" />
        <span className="label !text-accent">Your approval is required</span>
      </div>
      <div className="px-4 py-3.5">
        <div className="text-[14px] text-ink mb-1.5">{pending.title}</div>
        <p className="text-[12.5px] text-ink2 leading-relaxed mb-4 max-w-2xl">
          {pending.detail}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => resolve(true)}
            className="px-3.5 py-1.5 text-[12px] rounded bg-accent text-canvas font-medium hover:brightness-110 transition"
          >
            {pending.confirmLabel}
          </button>
          <button
            onClick={() => resolve(false)}
            className="px-3.5 py-1.5 text-[12px] rounded border border-hair2 text-ink2 hover:text-ink hover:border-ink3 transition"
          >
            Decline
          </button>
          <span className="text-2xs text-ink3 ml-2">
            Nothing runs until you choose.
          </span>
        </div>
      </div>
    </div>
  );
}
