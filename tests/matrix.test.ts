import { describe, expect, it } from "vitest";

import {
  backSubstitute,
  cholesky,
  collinearityRatio,
  householderQR,
  identity,
  invertSymmetric,
  invertUpperTriangular,
  matmul,
  qrSolve,
  quadraticForm,
  transpose,
  xtxInverseFromR,
  type Matrix,
} from "../src/engine/matrix";

function expectMatrixClose(actual: Matrix, expected: Matrix, tolerance = 1e-10): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    for (let j = 0; j < actual[i].length; j++) {
      expect(Math.abs(actual[i][j] - expected[i][j])).toBeLessThan(tolerance);
    }
  }
}

/** Deterministic pseudo-random numbers, so failures reproduce exactly. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("basic operations", () => {
  it("transposes", () => {
    expect(transpose([[1, 2, 3], [4, 5, 6]])).toEqual([[1, 4], [2, 5], [3, 6]]);
  });

  it("multiplies", () => {
    expect(matmul([[1, 2], [3, 4]], [[5, 6], [7, 8]])).toEqual([[19, 22], [43, 50]]);
  });

  it("rejects a shape mismatch", () => {
    expect(() => matmul([[1, 2]], [[1, 2]])).toThrow(/shape mismatch/);
  });

  it("computes a quadratic form", () => {
    expect(quadraticForm([1, 2], [[2, 0], [0, 3]])).toBe(14);
  });
});

describe("householderQR", () => {
  it("produces an upper-triangular R whose Gram matrix is X transpose X", () => {
    const rng = makeRng(42);
    const n = 40;
    const k = 4;
    const X: Matrix = Array.from({ length: n }, () =>
      Array.from({ length: k }, () => rng() * 2 - 1),
    );
    const b = Array.from({ length: n }, () => rng());

    const { R } = householderQR(X, b);

    // R is upper triangular.
    for (let i = 1; i < k; i++) {
      for (let j = 0; j < i; j++) expect(R[i][j]).toBe(0);
    }
    // R transpose R equals X transpose X.
    expectMatrixClose(matmul(transpose(R), R), matmul(transpose(X), X), 1e-9);
  });

  it("solves a least-squares problem that has an exact answer", () => {
    const X: Matrix = [[1, 0], [1, 1], [1, 2], [1, 3]];
    const beta = [2, 3];
    const b = X.map((row) => row[0] * beta[0] + row[1] * beta[1]);
    const solved = qrSolve(X, b);
    expect(Math.abs(solved[0] - 2)).toBeLessThan(1e-12);
    expect(Math.abs(solved[1] - 3)).toBeLessThan(1e-12);
  });

  it("reports the residual sum of squares consistent with the solution", () => {
    const X: Matrix = [[1, 0], [1, 1], [1, 2], [1, 3]];
    const b = [1, 3, 2, 5];
    const { residualSS } = householderQR(X, b);
    const beta = qrSolve(X, b);
    let direct = 0;
    for (let i = 0; i < X.length; i++) {
      const fitted = X[i][0] * beta[0] + X[i][1] * beta[1];
      direct += (b[i] - fitted) ** 2;
    }
    expect(Math.abs(residualSS - direct)).toBeLessThan(1e-12);
  });

  it("refuses a design with fewer rows than columns", () => {
    expect(() => householderQR([[1, 2, 3]], [1])).toThrow(/n >= k/);
  });

  it("flags an exactly duplicated column as rank deficient", () => {
    const X: Matrix = [[1, 2, 2], [1, 3, 3], [1, 5, 5], [1, 7, 7]];
    const { fullRank } = householderQR(X, [1, 2, 3, 4]);
    expect(fullRank).toBe(false);
  });
});

describe("triangular and symmetric inverses", () => {
  it("inverts an upper-triangular matrix", () => {
    const R: Matrix = [[2, 1, 3], [0, 4, 1], [0, 0, 5]];
    expectMatrixClose(matmul(R, invertUpperTriangular(R)), identity(3));
  });

  it("recovers the inverse of X transpose X from R alone", () => {
    const X: Matrix = [[1, 0.5], [1, 1.5], [1, 2.5], [1, 4.0], [1, 5.5]];
    const { R } = householderQR(X, [0, 0, 0, 0, 0]);
    const fromR = xtxInverseFromR(R);
    const direct = invertSymmetric(matmul(transpose(X), X));
    expect(direct).not.toBeNull();
    expectMatrixClose(fromR, direct as Matrix, 1e-9);
  });

  it("factors and inverts a positive definite matrix", () => {
    const A: Matrix = [[4, 2, 1], [2, 5, 3], [1, 3, 6]];
    const L = cholesky(A);
    expect(L).not.toBeNull();
    expectMatrixClose(matmul(L as Matrix, transpose(L as Matrix)), A);
    expectMatrixClose(matmul(A, invertSymmetric(A) as Matrix), identity(3), 1e-9);
  });

  it("returns null for a matrix that is not positive definite", () => {
    expect(cholesky([[1, 2], [2, 1]])).toBeNull();
    expect(invertSymmetric([[0, 0], [0, 0]])).toBeNull();
  });
});

describe("backSubstitute", () => {
  it("solves an upper-triangular system", () => {
    const R: Matrix = [[2, 1], [0, 3]];
    const x = backSubstitute(R, [5, 9]);
    expect(Math.abs(x[1] - 3)).toBeLessThan(1e-12);
    expect(Math.abs(x[0] - 1)).toBeLessThan(1e-12);
  });
});

describe("collinearityRatio", () => {
  /**
   * The property that makes this diagnostic usable at all. A research bench
   * routinely regresses something on columns whose units differ by six orders
   * of magnitude - a price against a return - and a diagnostic that fired on
   * that would be noise. Collinearity is about angles, not scales.
   */
  it("is invariant to column scaling", () => {
    const X: Matrix = [[1, 0.5, 30], [1, 1.5, 42], [1, 2.5, 25], [1, 4.0, 61], [1, 5.5, 38]];
    const scaled: Matrix = X.map((row) => [row[0], row[1] * 1e6, row[2] * 1e-6]);
    const a = collinearityRatio(X);
    const b = collinearityRatio(scaled);
    expect(Math.abs(a - b)).toBeLessThan(1e-9);
    // An unremarkable design should not look ill conditioned.
    expect(a).toBeGreaterThan(1e-2);
  });

  it("returns zero for an exactly collinear design", () => {
    const X: Matrix = [[1, 2, 4], [1, 3, 6], [1, 5, 10], [1, 7, 14]];
    expect(collinearityRatio(X)).toBeLessThan(1e-12);
  });

  it("detects a nearly duplicated column", () => {
    const rng = makeRng(7);
    const n = 100;
    const X: Matrix = [];
    for (let i = 0; i < n; i++) {
      const z = rng() * 2 - 1;
      X.push([1, z, z + (rng() - 0.5) * 2e-3]);
    }
    const ratio = collinearityRatio(X);
    expect(ratio).toBeLessThan(1e-2);
    expect(ratio).toBeGreaterThan(0);
  });
});
