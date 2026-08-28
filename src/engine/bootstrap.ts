/**
 * Stationary block bootstrap (Politis and Romano, 1994).
 *
 * A single Sharpe ratio from a single backtest is one draw from a distribution
 * nobody has looked at. Resampling in blocks of geometrically distributed
 * length preserves the short-run autocorrelation of the return series, which
 * an iid bootstrap destroys - and it is exactly that autocorrelation that makes
 * a strategy look better or worse than it is.
 *
 * The wrap-around at the end of the series is what makes the resampled series
 * stationary, and is the point of the method rather than a shortcut.
 */

import { annualisedSharpe, quantile } from "./stats";

export interface BootstrapParams {
  nSimulations: number;
  blockLengthDays: number;
  seed?: number;
}

export interface BootstrapResult {
  nSimulations: number;
  blockLengthDays: number;
  observedSharpe: number;
  observedTerminalWealth: number;
  sharpePercentiles: Record<string, number>;
  terminalWealthPercentiles: Record<string, number>;
  /** Share of simulated paths whose Sharpe is at or below zero. */
  fractionNonPositiveSharpe: number;
  /** Share of simulated paths that lost money outright. */
  fractionLosingMoney: number;
  sharpeSamples: number[];
  histogram: { binStart: number; binEnd: number; count: number }[];
}

/** Deterministic PRNG so a reported distribution can be reproduced exactly. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

export const sharpeOf = annualisedSharpe;

export function terminalWealthOf(returns: number[]): number {
  let wealth = 1;
  for (const r of returns) wealth *= 1 + r;
  return wealth;
}

/**
 * One stationary-bootstrap resample.
 *
 * At each step, continue the current block with probability 1 - 1/L, or start a
 * new block at a uniformly random position. That gives geometric block lengths
 * with mean L without ever having to draw a length up front.
 */
export function resample(series: number[], blockLength: number, rng: () => number): number[] {
  const n = series.length;
  const continueProbability = 1 - 1 / blockLength;
  const out = new Array<number>(n);

  let index = Math.floor(rng() * n);
  for (let t = 0; t < n; t++) {
    if (t > 0) {
      if (rng() < continueProbability) {
        index = (index + 1) % n; // wrap-around keeps the series stationary
      } else {
        index = Math.floor(rng() * n);
      }
    }
    out[t] = series[index];
  }
  return out;
}

function percentiles(values: number[]): Record<string, number> {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  return {
    p5: quantile(sorted, 0.05),
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p95: quantile(sorted, 0.95),
  };
}

function buildHistogram(
  values: number[],
  binCount = 40,
): { binStart: number; binEnd: number; count: number }[] {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return [];
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const width = (max - min) / binCount || 1;

  const bins = Array.from({ length: binCount }, (_, i) => ({
    binStart: min + i * width,
    binEnd: min + (i + 1) * width,
    count: 0,
  }));
  for (const v of finite) {
    const index = Math.min(binCount - 1, Math.max(0, Math.floor((v - min) / width)));
    bins[index].count++;
  }
  return bins;
}

/** One batch of paths, appended to the running samples. */
function simulateInto(
  series: number[],
  blockLength: number,
  rng: () => number,
  count: number,
  sharpeSamples: number[],
  wealthSamples: number[],
): void {
  for (let i = 0; i < count; i++) {
    const path = resample(series, blockLength, rng);
    sharpeSamples.push(sharpeOf(path));
    wealthSamples.push(terminalWealthOf(path));
  }
}

function finalise(
  dailyReturns: number[],
  params: BootstrapParams,
  sharpeSamples: number[],
  wealthSamples: number[],
): BootstrapResult {
  const { nSimulations, blockLengthDays } = params;
  const finiteSharpes = sharpeSamples.filter(Number.isFinite);

  return {
    nSimulations,
    blockLengthDays,
    observedSharpe: sharpeOf(dailyReturns),
    observedTerminalWealth: terminalWealthOf(dailyReturns),
    sharpePercentiles: percentiles(sharpeSamples),
    terminalWealthPercentiles: percentiles(wealthSamples),
    fractionNonPositiveSharpe:
      finiteSharpes.length === 0
        ? NaN
        : finiteSharpes.filter((s) => s <= 0).length / finiteSharpes.length,
    fractionLosingMoney:
      wealthSamples.length === 0
        ? NaN
        : wealthSamples.filter((w) => w < 1).length / wealthSamples.length,
    sharpeSamples,
    histogram: buildHistogram(sharpeSamples),
  };
}

export function bootstrapStrategy(
  dailyReturns: number[],
  params: BootstrapParams,
  onProgress?: (fraction: number) => void,
): BootstrapResult {
  const { nSimulations, blockLengthDays, seed = 20260828 } = params;
  const rng = makeRng(seed);
  const sharpeSamples: number[] = [];
  const wealthSamples: number[] = [];
  const reportEvery = Math.max(1, Math.floor(nSimulations / 50));

  if (onProgress) onProgress(0);
  for (let i = 0; i < nSimulations; i++) {
    simulateInto(dailyReturns, blockLengthDays, rng, 1, sharpeSamples, wealthSamples);
    if (onProgress && i % reportEvery === 0) onProgress(i / nSimulations);
  }
  if (onProgress) onProgress(1);

  return finalise(dailyReturns, params, sharpeSamples, wealthSamples);
}

/**
 * The same computation, in chunks, yielding to the event loop between them.
 *
 * There is no Web Worker here on purpose. The work is a few seconds at the very
 * top of the allowed simulation count, and a worker would buy a message
 * protocol, a build target and a serialisation boundary in exchange for
 * something no one watching can see. Yielding every chunk keeps the progress
 * bar moving and the approval card responsive, which is the entire requirement.
 */
export async function bootstrapStrategyAsync(
  dailyReturns: number[],
  params: BootstrapParams,
  onProgress?: (fraction: number) => void,
  chunkSize = 100,
): Promise<BootstrapResult> {
  const { nSimulations, blockLengthDays, seed = 20260828 } = params;
  const rng = makeRng(seed);
  const sharpeSamples: number[] = [];
  const wealthSamples: number[] = [];

  if (onProgress) onProgress(0);
  let done = 0;
  while (done < nSimulations) {
    const batch = Math.min(chunkSize, nSimulations - done);
    simulateInto(dailyReturns, blockLengthDays, rng, batch, sharpeSamples, wealthSamples);
    done += batch;
    if (onProgress) onProgress(done / nSimulations);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return finalise(dailyReturns, params, sharpeSamples, wealthSamples);
}
