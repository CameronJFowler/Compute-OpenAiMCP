import { useEffect, useRef, useState } from "react";

import { useWorkspace } from "../state/workspace";

/**
 * What the agent can currently do, stated for the human.
 *
 * Not a tool inspector - the operator does not need to read schemas. What they
 * need to know is whether an agent is attached and how much of the bench it can
 * reach, because that number changes underneath them: loading a dataset takes
 * the surface from four capabilities to twelve, and the page rewrites the
 * agent's tool list to match. The count moving is the visible evidence of it.
 */
export function AgentStatus() {
  const tools = useWorkspace((s) => s.registeredTools);
  const status = useWorkspace((s) => s.webmcpStatus);
  const [changed, setChanged] = useState(false);
  const previous = useRef(tools.length);

  useEffect(() => {
    if (tools.length !== previous.current) {
      previous.current = tools.length;
      setChanged(true);
      const timer = setTimeout(() => setChanged(false), 1100);
      return () => clearTimeout(timer);
    }
  }, [tools.length]);

  const connected = status.kind === "ready";
  const panelOpen = useWorkspace((s) => s.connectPanelOpen);
  const setPanelOpen = useWorkspace((s) => s.setConnectPanelOpen);

  return (
    <button
      onClick={() => setPanelOpen(!panelOpen)}
      className={`flex items-center gap-2.5 px-3 h-7 rounded border bg-panel transition-colors ${
        panelOpen ? "border-hair2" : "border-hair hover:border-hair2"
      }`}
      title={
        connected
          ? `Connected through ${status.entryPoint}.modelContext. The agent can call ${tools.length} tools right now.`
          : "No agent attached. Click for how to connect one."
      }
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          connected ? "bg-pos" : "bg-ink3"
        }`}
      />
      <span className="label !text-ink3">Agent</span>
      <span className="text-[12px] text-ink2">
        {connected ? "connected" : "not attached"}
      </span>
      <span className="w-px h-3.5 bg-hair2" />
      <span
        className={`text-[12px] tnum transition-colors duration-500 ${
          changed ? "text-accent" : "text-ink2"
        }`}
      >
        {tools.length}
      </span>
      <span className="text-[12px] text-ink3">
        {tools.length === 1 ? "capability" : "capabilities"}
      </span>
    </button>
  );
}
