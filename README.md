# Compute

**A research bench where you can check the agent's work.**

For setup, deployment, agent connection, and demo guidance, see the
[operator guide](docs/OPERATOR-GUIDE.md).

An agent can already run your analysis in seconds. The problem is that you cannot check it. The numbers arrive with no record of how they were produced, no account of how many things were tried before one of them worked, and no way to reproduce any of it. That is true today, for anyone who has let a model loose on a spreadsheet, and it gets worse as the models get faster.

Compute fixes that by construction rather than by discipline:

- **A finding must cite the step that produced it.** `record_finding` refuses a claim whose citation is not in the run log. An agent cannot assert a result it did not compute.
- **The significance threshold tightens as the session goes.** Every regression registers *every* slope as a test, not just the one you would report, and the adjusted threshold is returned inside the tool result — so the model has to reason about it too, not only the human.
- **Every call is on the record**, with its arguments and a digest, and the report is assembled from that log rather than from the model's memory of it.

It is a static page with no backend. Regression with autocorrelation-consistent standard errors, group comparisons, correlation, resampling and a look-ahead-free backtester all run in the browser in TypeScript. It exposes itself to an agent through [WebMCP](https://github.com/webmachinelearning/webmcp), and the whole design turns on one thing that only an in-page tool can do.

The same tools work across five bundled datasets in four fields — climate, biology, astronomy and finance. Nothing in the tool layer knows which one is loaded: the schemas are rebuilt from whatever the page is holding, so `hypothesis_test` offers to split penguins by species and doesn't offer to split a temperature series by anything, because there is nothing there to split by.

---

## Why this needs WebMCP and not an MCP server

The fair question about any WebMCP entry is: *why isn't this just a headless MCP server?* A tool that runs a regression over a bundled CSV does not need a browser.

Compute is built so that every tool is inseparable from the page.

### 1. The tool surface is generated from live page state

`registerTool` can be called at any time. When a dataset loads, Compute tears down the analysis tools and registers them again with **that dataset's actual column names baked into the `enum` of their `inputSchema`**.

The agent cannot pass an invalid column, because an invalid column is not expressible in the schema it was handed. Add a derived column with `add_feature` and the enums grow to include it, immediately, with nothing told to the agent. A static MCP manifest — fixed at connect time, before anyone knows which dataset is loaded — physically cannot do this.

You can watch it happen: the tool count goes **4 → 12** when a dataset loads, **→ 13** when a signal column is created, **→ 14** after a backtest exists.

| State | Tools |
|---|---|
| Nothing loaded | `list_datasets` `get_state` `load_dataset` `set_hypothesis` |
| Dataset loaded | `+ describe_dataset` `add_feature` `summary_stats` `correlate` `run_regression` `hypothesis_test` `record_finding` `build_report` |
| A causal derived signal exists | `+ run_backtest` |
| A backtest exists | `+ bootstrap_strategy` |

A tool that cannot succeed in the current state is not visible. `run_backtest` does not exist until there is something to sort on.

### 2. Split results: the number goes to the agent, the picture goes to the screen

A tool call returns at most 1,500 characters — coefficients, t-stats, a verdict. The same call pushes the full series into the workspace store and the chart redraws. One call, two audiences, and the large object never crosses the boundary to the model. Only an in-page tool can do both.

### 3. Shared mutable state — the human can grab the wheel mid-run

There is one `workspace` object. When the human drags the sample window, the agent's *next* tool call reads the new window, because it reads the same store. No second copy, no sync protocol. Both parties are operating one instrument.

### 4. Human-in-the-loop gates rendered in the page

A bootstrap above 2,000 simulations renders an approval card and the tool call `await`s a click. Overwriting an existing report does the same. From the agent's side the call simply takes longer.

### 5. Provenance and replay

Every tool call is appended to a run log with arguments, a result digest and a timestamp. `record_finding` **refuses a claim that does not cite a step that actually ran** — which makes fabrication structurally awkward rather than merely discouraged.

---

## The idea underneath it

An agent can test five hundred hypotheses a minute. A human cannot. Nothing in the current research stack keeps score.

Compute counts every hypothesis tested in the session and shows the multiple-comparison-adjusted threshold, live, in the header:

```
TESTED  7     ADJUSTED ALPHA  0.00714
● Latest result is not significant once adjusted
```

`run_regression` and `hypothesis_test` return this block in their payload, so **the agent has to confront it in its own reasoning**, not just the human. A regression registers *every* slope as a test, not just the one you would report — reporting the best of five coefficients as a single test is exactly the behaviour the counter exists to make visible.

Agent-driven research makes p-hacking effectively free. The environment is the only place the brake can live.

---

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:5180. Add `?dev=1` for the dev console, which lists every currently registered tool with its schema and lets you execute it with JSON arguments — no agent required. The tool list in that console rebuilds itself as the workspace changes, which is the most direct way to see the reactive registry working.

```bash
npm test          # 166 tests
npm run build     # typecheck + production build
```

## Deploying

The app is a static bundle with no backend, so anything that serves files works. It is deliberately not tied to one host.

**GitHub Pages** — no account beyond the one hosting this repo. [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) typechecks, runs the tests and publishes on every push to `main`. Enable it once under **Settings → Pages → Source: GitHub Actions**.

**Netlify, Vercel, Cloudflare Pages** — connect the repo and accept the detected settings. [`netlify.toml`](netlify.toml) is already correct (`npm run build`, publish `dist`).

The one thing that differs between them is the path the app is served from. A project site lives at `/<repo>/` rather than at the domain root, which breaks root-relative data paths. `vite.config.ts` reads `DEPLOY_BASE`, and [`assetUrl`](src/engine/loader.ts) resolves every bundled CSV against `import.meta.env.BASE_URL`, so both layouts work:

```bash
npm run build                              # served from /
DEPLOY_BASE=/Compute-OpenAiMCP/ npm run build   # served from /Compute-OpenAiMCP/
```

Verified under both.

## Connecting an agent

WebMCP needs a browser that implements it and a secure context (`localhost` counts, and so does any HTTPS deployment).

**The page tells you how.** Click the `Agent` chip in the header and it opens a panel with the steps, the URL ready to copy, and three example prompts. That panel is there because the most likely way this project fails in front of someone is that they open it in an ordinary browser, see `not attached`, and assume the agent side is aspirational.

**Two paths:**

1. **ChatGPT's in-app browser** — supports WebMCP directly. Paste the URL into a chat and open it. This is the path the challenge judges use.
2. **Chrome 149+** — open `chrome://flags`, search `webmcp`, enable it and restart. The flag is reported as both `#enable-webmcp-testing` and `#enable-webmcp-for-testing` depending on build. For a deployed page, an origin-trial token in the `<meta http-equiv="origin-trial">` tag in [`index.html`](index.html) removes the flag step entirely.

**What success looks like:** the header chip turns green and reads `Agent · connected`, and the capability count starts moving as the agent loads data. Then ask a question in plain language — you never name a tool. For example: *"Do Adelie and Gentoo penguins differ in body mass?"*

**How the connection actually works**, for anyone evaluating the implementation:

```ts
// src/webmcp/host.ts — resolve the host, preferring the canonical location
const host = document.modelContext ?? navigator.modelContext;

// One AbortController per tool. Aborting it is how a tool is removed;
// unregisterTool was dropped from the spec in April 2026.
const controller = new AbortController();
await host.registerTool(descriptor, { signal: controller.signal });
```

[`src/webmcp/registry.ts`](src/webmcp/registry.ts) then re-derives the whole tool set whenever the workspace changes, serialised on a promise chain so two updates cannot interleave — which matters because registering a name that already exists *rejects* rather than replacing it.

**No agent to hand?** Add `?dev=1` to the URL. That opens a console listing every registered tool with its schema, executable by hand with JSON arguments — the same tools an agent would call. The list rebuilds itself as the workspace changes, which is the most direct way to watch the registry work.

The page stays honest when no host is present: the chip says `not attached`, and the registry still publishes its intended tool list, so the capability count describes what this page offers rather than what one browser managed to accept.

### What the page shows, and what it doesn't

The interface is the researcher's, not the agent's. There is no tool inspector, no JSON call log, no debug surface in the default view — those belong to the machine and the machine already has them. What a human needs from an agent-operated bench is different: the question, the data, the window they control, the results, how many hypotheses have been tested, and an approval card when something expensive is about to happen.

The one agent-facing number that stays visible is the capability count in the header, because it changes underneath the operator — and because watching it go from 4 to 12 is the clearest possible evidence that the page rewrote the agent's tool list.

---

## Architecture

```
  ChatGPT / Chrome agent
          │  document.modelContext  (tool call)
          ▼
  ┌──────────────────────────────────────────────┐
  │  Compute page — static, no server            │
  │                                              │
  │   webmcp/registry.ts ──► workspace store     │
  │        │  (reactive)         (Zustand)       │
  │        │                       │             │
  │        │                       ├─► React UI  │
  │        │                       │   charts,   │
  │        ▼                       │   tables,   │
  │   webmcp/tools/*.ts            │   run log   │
  │        │                       │             │
  │        └─► engine/*.ts ────────┘             │
  │            OLS · HAC · distributions ·       │
  │            features · backtest · bootstrap   │
  └──────────────────────────────────────────────┘
                     │
           bundled CSVs in /public/data
```

Zustand rather than React context, deliberately: WebMCP tool functions are plain non-React code that must read and mutate React state from outside the component tree, and `useWorkspace.getState()` does that in one line.

Chart.js is bundled from npm, never a CDN. The page makes no third-party network requests at all.

### Layout

```
src/
  config.ts               APP_NAME, thresholds, the dataset manifest
  state/workspace.ts      the single source of truth
  state/runlog.ts         provenance
  webmcp/
    host.ts               entry-point shim + AbortSignal teardown
    result.ts             result/error adapters, 1500-char cap
    registry.ts           reactive register/unregister, serialized
    availability.ts       which tools exist right now
    schemas.ts            schema builders bound to live columns
    tools/                session · features · analysis · strategy · report
  engine/
    matrix.ts             Householder QR, Cholesky, collinearity diagnostic
    dist.ts               incomplete beta/gamma → t, F, chi², normal
    ols.ts                OLS + classical and Newey-West HAC
    stats.ts              moments, ACF, correlation, drawdown
    features.ts           causal transforms (+ one that is not, labelled)
    backtest.ts           cross-sectional long/short, no look-ahead
    bootstrap.ts          stationary block bootstrap
    multipletests.ts      session counter, Bonferroni, Benjamini-Hochberg
    frame.ts, loader.ts   the table model and CSV parsing
  ui/                     Brief · WorkspacePanel · ApprovalCard ·
                          ActivityLog · AgentStatus · Chart · DevConsole
```

---

## The statistics are tested, not asserted

`npm test` runs 166 tests. The numerical ones are checked against fixtures generated offline by SciPy and NumPy ([`scripts/make_fixtures.py`](scripts/make_fixtures.py)) and committed as JSON — nothing here is a value the implementation produced and was then blessed.

- **Distributions** match `scipy.stats` to 1e-11 relative. The t, F and χ² CDFs are built on a Lentz continued fraction for the regularized incomplete beta and a series/continued-fraction incomplete gamma.
- **OLS coefficients** are checked against `numpy.linalg.lstsq` (LAPACK SVD) — a genuinely different algorithm from the Householder QR under test. Standard errors, R², and the F statistics are checked against a NumPy reference implementation of the same estimators.
- **Newey-West** is verified to produce larger standard errors than classical ones under an AR(1) error of 0.85, which is the reason it is the default.
- **Causality** is a property test: every causal transform is recomputed on a frame truncated to an earlier end date, and every surviving value must be bit-identical. `forward_return` is asserted to *fail* that same test, which is how we know the test can fail.
- **Look-ahead** in the backtester is pinned from both sides. A signal equal to *tomorrow's* return must produce an absurd Sharpe ratio (> 8); a signal equal to *today's* return, knowable at formation time, must produce roughly nothing (< 2). If the alignment were off by one day in either direction, those two results would swap.
- **The registry** is exercised against a mock host implementing `index.bs` as written — `registerTool` returns a promise, duplicate names *reject* rather than replace, there is no `unregisterTool`, and teardown happens by aborting the signal. Concurrent syncs are asserted to serialize without duplicate rejections.
- **End to end**, against the real bundled CSVs, through the real tool surface: the full chain from `load_dataset` to `build_report`, the approval gate suspending and resuming a call, and an adversarial pass — misspelled columns, wrong types, calls made out of order, a forward-looking column used as a predictor.

### Declared deviations from the brief

- **Fourteen tools, not eleven.** The brief says eleven and then enumerates fourteen. Fourteen is what ships.
- **`hypothesis_test` offers four tests, not five**, but `two_sample_t` gained `group_column` / `group_a` / `group_b`, which the brief did not specify and which is what makes the tool work on any dataset with a factor. `f_test_joint` is absent because `run_regression` already returns the joint F on every call — with a HAC Wald statistic when Newey-West errors are selected, since the R²-based form is not valid there. A second entry point to the same test would be a way to run it without the multiple-testing counter noticing.
- **The equity panel is 49 industry portfolios, not 50 individual tickers.** Stooq now serves a bot-verification interstitial instead of CSV. See `SOURCES.md`.
- **No Web Worker.** The bootstrap chunks on the main thread and yields between batches, which keeps the progress bar and the approval card responsive without a message protocol.

### A note on the WebMCP spec

The spec moved twice in 2026 and much of the secondary documentation is stale. Per [`index.bs`](https://github.com/webmachinelearning/webmcp) on `main`:

- The entry point is **`document.modelContext`**. The getter moved from `Navigator` to `Document` in May 2026; `navigator.modelContext` survives as a deprecated alias.
- **There is no `unregisterTool`.** It was removed in April 2026 in favour of an `AbortSignal` passed as `registerTool(tool, { signal })`.
- Registering a name that already exists **rejects** rather than replacing it.

[`src/webmcp/host.ts`](src/webmcp/host.ts) resolves both spellings, prefers `AbortController` teardown, and falls back to `unregisterTool` for polyfills that still ship it. If the spec moves again, that is a one-file change.

---

## Data

Five datasets across four fields, bundled and committed — 1.5 MB total. No API key, no rate limit, nothing that can go down mid-judging. Full provenance and licence position in [`public/data/SOURCES.md`](public/data/SOURCES.md).

| File | Field | What | Source |
|---|---|---|---|
| `climate_annual.csv` | climate | Global temperature anomaly from two independent estimates, plus Mauna Loa CO₂, annual 1850–2026 | NOAA GCAG, NASA GISTEMP, NOAA GML (public domain) |
| `penguins.csv` | biology | 344 penguins, three species, four body measurements and three categorical groupings | Horst, Hill & Gorman (2020), CC0 |
| `hubble_1929.csv` | astronomy | 24 galaxies: distance (Mpc), radial velocity (km/s) | Hubble (1929), *PNAS* 15(3):168–173, Table 1 |
| `industries_daily.csv` | finance | 49 US industry portfolios, daily returns, 2015–2025 (135,534 rows) | Kenneth R. French Data Library |
| `ff_factors_daily.csv` | finance | Fama-French 3 factors + RF, daily | Kenneth R. French Data Library |

Three of these exist to prove the bench is not domain software wearing a general coat:

- **Penguins** is a plain cross-section with no time dimension at all. It is what forces `hypothesis_test` to take `group_column` / `group_a` / `group_b` and split one measurement by a factor, rather than only comparing two columns that happen to sit side by side. The categorical columns are detected by content, not by position.
- **Climate** joins two records that only partly overlap: CO₂ begins in 1959, temperature in 1850. A regression across them drops the non-overlapping years and reports how many, which is the honest behaviour worth showing. The two temperature estimates measure the same quantity by different methods, so a paired test between them is a real question.
- **Hubble** is the oldest generality check. The *same* `run_regression` fits `v = H₀·d` and recovers Hubble's original constant of about 450 km/s/Mpc — roughly seven times the modern value, because his distance ladder was wrong.

The factor file is joined onto the industry panel by date at load time, so a market-beta control is available without the agent aligning a second dataset by hand.

Regenerate with `python scripts/fetch_data.py`.

---

## Deliberately not built

No accounts, no auth, no live market APIs, no database, no chat UI inside the app — the agent is external, which is the entire point.

**And no arbitrary code execution.** There is no `eval`, no `execute_python`, no free-form query string. Bounded verbs only. An agent driving this page can fit a regression; it cannot run code.

---

## Licence

MIT. See [LICENSE](LICENSE).
