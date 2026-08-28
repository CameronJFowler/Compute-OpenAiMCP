/**
 * Session-level multiple testing accounting.
 *
 * This is the part of the bench that exists because of agents specifically.
 * A human tests three hypotheses in an afternoon and remembers all three. An
 * agent tests forty in a minute and each one arrives looking like the first.
 * The nominal 0.05 threshold is a statement about a single pre-registered test,
 * and nothing in a normal analysis stack notices when that assumption stops
 * holding.
 *
 * So the session counts. Every regression and every hypothesis test adds its
 * p-value here, and the adjusted thresholds are returned inside the tool result
 * itself, which means the agent has to read them before it can report a
 * finding.
 */

export const DEFAULT_ALPHA = 0.05;

export interface RecordedTest {
  /** Run-log step that produced this p-value. */
  step: number;
  label: string;
  pValue: number;
  timestamp: number;
}

export interface MultipleTestingSummary {
  testsRun: number;
  naiveAlpha: number;
  /** alpha / m */
  bonferroniAlpha: number;
  /**
   * The largest p-value in the session that survives Benjamini-Hochberg at
   * this alpha. Zero when nothing survives. A p-value at or below this is
   * significant under BH control of the false discovery rate.
   */
  benjaminiHochbergThreshold: number;
  /** How many of the session p-values BH declares discoveries. */
  benjaminiHochbergDiscoveries: number;
  pValues: number[];
}

export function summariseTests(
  pValues: number[],
  alpha: number = DEFAULT_ALPHA,
): MultipleTestingSummary {
  const finite = pValues.filter((p) => Number.isFinite(p));
  const m = finite.length;

  if (m === 0) {
    return {
      testsRun: 0,
      naiveAlpha: alpha,
      bonferroniAlpha: alpha,
      benjaminiHochbergThreshold: alpha,
      benjaminiHochbergDiscoveries: 0,
      pValues: [],
    };
  }

  const sorted = [...finite].sort((a, b) => a - b);

  // BH: find the largest rank i where p_(i) <= (i/m) * alpha. Everything at or
  // below that p-value is a discovery.
  let largestPassingRank = 0;
  for (let i = 1; i <= m; i++) {
    if (sorted[i - 1] <= (i / m) * alpha) largestPassingRank = i;
  }

  return {
    testsRun: m,
    naiveAlpha: alpha,
    bonferroniAlpha: alpha / m,
    benjaminiHochbergThreshold:
      largestPassingRank === 0 ? 0 : sorted[largestPassingRank - 1],
    benjaminiHochbergDiscoveries: largestPassingRank,
    pValues: finite,
  };
}

export type Significance = "significant" | "not_significant" | "undefined";

export interface Verdict {
  naive: Significance;
  bonferroni: Significance;
  benjaminiHochberg: Significance;
  /** True when the naive and adjusted verdicts disagree. */
  survivesAdjustment: boolean;
  disagrees: boolean;
}

export function judge(pValue: number, summary: MultipleTestingSummary): Verdict {
  if (!Number.isFinite(pValue)) {
    return {
      naive: "undefined",
      bonferroni: "undefined",
      benjaminiHochberg: "undefined",
      survivesAdjustment: false,
      disagrees: false,
    };
  }
  const naive: Significance =
    pValue <= summary.naiveAlpha ? "significant" : "not_significant";
  const bonferroni: Significance =
    pValue <= summary.bonferroniAlpha ? "significant" : "not_significant";
  const bh: Significance =
    summary.benjaminiHochbergDiscoveries > 0 &&
    pValue <= summary.benjaminiHochbergThreshold
      ? "significant"
      : "not_significant";

  return {
    naive,
    bonferroni,
    benjaminiHochberg: bh,
    survivesAdjustment: bonferroni === "significant",
    disagrees: naive === "significant" && bonferroni !== "significant",
  };
}

function fmt(p: number): string {
  if (!Number.isFinite(p)) return "n/a";
  if (p === 0) return "0";
  if (p < 1e-4) return p.toExponential(2);
  return p.toFixed(4);
}

/**
 * The block appended to every regression and hypothesis test result.
 *
 * Kept to four short lines: it is included in every test-shaped tool result and
 * the whole payload is capped at about 1,500 characters.
 */
export function formatMultipleTestingBlock(
  pValue: number,
  summary: MultipleTestingSummary,
): string {
  const v = judge(pValue, summary);
  const lines = [
    `MULTIPLE TESTING | tests this session: ${summary.testsRun} | naive alpha ${summary.naiveAlpha} | Bonferroni alpha ${fmt(summary.bonferroniAlpha)}`,
    `This p = ${fmt(pValue)} -> naive: ${v.naive.toUpperCase()}, Bonferroni: ${v.bonferroni.toUpperCase()}, BH(FDR): ${v.benjaminiHochberg.toUpperCase()}`,
  ];
  if (v.disagrees) {
    lines.push(
      `WARNING: this result is significant only before adjusting for the ${summary.testsRun} tests already run in this session. Do not report it as a finding without saying so.`,
    );
  }
  return lines.join("\n");
}
