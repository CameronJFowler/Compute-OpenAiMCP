"""
Generate test fixtures for the TypeScript statistics engine.

Run once, offline, and commit the JSON. The TypeScript tests never call Python;
they assert against the numbers this produced.

Two independent references are used:

  * scipy.stats for every distribution function, which is the authority
  * numpy.linalg.lstsq (LAPACK) for the OLS coefficients, which is a genuinely
    different code path from the hand-written Householder QR being tested

The Newey-West covariance is computed here from the estimator definition using
numpy. That shares the formula with the TypeScript implementation but not the
code, so it catches indexing, weighting and sandwich-assembly mistakes - which
is where HAC implementations actually go wrong.

Usage:  python scripts/make_fixtures.py
"""

import json
import os

import numpy as np
from scipy import stats

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "tests", "fixtures")


def distribution_fixtures():
    t_cases = [(2.0, 10), (-2.0, 10), (0.5, 3), (3.5, 250), (1.6449, 1000), (0.0, 7)]
    f_cases = [(3.0, 5, 20), (1.0, 1, 1), (0.5, 4, 60), (7.2, 3, 100)]
    chi2_cases = [(3.84, 1), (10.0, 5), (0.5, 2), (25.0, 20)]
    norm_cases = [-3.0, -1.96, -0.5, 0.0, 0.5, 1.96, 2.5758, 4.0]
    beta_cases = [
        (0.5, 2.0, 3.0),
        (0.1, 0.5, 0.5),
        (0.9, 5.0, 2.0),
        (0.25, 10.0, 20.0),
        (0.75, 0.5, 40.0),
    ]
    gamma_cases = [(0.5, 1.0), (3.0, 2.5), (10.0, 12.0), (0.5, 0.25)]

    return {
        "student_t_cdf": [
            {"t": t, "df": df, "expected": float(stats.t.cdf(t, df))} for t, df in t_cases
        ],
        "student_t_two_sided_p": [
            {"t": t, "df": df, "expected": float(2 * stats.t.sf(abs(t), df))}
            for t, df in t_cases
        ],
        "f_cdf": [
            {"f": f, "d1": d1, "d2": d2, "expected": float(stats.f.cdf(f, d1, d2))}
            for f, d1, d2 in f_cases
        ],
        "chi2_cdf": [
            {"x": x, "k": k, "expected": float(stats.chi2.cdf(x, k))}
            for x, k in chi2_cases
        ],
        "normal_cdf": [
            {"x": x, "expected": float(stats.norm.cdf(x))} for x in norm_cases
        ],
        "normal_inv": [
            {"p": p, "expected": float(stats.norm.ppf(p))}
            for p in [0.001, 0.025, 0.25, 0.5, 0.75, 0.975, 0.999]
        ],
        "regularized_incomplete_beta": [
            {"x": x, "a": a, "b": b, "expected": float(stats.beta.cdf(x, a, b))}
            for x, a, b in beta_cases
        ],
        "regularized_gamma_p": [
            {"s": s, "x": x, "expected": float(stats.gamma.cdf(x, s))}
            for s, x in gamma_cases
        ],
        # Far tails. `1 - cdf` collapses to exactly zero here, which is how a
        # significant ANOVA came to report p = 0.00. These are the survival
        # functions, which scipy computes directly and so must we.
        "f_upper_tail": [
            {"f": f, "d1": d1, "d2": d2, "expected": float(stats.f.sf(f, d1, d2))}
            for f, d1, d2 in [
                (3.0, 5, 20), (10.0, 2, 50), (50.0, 2, 300),
                (200.0, 3, 340), (1000.0, 5, 100), (5000.0, 2, 341),
            ]
        ],
        "chi2_upper_tail": [
            {"x": x, "k": k, "expected": float(stats.chi2.sf(x, k))}
            for x, k in [
                (3.84, 1), (10.0, 5), (100.0, 1),
                (300.0, 2), (500.0, 10), (120.0, 4),
            ]
        ],
        "t_two_sided_far": [
            {"t": t, "df": df, "expected": float(2 * stats.t.sf(abs(t), df))}
            for t, df in [(10.0, 100), (20.0, 250), (35.0, 340), (60.0, 1000)]
        ],
    }


def newey_west_cov(X, resid, lags):
    """HAC sandwich, straight from the estimator definition."""
    n, k = X.shape
    S = np.zeros((k, k))
    for t in range(n):
        xt = X[t : t + 1].T
        S += (resid[t] ** 2) * (xt @ xt.T)
    for lag in range(1, lags + 1):
        w = 1.0 - lag / (lags + 1.0)
        if w <= 0:
            continue
        for t in range(lag, n):
            xt = X[t : t + 1].T
            xtl = X[t - lag : t - lag + 1].T
            cross = resid[t] * resid[t - lag] * (xt @ xtl.T + xtl @ xt.T)
            S += w * cross
    xtx_inv = np.linalg.inv(X.T @ X)
    return xtx_inv @ S @ xtx_inv


def default_nw_lags(n):
    return int(np.floor(4 * (n / 100.0) ** (2.0 / 9.0)))


def ols_reference(y, X_no_const, nw_lags=None):
    n = len(y)
    X = np.column_stack([np.ones(n), X_no_const])
    k = X.shape[1]

    beta, _, _, _ = np.linalg.lstsq(X, y, rcond=None)
    fitted = X @ beta
    resid = y - fitted
    df = n - k
    ss_resid = float(resid @ resid)
    ss_total = float(((y - y.mean()) ** 2).sum())
    sigma2 = ss_resid / df

    xtx_inv = np.linalg.inv(X.T @ X)
    cov_classical = sigma2 * xtx_inv

    lags = default_nw_lags(n) if nw_lags is None else nw_lags
    cov_hac = newey_west_cov(X, resid, lags)

    r2 = 1 - ss_resid / ss_total
    adj_r2 = 1 - (1 - r2) * (n - 1) / df

    se_classical = np.sqrt(np.diag(cov_classical))
    se_hac = np.sqrt(np.diag(cov_hac))
    t_classical = beta / se_classical
    t_hac = beta / se_hac

    q = k - 1
    f_classical = (r2 / q) / ((1 - r2) / df)

    slopes = beta[1:]
    cov_hac_slopes = cov_hac[1:, 1:]
    wald = float(slopes @ np.linalg.inv(cov_hac_slopes) @ slopes)
    f_hac = wald / q

    return {
        "n": int(n),
        "k": int(k),
        "df": int(df),
        "nw_lags": int(lags),
        "beta": [float(v) for v in beta],
        "se_classical": [float(v) for v in se_classical],
        "se_newey_west": [float(v) for v in se_hac],
        "t_classical": [float(v) for v in t_classical],
        "t_newey_west": [float(v) for v in t_hac],
        "p_classical": [float(2 * stats.t.sf(abs(v), df)) for v in t_classical],
        "p_newey_west": [float(2 * stats.t.sf(abs(v), df)) for v in t_hac],
        "r_squared": float(r2),
        "adjusted_r_squared": float(adj_r2),
        "f_classical": float(f_classical),
        "f_p_classical": float(stats.f.sf(f_classical, q, df)),
        "f_newey_west": float(f_hac),
        "f_p_newey_west": float(stats.f.sf(f_hac, q, df)),
        "residual_standard_error": float(np.sqrt(sigma2)),
    }


def ols_fixtures():
    rng = np.random.default_rng(20260828)
    cases = {}

    # 1. Clean, well conditioned, independent errors.
    n = 200
    x1 = rng.normal(size=n)
    x2 = rng.normal(size=n)
    y = 1.5 + 2.0 * x1 - 0.75 * x2 + rng.normal(scale=0.8, size=n)
    cases["clean_two_regressor"] = {
        "y": [float(v) for v in y],
        "X": [[float(a), float(b)] for a, b in zip(x1, x2)],
        "names": ["x1", "x2"],
        "reference": ols_reference(y, np.column_stack([x1, x2])),
    }

    # 2. Strongly autocorrelated errors: this is the case where classical
    #    standard errors lie and Newey-West has to visibly differ.
    n = 400
    x = rng.normal(size=n)
    eps = np.zeros(n)
    for t in range(1, n):
        eps[t] = 0.85 * eps[t - 1] + rng.normal(scale=0.5)
    y = 0.3 + 1.2 * x + eps
    cases["autocorrelated_errors"] = {
        "y": [float(v) for v in y],
        "X": [[float(v)] for v in x],
        "names": ["x"],
        "reference": ols_reference(y, x.reshape(-1, 1)),
        "reference_lag8": ols_reference(y, x.reshape(-1, 1), nw_lags=8),
    }

    # 3. Near-collinear regressors: the case that punishes normal equations.
    n = 150
    z1 = rng.normal(size=n)
    z2 = z1 + rng.normal(scale=1e-3, size=n)
    y = 2.0 + 0.5 * z1 + 0.5 * z2 + rng.normal(scale=0.3, size=n)
    cases["near_collinear"] = {
        "y": [float(v) for v in y],
        "X": [[float(a), float(b)] for a, b in zip(z1, z2)],
        "names": ["z1", "z2"],
        "reference": ols_reference(y, np.column_stack([z1, z2])),
    }

    # 4. Hubble 1929, the real thing. 24 galaxies, distance in Mpc against
    #    radial velocity in km/s. A simple regression whose slope is a physical
    #    constant, fitted by the same code that fits factor models.
    distance = np.array([
        0.032, 0.034, 0.214, 0.263, 0.275, 0.275, 0.45, 0.5, 0.5, 0.63,
        0.8, 0.9, 0.9, 0.9, 0.9, 1.0, 1.1, 1.1, 1.4, 1.7, 2.0, 2.0, 2.0, 2.0,
    ])
    velocity = np.array([
        170.0, 290.0, -130.0, -70.0, -185.0, -220.0, 200.0, 290.0, 270.0, 200.0,
        300.0, -30.0, 650.0, 150.0, 500.0, 920.0, 450.0, 500.0, 500.0, 960.0,
        500.0, 850.0, 800.0, 1090.0,
    ])
    cases["hubble_1929"] = {
        "y": [float(v) for v in velocity],
        "X": [[float(v)] for v in distance],
        "names": ["distance_mpc"],
        "reference": ols_reference(velocity, distance.reshape(-1, 1)),
    }

    return cases


def moment_fixtures():
    rng = np.random.default_rng(7)
    samples = {
        "normalish": rng.normal(loc=0.4, scale=2.0, size=300),
        "skewed": rng.gamma(shape=2.0, scale=1.5, size=250),
        "fat_tailed": rng.standard_t(df=4, size=400),
    }
    out = {}
    for name, values in samples.items():
        out[name] = {
            "values": [float(v) for v in values],
            "n": int(values.size),
            "mean": float(values.mean()),
            "sd": float(values.std(ddof=1)),
            "skewness": float(stats.skew(values, bias=True)),
            "excess_kurtosis": float(stats.kurtosis(values, fisher=True, bias=True)),
            "min": float(values.min()),
            "max": float(values.max()),
            "median": float(np.median(values)),
            "jarque_bera": float(stats.jarque_bera(values).statistic),
            "acf": {
                str(lag): float(
                    np.sum((values[lag:] - values.mean()) * (values[:-lag] - values.mean()))
                    / np.sum((values - values.mean()) ** 2)
                )
                for lag in (1, 5, 21)
            },
        }

    a = rng.normal(size=150)
    b = 0.6 * a + rng.normal(scale=0.8, size=150)
    out["correlation"] = {
        "a": [float(v) for v in a],
        "b": [float(v) for v in b],
        "pearson": float(stats.pearsonr(a, b).statistic),
        "spearman": float(stats.spearmanr(a, b).statistic),
    }
    return out


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    dist = distribution_fixtures()
    dist.pop("log_gamma", None)

    payload = {
        "generated_by": "scripts/make_fixtures.py",
        "numpy": np.__version__,
        "scipy": __import__("scipy").__version__,
        "distributions": dist,
        "ols": ols_fixtures(),
        "moments": moment_fixtures(),
    }

    path = os.path.join(OUT_DIR, "fixtures.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=1)
    print("wrote", os.path.normpath(path))
    print("  distribution cases:", sum(len(v) for v in dist.values()))
    print("  ols cases:", len(payload["ols"]))
    print("  moment cases:", len(payload["moments"]))


if __name__ == "__main__":
    main()
