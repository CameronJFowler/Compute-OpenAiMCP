import { useMemo, useState } from "react";

import type { ToolDescriptor } from "../webmcp/host";
import { currentDescriptors } from "../webmcp/registry";
import { setNextActor } from "../webmcp/tools/common";
import { useWorkspace } from "../state/workspace";

/**
 * The dev console.
 *
 * It exists because the tool surface has to be testable with no agent in the
 * loop - and because, today, most browsers have no WebMCP host at all, so this
 * is the only way to exercise the tools locally. It is left in the shipped
 * build behind ?dev=1 on purpose: it is the most direct demonstration that the
 * registry is reactive, since the list below rebuilds itself as the workspace
 * changes.
 */

/** A starting argument object built from the schema's required fields. */
function templateFor(descriptor: ToolDescriptor): string {
  const schema = descriptor.inputSchema;
  const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema?.required ?? []) as string[];
  if (required.length === 0) return "{}";

  const draft: Record<string, unknown> = {};
  for (const key of required) {
    const property = properties[key] ?? {};
    if (Array.isArray(property.enum)) {
      draft[key] = property.enum[0];
    } else if (property.type === "array") {
      const items = property.items as Record<string, unknown> | undefined;
      draft[key] = Array.isArray(items?.enum) ? [items!.enum[0]] : [];
    } else if (property.type === "integer" || property.type === "number") {
      draft[key] = typeof property.minimum === "number" ? property.minimum : 1;
    } else {
      draft[key] = "";
    }
  }
  return JSON.stringify(draft, null, 2);
}

function schemaSummary(descriptor: ToolDescriptor): string {
  const properties = (descriptor.inputSchema?.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = new Set((descriptor.inputSchema?.required ?? []) as string[]);
  const entries = Object.entries(properties);
  if (entries.length === 0) return "no arguments";

  return entries
    .map(([key, property]) => {
      const items = property.items as Record<string, unknown> | undefined;
      const values = Array.isArray(property.enum)
        ? property.enum
        : Array.isArray(items?.enum)
          ? items!.enum
          : null;
      const type = values
        ? `enum(${(values as string[]).join("|")})`
        : String(property.type ?? "any");
      return `${key}${required.has(key) ? "*" : "?"}: ${type}`;
    })
    .join("\n");
}

export function DevConsole() {
  const registeredTools = useWorkspace((s) => s.registeredTools);
  // Rebuilt whenever the surface changes, which is the point of showing it.
  const descriptors = useMemo(() => currentDescriptors(), [registeredTools.join(",")]);

  const [selected, setSelected] = useState<string | null>(null);
  const [args, setArgs] = useState("{}");
  const [output, setOutput] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);

  const descriptor = descriptors.find((d) => d.name === selected) ?? null;

  const select = (name: string) => {
    const target = descriptors.find((d) => d.name === name);
    setSelected(name);
    setArgs(target ? templateFor(target) : "{}");
    setOutput("");
  };

  const execute = async () => {
    if (!descriptor) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(args || "{}");
    } catch (err) {
      setOutput(`Arguments are not valid JSON: ${String(err)}`);
      return;
    }

    setBusy(true);
    setOutput("running...");
    try {
      // Marks the run-log entry as human-driven. Read synchronously at the top
      // of execute, before any await.
      setNextActor("human");
      const result = (await descriptor.execute(parsed)) as {
        content?: { text?: string }[];
      };
      setOutput(result?.content?.[0]?.text ?? JSON.stringify(result, null, 2));
    } catch (err) {
      setOutput(`THREW (tools should never throw): ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-11 right-3 px-2.5 py-1 text-[10.5px] rounded border border-hair bg-panel text-ink3 hover:text-accent"
      >
        dev console
      </button>
    );
  }

  return (
    <div className="border-t border-accent/30 bg-panel h-[290px] flex flex-col">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-hair">
        <span className="text-[10px] uppercase tracking-[0.14em] text-accent">
          Dev console · {descriptors.length} tools registered right now
        </span>
        <button
          onClick={() => setOpen(false)}
          className="text-[10.5px] text-ink3 hover:text-ink"
        >
          hide
        </button>
      </div>

      <div className="flex-1 flex min-h-0">
        <div className="w-52 border-r border-hair overflow-y-auto shrink-0">
          {descriptors.map((d) => (
            <button
              key={d.name}
              onClick={() => select(d.name)}
              className={`block w-full text-left px-2.5 py-1 text-[11px] border-b border-hair/50 ${
                selected === d.name
                  ? "text-accent bg-accent/[0.08]"
                  : "text-ink3 hover:text-ink"
              }`}
            >
              {d.name}
              {d.annotations?.readOnlyHint && (
                <span className="text-ink3/70 text-[9px]"> ro</span>
              )}
            </button>
          ))}
        </div>

        <div className="w-64 border-r border-hair p-2.5 overflow-y-auto shrink-0">
          {descriptor ? (
            <>
              <div className="text-[10px] uppercase tracking-wider text-ink3 mb-1">
                schema
              </div>
              <pre className="text-[10.5px] text-ink whitespace-pre-wrap mb-2">
                {schemaSummary(descriptor)}
              </pre>
              <textarea
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                spellCheck={false}
                rows={6}
                className="w-full bg-canvas border border-hair rounded px-2 py-1.5 text-[10.5px] text-ink focus:outline-none focus:border-hair2 resize-none"
              />
              <button
                onClick={execute}
                disabled={busy}
                className="mt-2 px-3 py-1 text-[11px] rounded bg-accent text-canvas hover:bg-accent disabled:opacity-40"
              >
                {busy ? "running..." : "execute"}
              </button>
            </>
          ) : (
            <div className="text-[11px] text-ink3 leading-relaxed">
              Pick a tool. The list rebuilds itself whenever the workspace changes -
              load a dataset and watch it grow.
            </div>
          )}
        </div>

        <div className="flex-1 p-2.5 overflow-y-auto min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-ink3 mb-1">
            result (exactly what the agent would receive)
          </div>
          <pre className="text-[10.5px] text-ink whitespace-pre-wrap break-words">
            {output || "-"}
          </pre>
        </div>
      </div>
    </div>
  );
}
