/**
 * Small dense linear algebra.
 *
 * The least-squares solve uses Householder QR, not the normal-equations
 * inverse. With collinear factor columns (which is the normal case for
 * equity factor regressions) forming X'X squares the condition number and
 * the loss of precision is visible in the third significant figure of the
 * standard errors. QR costs twice the flops and does not have that problem.
 */

export type Matrix = number[][];

export function zeros(rows: number, cols: number): Matrix {
  return Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
}

export function identity(n: number): Matrix {
  const I = zeros(n, n);
  for (let i = 0; i < n; i++) I[i][i] = 1;
  return I;
}

export function transpose(A: Matrix): Matrix {
  const rows = A.length;
  const cols = rows === 0 ? 0 : A[0].length;
  const T = zeros(cols, rows);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) T[j][i] = A[i][j];
  }
  return T;
}

export function matmul(A: Matrix, B: Matrix): Matrix {
  const n = A.length;
  const k = B.length;
  const m = k === 0 ? 0 : B[0].length;
  if (n > 0 && A[0].length !== k) {
    throw new Error(`matmul shape mismatch: ${n}x${A[0].length} * ${k}x${m}`);
  }
  const C = zeros(n, m);
  for (let i = 0; i < n; i++) {
    const Ai = A[i];
    const Ci = C[i];
    for (let p = 0; p < k; p++) {
      const a = Ai[p];
      if (a === 0) continue;
      const Bp = B[p];
      for (let j = 0; j < m; j++) Ci[j] += a * Bp[j];
    }
  }
  return C;
}

export function matVec(A: Matrix, v: number[]): number[] {
  return A.map((row) => {
    let s = 0;
    for (let j = 0; j < row.length; j++) s += row[j] * v[j];
    return s;
  });
}

/** Outer product v w' scaled by `scale`, accumulated into `target` in place. */
export function accumulateOuter(
  target: Matrix,
  v: number[],
  w: number[],
  scale: number,
): void {
  const k = v.length;
  for (let i = 0; i < k; i++) {
    const vi = v[i] * scale;
    if (vi === 0) continue;
    const ti = target[i];
    for (let j = 0; j < k; j++) ti[j] += vi * w[j];
  }
}

export interface QRResult {
  /** k x k upper-triangular factor. */
  R: Matrix;
  /** First k entries of Q'b. */
  qtb: number[];
  /** Sum of squares of the discarded tail of Q'b, i.e. the residual SS. */
  residualSS: number;
  /** False when a pivot collapsed: the design matrix is rank deficient. */
  fullRank: boolean;
  /** min|diag(R)| / max|diag(R)|; small values mean near-collinearity. */
  conditionRatio: number;
}

/**
 * Householder QR of A (n x k, n >= k), applying the same reflections to b.
 * A and b are not mutated.
 */
export function householderQR(A: Matrix, b: number[]): QRResult {
  const n = A.length;
  if (n === 0) throw new Error("householderQR: empty design matrix");
  const k = A[0].length;
  if (n < k) throw new Error(`householderQR: need n >= k, got n=${n} k=${k}`);
  if (b.length !== n) throw new Error("householderQR: b length must equal rows of A");

  // Working copies.
  const W: Matrix = A.map((row) => row.slice());
  const y = b.slice();

  const EPS = 1e-12;
  let fullRank = true;

  for (let j = 0; j < k; j++) {
    // Norm of the sub-column below and including the diagonal.
    let normx = 0;
    for (let i = j; i < n; i++) normx += W[i][j] * W[i][j];
    normx = Math.sqrt(normx);

    if (normx < EPS) {
      fullRank = false;
      continue;
    }

    // alpha carries the opposite sign to the pivot to avoid cancellation.
    const alpha = W[j][j] >= 0 ? -normx : normx;

    // Householder vector v = x - alpha*e1, stored over rows j..n-1.
    const v = new Array<number>(n - j);
    for (let i = j; i < n; i++) v[i - j] = W[i][j];
    v[0] -= alpha;

    let vnorm2 = 0;
    for (let i = 0; i < v.length; i++) vnorm2 += v[i] * v[i];
    if (vnorm2 < EPS * EPS) {
      fullRank = false;
      continue;
    }

    // Apply H = I - 2vv'/(v'v) to the remaining columns.
    for (let c = j; c < k; c++) {
      let dot = 0;
      for (let i = j; i < n; i++) dot += v[i - j] * W[i][c];
      const s = (2 * dot) / vnorm2;
      for (let i = j; i < n; i++) W[i][c] -= s * v[i - j];
    }

    // ... and to b.
    let dotb = 0;
    for (let i = j; i < n; i++) dotb += v[i - j] * y[i];
    const sb = (2 * dotb) / vnorm2;
    for (let i = j; i < n; i++) y[i] -= sb * v[i - j];

    // Restore the exact triangular structure the reflection produced.
    W[j][j] = alpha;
    for (let i = j + 1; i < n; i++) W[i][j] = 0;
  }

  const R = zeros(k, k);
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) R[i][j] = W[i][j];
  }

  const qtb = y.slice(0, k);
  let residualSS = 0;
  for (let i = k; i < n; i++) residualSS += y[i] * y[i];

  let minDiag = Infinity;
  let maxDiag = 0;
  for (let i = 0; i < k; i++) {
    const d = Math.abs(R[i][i]);
    if (d < minDiag) minDiag = d;
    if (d > maxDiag) maxDiag = d;
  }
  const conditionRatio = maxDiag === 0 ? 0 : minDiag / maxDiag;

  return { R, qtb, residualSS, fullRank, conditionRatio };
}

/** Solve Rx = y for upper-triangular R by back substitution. */
export function backSubstitute(R: Matrix, y: number[]): number[] {
  const k = R.length;
  const x = new Array<number>(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    let s = y[i];
    for (let j = i + 1; j < k; j++) s -= R[i][j] * x[j];
    x[i] = R[i][i] === 0 ? 0 : s / R[i][i];
  }
  return x;
}

/** Inverse of an upper-triangular matrix. */
export function invertUpperTriangular(R: Matrix): Matrix {
  const k = R.length;
  const Inv = zeros(k, k);
  for (let i = k - 1; i >= 0; i--) {
    if (R[i][i] === 0) throw new Error("invertUpperTriangular: singular R");
    Inv[i][i] = 1 / R[i][i];
    for (let j = i + 1; j < k; j++) {
      let s = 0;
      for (let p = i + 1; p <= j; p++) s += R[i][p] * Inv[p][j];
      Inv[i][j] = -s / R[i][i];
    }
  }
  return Inv;
}

/**
 * (X'X)^-1 from the QR factor, without ever forming X'X.
 * X'X = R'R, so (X'X)^-1 = R^-1 R^-T.
 */
export function xtxInverseFromR(R: Matrix): Matrix {
  const Rinv = invertUpperTriangular(R);
  return matmul(Rinv, transpose(Rinv));
}

/** Least-squares solution of Ax ~= b. */
export function qrSolve(A: Matrix, b: number[]): number[] {
  const { R, qtb } = householderQR(A, b);
  return backSubstitute(R, qtb);
}

/**
 * Cholesky factorisation A = L L^T for a symmetric positive definite A.
 * Returns null when A is not positive definite, which is the caller signal
 * that a Wald test is not identified.
 */
export function cholesky(A: Matrix): Matrix | null {
  const n = A.length;
  const L = zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let p = 0; p < j; p++) s -= L[i][p] * L[j][p];
      if (i === j) {
        if (s <= 0) return null;
        L[i][j] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return L;
}

/** Inverse of a symmetric positive definite matrix, via Cholesky. */
export function invertSymmetric(A: Matrix): Matrix | null {
  const L = cholesky(A);
  if (!L) return null;
  const n = A.length;

  // Invert the lower-triangular factor.
  const Linv = zeros(n, n);
  for (let i = 0; i < n; i++) {
    Linv[i][i] = 1 / L[i][i];
    for (let j = 0; j < i; j++) {
      let s = 0;
      for (let p = j; p < i; p++) s += L[i][p] * Linv[p][j];
      Linv[i][j] = -s / L[i][i];
    }
  }

  // A inverse = L^-T L^-1
  const Ainv = zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let p = Math.max(i, j); p < n; p++) s += Linv[p][i] * Linv[p][j];
      Ainv[i][j] = s;
    }
  }
  return Ainv;
}

/** Quadratic form v^T A v. */
export function quadraticForm(v: number[], A: Matrix): number {
  let total = 0;
  for (let i = 0; i < v.length; i++) {
    let inner = 0;
    for (let j = 0; j < v.length; j++) inner += A[i][j] * v[j];
    total += v[i] * inner;
  }
  return total;
}

/** Extract the submatrix at the given row/column indices. */
export function submatrix(A: Matrix, rows: number[], cols: number[]): Matrix {
  return rows.map((i) => cols.map((j) => A[i][j]));
}

/**
 * Collinearity diagnostic: min/max of |diag(R)| after scaling every column to
 * unit length. Roughly the reciprocal of the condition number of the design.
 *
 * The scaling is the whole point. The raw diagonal of R depends on the units of
 * each column, so a design holding a price near 100 alongside a return near
 * 0.01 looks catastrophically ill-conditioned when nothing is wrong with it.
 * Normalising first makes this a statement about the angles between the
 * columns, which is what collinearity actually is. This is the Belsley-Kuh-
 * Welsch construction.
 *
 * Returns 0 for an exactly degenerate design.
 */
export function collinearityRatio(X: Matrix): number {
  const n = X.length;
  if (n === 0) return 0;
  const k = X[0].length;

  const scaled: Matrix = Array.from({ length: n }, () => new Array<number>(k).fill(0));
  for (let j = 0; j < k; j++) {
    let norm = 0;
    for (let i = 0; i < n; i++) norm += X[i][j] * X[i][j];
    norm = Math.sqrt(norm);
    if (norm === 0) return 0;
    for (let i = 0; i < n; i++) scaled[i][j] = X[i][j] / norm;
  }

  const { R } = householderQR(scaled, new Array<number>(n).fill(0));
  let minDiag = Infinity;
  let maxDiag = 0;
  for (let i = 0; i < k; i++) {
    const d = Math.abs(R[i][i]);
    if (d < minDiag) minDiag = d;
    if (d > maxDiag) maxDiag = d;
  }
  return maxDiag === 0 ? 0 : minDiag / maxDiag;
}
