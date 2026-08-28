import { describe, expect, it } from "vitest";

import {
  formatMultipleTestingBlock,
  judge,
  summariseTests,
} from "../src/engine/multipletests";

describe("summariseTests", () => {
  it("is the naive threshold when nothing has been tested", () => {
    const s = summariseTests([]);
    expect(s.testsRun).toBe(0);
    expect(s.bonferroniAlpha).toBe(0.05);
  });

  it("divides alpha by the number of tests for Bonferroni", () => {
    const s = summariseTests([0.01, 0.2, 0.4, 0.03, 0.5, 0.6, 0.7]);
    expect(s.testsRun).toBe(7);
    expect(s.bonferroniAlpha).toBeCloseTo(0.05 / 7, 12);
    // The worked example from the brief.
    expect(s.bonferroniAlpha).toBeCloseTo(0.0071, 4);
  });

  it("ignores non-finite p-values in the count", () => {
    const s = summariseTests([0.01, NaN, 0.2]);
    expect(s.testsRun).toBe(2);
  });

  /**
   * The published worked example from Benjamini and Hochberg (1995), which
   * rejects four of the fifteen hypotheses at alpha = 0.05.
   */
  it("reproduces the Benjamini-Hochberg 1995 example", () => {
    const pValues = [
      0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459,
      0.324, 0.4262, 0.5719, 0.6528, 0.759, 1.0,
    ];
    const s = summariseTests(pValues);
    expect(s.testsRun).toBe(15);
    expect(s.benjaminiHochbergDiscoveries).toBe(4);
    expect(s.benjaminiHochbergThreshold).toBeCloseTo(0.0095, 12);
    expect(s.bonferroniAlpha).toBeCloseTo(0.05 / 15, 12);
  });

  it("declares nothing when no p-value clears the smallest BH step", () => {
    const s = summariseTests([0.4, 0.5, 0.6]);
    expect(s.benjaminiHochbergDiscoveries).toBe(0);
    expect(s.benjaminiHochbergThreshold).toBe(0);
  });

  it("is order independent", () => {
    const a = summariseTests([0.04, 0.001, 0.3]);
    const b = summariseTests([0.3, 0.04, 0.001]);
    expect(a.benjaminiHochbergThreshold).toBe(b.benjaminiHochbergThreshold);
    expect(a.benjaminiHochbergDiscoveries).toBe(b.benjaminiHochbergDiscoveries);
  });
});

describe("judge", () => {
  /**
   * The case the whole tracker exists for: a p-value that reads as a discovery
   * on its own and does not survive the session it was actually found in.
   */
  it("flags a result that is significant only before adjustment", () => {
    const summary = summariseTests([0.6, 0.5, 0.44, 0.31, 0.2, 0.12, 0.031]);
    const verdict = judge(0.031, summary);
    expect(verdict.naive).toBe("significant");
    expect(verdict.bonferroni).toBe("not_significant");
    expect(verdict.disagrees).toBe(true);
    expect(verdict.survivesAdjustment).toBe(false);
  });

  it("passes a result that survives adjustment", () => {
    const summary = summariseTests([0.0001, 0.4, 0.5]);
    const verdict = judge(0.0001, summary);
    expect(verdict.naive).toBe("significant");
    expect(verdict.bonferroni).toBe("significant");
    expect(verdict.disagrees).toBe(false);
  });

  it("reports undefined for a p-value that could not be computed", () => {
    const verdict = judge(NaN, summariseTests([0.1]));
    expect(verdict.naive).toBe("undefined");
  });
});

describe("formatMultipleTestingBlock", () => {
  it("stays compact enough to sit inside every test result", () => {
    const summary = summariseTests(Array.from({ length: 40 }, (_, i) => (i + 1) / 100));
    const block = formatMultipleTestingBlock(0.02, summary);
    expect(block.length).toBeLessThan(600);
    expect(block).toContain("tests this session: 40");
  });

  it("carries an explicit warning when the verdicts disagree", () => {
    const summary = summariseTests([0.6, 0.5, 0.44, 0.31, 0.2, 0.12, 0.031]);
    const block = formatMultipleTestingBlock(0.031, summary);
    expect(block).toContain("WARNING");
    expect(block).toContain("7 tests");
  });

  it("omits the warning when there is nothing to warn about", () => {
    const block = formatMultipleTestingBlock(0.0001, summariseTests([0.0001]));
    expect(block).not.toContain("WARNING");
  });
});
