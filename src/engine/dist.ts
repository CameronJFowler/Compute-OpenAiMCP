/**
 * Statistical distribution functions.
 *
 * No numerical dependencies. Everything is built from two special functions:
 * the regularized incomplete beta I_x(a,b) (Lentz continued fraction) and the
 * regularized incomplete gamma P(s,x) (series / continued fraction). The t, F,
 * chi-square and normal CDFs are all thin wrappers over those two.
 *
 * Accuracy target is ~1e-12 relative, comfortably inside anything a p-value is
 * ever reported to. Fixtures in tests/dist.test.ts come from SciPy.
 */

const EPS = 3e-16;
const TINY = 1e-300;
const MAX_ITER = 300;

/** Lanczos approximation to log(Gamma(x)). */
export function logGamma(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection formula: Gamma(x)Gamma(1-x) = pi / sin(pi x)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  const t = z + g + 0.5;
  let a = c[0];
  for (let i = 1; i < g + 2; i++) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

export function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/**
 * Continued fraction for the incomplete beta, evaluated with the modified
 * Lentz algorithm. It converges quickly only for x < (a+1)/(a+b+2); the caller
 * uses the symmetry relation outside that range.
 */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;

    // Even step.
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;

    // Odd step.
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;

    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (Number.isNaN(x) || Number.isNaN(a) || Number.isNaN(b)) return NaN;
  if (a <= 0 || b <= 0) return NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  if (x < (a + 1) / (a + b + 2)) {
    const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b));
    return (front * betaContinuedFraction(x, a, b)) / a;
  }
  const mirrored = Math.exp(b * Math.log(1 - x) + a * Math.log(x) - logBeta(b, a));
  return 1 - (mirrored * betaContinuedFraction(1 - x, b, a)) / b;
}

/** Lower regularized incomplete gamma P(s, x) by series expansion. */
function gammaPSeries(s: number, x: number): number {
  let sum = 1 / s;
  let term = sum;
  for (let n = 1; n <= MAX_ITER; n++) {
    term *= x / (s + n);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + s * Math.log(x) - logGamma(s));
}

/** Upper regularized incomplete gamma Q(s, x) by continued fraction. */
function gammaQContinuedFraction(s: number, x: number): number {
  let b = x + 1 - s;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= MAX_ITER; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h * Math.exp(-x + s * Math.log(x) - logGamma(s));
}

/** Lower regularized incomplete gamma P(s, x). */
export function regularizedGammaP(s: number, x: number): number {
  if (x < 0 || s <= 0) return NaN;
  if (x === 0) return 0;
  if (x < s + 1) return gammaPSeries(s, x);
  return 1 - gammaQContinuedFraction(s, x);
}

/**
 * Upper regularized incomplete gamma Q(s, x), computed directly.
 *
 * Not `1 - P`. Once the lower tail rounds to 1 in double precision - which
 * happens as soon as the upper tail falls below about 1e-16 - the subtraction
 * returns exactly zero, and every strongly significant result reports p = 0.
 * That is not merely an ugly number: it throws away the difference between
 * p = 1e-20 and p = 1e-300, in a tool whose entire argument is about taking
 * p-values seriously.
 */
export function regularizedGammaQ(s: number, x: number): number {
  if (x < 0 || s <= 0) return NaN;
  if (x === 0) return 1;
  // The continued fraction converges on the upper tail, which is the branch
  // that matters; the series side is where the tail is large and cancellation
  // is harmless.
  if (x < s + 1) return 1 - gammaPSeries(s, x);
  return gammaQContinuedFraction(s, x);
}

/**
 * Error function. Built on the incomplete gamma rather than the
 * Abramowitz-Stegun rational approximation: same code path already present,
 * about seven more correct digits.
 */
export function erf(x: number): number {
  if (x === 0) return 0;
  const p = regularizedGammaP(0.5, x * x);
  return x > 0 ? p : -p;
}

export function normalCdf(x: number, mean = 0, sd = 1): number {
  const z = (x - mean) / sd;
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export function normalPdf(x: number, mean = 0, sd = 1): number {
  const z = (x - mean) / sd;
  return Math.exp(-0.5 * z * z) / (sd * Math.sqrt(2 * Math.PI));
}

/**
 * Inverse standard normal CDF. Acklam rational approximation followed by one
 * Halley refinement against normalCdf, which takes it to full double precision.
 */
export function normalInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];

  const pLow = 0.02425;
  let x: number;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/** Student t CDF with `df` degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
  if (df <= 0) return NaN;
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  const x = df / (df + t * t);
  const half = 0.5 * regularizedIncompleteBeta(x, df / 2, 0.5);
  return t > 0 ? 1 - half : half;
}

/** Two-sided p-value for a t statistic. */
export function studentTTwoSidedP(t: number, df: number): number {
  if (df <= 0) return NaN;
  if (!Number.isFinite(t)) return 0;
  const x = df / (df + t * t);
  return regularizedIncompleteBeta(x, df / 2, 0.5);
}

/** F CDF with d1 numerator and d2 denominator degrees of freedom. */
export function fCdf(f: number, d1: number, d2: number): number {
  if (d1 <= 0 || d2 <= 0) return NaN;
  if (f <= 0) return 0;
  const x = (d1 * f) / (d1 * f + d2);
  return regularizedIncompleteBeta(x, d1 / 2, d2 / 2);
}

/** Upper-tail p-value for an F statistic. */
export function fUpperTailP(f: number, d1: number, d2: number): number {
  if (d1 <= 0 || d2 <= 0) return NaN;
  if (f <= 0) return 1;
  /**
   * The complement by symmetry, not by subtraction.
   *
   * I_x(a,b) = 1 - I_{1-x}(b,a), so with x = d1·f / (d1·f + d2) the upper tail
   * is I_{d2/(d1·f + d2)}(d2/2, d1/2) evaluated directly. `1 - fCdf` collapses
   * to exactly zero for any strongly significant F, which is how a one-way
   * ANOVA across three penguin species came to report p = 0.00.
   */
  return regularizedIncompleteBeta(d2 / (d1 * f + d2), d2 / 2, d1 / 2);
}

/** Chi-square CDF with k degrees of freedom. */
export function chi2Cdf(x: number, k: number): number {
  if (k <= 0) return NaN;
  if (x <= 0) return 0;
  return regularizedGammaP(k / 2, x / 2);
}

/** Upper-tail p-value for a chi-square statistic. */
export function chi2UpperTailP(x: number, k: number): number {
  if (k <= 0) return NaN;
  if (x <= 0) return 1;
  return regularizedGammaQ(k / 2, x / 2);
}
