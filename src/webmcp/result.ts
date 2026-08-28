/**
 * Tool result and error adapters.
 *
 * Two jobs.
 *
 * First, shape. The spec types execute as `Promise<any>` and different hosts
 * have been observed wanting a bare string, an MCP-style content array, or a
 * plain object. We emit the MCP-canonical `{ content: [...] }` shape, which is
 * what the spec repo example itself returns, and carry the machine-readable
 * payload alongside in `structuredContent`. If a host turns out to want a bare
 * string, this is a one-function change.
 *
 * Second, size. Everything an agent reads costs tokens and attention, and the
 * whole point of an in-page tool is that the big object does not need to travel
 * - it goes to the chart instead. Text payloads are capped hard.
 */

export const MAX_RESULT_CHARS = 1500;

export interface ToolResultShape {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function clamp(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS - 80).trimEnd() +
    "\n[truncated - the full series is rendered in the workspace, not returned here]"
  );
}

export function toolResult(
  summary: string,
  structured?: Record<string, unknown>,
): ToolResultShape {
  const result: ToolResultShape = {
    content: [{ type: "text", text: clamp(summary) }],
  };
  if (structured) result.structuredContent = structured;
  return result;
}

/**
 * Errors are teaching material, not exceptions.
 *
 * A thrown error tells an agent only that something went wrong, and it will
 * usually respond by trying the same call again. A message that names the
 * problem, says what to do about it, and lists the legal values lets it
 * recover in a single turn. Nothing in the tool layer throws.
 */
export function toolError(
  message: string,
  hint: string,
  validValues?: unknown,
): ToolResultShape {
  let text = `ERROR: ${message}\nHINT: ${hint}`;
  if (validValues !== undefined) {
    text += `\nVALID VALUES: ${JSON.stringify(validValues)}`;
  }
  return {
    content: [{ type: "text", text: clamp(text) }],
    structuredContent: {
      ok: false,
      error: message,
      hint,
      ...(validValues !== undefined ? { valid: validValues } : {}),
    },
    isError: true,
  };
}

/** Appended to successful results so the agent always knows its legal moves. */
export function withNext(summary: string, nextTools: string[]): string {
  if (nextTools.length === 0) return summary;
  return `${summary}\nNEXT: ${nextTools.join(", ")}`;
}

/**
 * The compact state echo carried by every result. An agent that has drifted
 * out of sync with the page reads this and re-anchors without a round trip to
 * get_state.
 */
export interface StateEcho {
  dataset: string | null;
  n_rows: number;
  columns_n: number;
  tests_run: number;
  adjusted_alpha: number;
}

export function formatStateEcho(echo: StateEcho): string {
  return `STATE | dataset=${echo.dataset ?? "none"} rows=${echo.n_rows} columns=${echo.columns_n} tests_run=${echo.tests_run} adjusted_alpha=${echo.adjusted_alpha.toPrecision(3)}`;
}
