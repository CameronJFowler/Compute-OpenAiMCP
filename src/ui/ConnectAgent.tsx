import { useState } from "react";

import { useWorkspace } from "../state/workspace";

/**
 * How to attach an agent.
 *
 * This exists because of the most likely way the project fails in front of
 * someone: they open the page in an ordinary browser, there is no WebMCP host,
 * the header says "not attached", and they conclude the agent side is
 * aspirational. Every claim the page makes about human-agent collaboration is
 * unverifiable from a browser that cannot host an agent, so the page has to
 * say plainly what to do about it - including the fact that the tools are
 * fully exercisable without an agent at all, through the dev console.
 */

const PROMPTS = [
  {
    field: "biology",
    text: "Do Adelie and Gentoo penguins differ in body mass? Show me whether the difference survives the session-adjusted threshold.",
  },
  {
    field: "climate",
    text: "Load the climate data and tell me how much of the variation in global temperature is explained by CO2, and how many years you had to drop.",
  },
  {
    field: "finance",
    text: "Is there a momentum effect in US industry returns, and does it survive out of sample and transaction costs?",
  },
];

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be refused; the text is on screen either way.
      setCopied(false);
    }
  };

  return (
    <button
      onClick={copy}
      className="shrink-0 px-2 py-[3px] text-[11px] rounded border border-hair text-ink3 hover:text-ink hover:border-hair2 transition"
    >
      {copied ? "copied" : label}
    </button>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="shrink-0 w-5 h-5 rounded-full border border-hair2 text-ink3 text-[11px] flex items-center justify-center tnum mt-[1px]">
        {n}
      </span>
      <div className="min-w-0">
        <div className="text-[12.5px] text-ink mb-0.5">{title}</div>
        <div className="text-[11.5px] text-ink3 leading-relaxed">{children}</div>
      </div>
    </li>
  );
}

export function ConnectAgent({ compact = false }: { compact?: boolean }) {
  const status = useWorkspace((s) => s.webmcpStatus);
  const connected = status.kind === "ready";
  const url = typeof window !== "undefined" ? window.location.origin + window.location.pathname : "";

  return (
    <section className="border border-hair rounded-md bg-panel">
      <div className="px-4 py-2.5 border-b border-hair flex items-center gap-2.5">
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${connected ? "bg-pos" : "bg-ink3"}`}
        />
        <span className="label">
          {connected ? "Agent connected" : "Connect an agent"}
        </span>
        {!compact && (
          <span className="text-[11.5px] text-ink3 ml-auto">
            {connected
              ? `via ${status.entryPoint}.modelContext`
              : "the bench works without one, but this is the point of it"}
          </span>
        )}
      </div>

      <div className="p-4">
        {connected ? (
          <p className="text-[12.5px] text-ink2 leading-relaxed">
            An agent is attached and can call the tools this page has registered. Ask it
            a question; the results appear here, not in the chat.
          </p>
        ) : (
          <>
            <ol className="space-y-3.5 mb-4">
              <Step n={1} title="Open this page inside an agent browser">
                <span className="text-ink2">ChatGPT&apos;s in-app browser</span> supports
                WebMCP directly — paste the URL into a chat and open it. In{" "}
                <span className="text-ink2">Chrome 149 or later</span>, go to{" "}
                <span className="text-ink2">chrome://flags</span>, search{" "}
                <span className="text-ink2">webmcp</span>, enable it and restart.
              </Step>
              <Step n={2} title="Check the indicator in the header">
                It reads <span className="text-ink2">not attached</span> now. When a host
                is present it turns green and the capability count starts moving as the
                agent works.
              </Step>
              <Step n={3} title="Ask a question in plain language">
                You do not tell it which tools to call. The page hands it a tool list
                built from whatever is currently loaded.
              </Step>
            </ol>

            <div className="flex items-center gap-2 mb-4">
              <code className="flex-1 min-w-0 truncate text-[11.5px] text-ink2 bg-canvas border border-hair rounded px-2 py-1.5">
                {url}
              </code>
              <CopyButton value={url} label="copy URL" />
            </div>
          </>
        )}

        <div className="label mb-2">Try asking</div>
        <ul className="space-y-2">
          {PROMPTS.map((p) => (
            <li key={p.field} className="flex items-start gap-2">
              <span className="text-[10px] text-ink3 uppercase tracking-label w-14 shrink-0 mt-[3px]">
                {p.field}
              </span>
              <span className="flex-1 text-[11.5px] text-ink2 leading-relaxed">
                {p.text}
              </span>
              <CopyButton value={p.text} label="copy" />
            </li>
          ))}
        </ul>

        {!connected && (
          <p className="text-[11.5px] text-ink3 leading-relaxed mt-4 pt-3 border-t border-hair">
            No agent to hand? Add{" "}
            <span className="text-ink2">?dev=1</span> to the URL. That opens a console
            listing every tool the page has registered, with its schema, executable by
            hand — the same tools an agent would call, and the list rebuilds itself as
            the workspace changes.
          </p>
        )}
      </div>
    </section>
  );
}
