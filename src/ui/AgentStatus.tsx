import { useEffect, useRef, useState } from "react";

import { useWorkspace } from "../state/workspace";

/**
 * A quiet session indicator. Connection/setup instructions live in the guide,
 * not in the working surface.
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
  return (
    <div
      className="flex items-center gap-2.5 px-3 h-7 rounded border border-hair bg-panel"
      title={
        connected
          ? `An agent is connected through WebMCP and can call ${tools.length} tools on this page right now.`
          : "No agent connected. This page registers its tools through WebMCP; open it in ChatGPT or in Chrome with WebMCP enabled."
      }
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          connected ? "bg-pos" : "bg-ink3"
        }`}
      />
      <span className="label !text-ink3">Agent</span>
      <span className="text-[12px] text-ink2">
        {connected ? "connected" : "not connected"}
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
    </div>
  );
}
