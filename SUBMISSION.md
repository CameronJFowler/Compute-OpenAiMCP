# Compute — OpenAI WebMCP Hackathon

**Live demo:** https://computeopenai.netlify.app/  
**Repo:** https://github.com/CameronJFowler/Compute-OpenAiMCP  
**Tagline:** A research bench where you can check the agent's work — live in the browser, no backend needed.

---

## What it is

Compute is a browser-only statistical research bench. An AI agent and a human share one workspace: the same question, the same dataset, the same analysis. When the agent runs a regression, the numbers go to the agent and the chart renders on screen for the human. Every step is logged, and findings have to cite the step that produced them — the agent can't just make something up.

Everything runs in the browser via [WebMCP](https://github.com/webmachinelearning/webmcp). No server, no API key, no data leaves the page.

---

## Why WebMCP — and not a regular MCP server

Five things that only work because the tools live inside the page:

1. **Tool count changes as you work.** It starts at 4 (explore only) and climbs to 12 when a dataset loads, 13 when you create a signal column, 14 after a backtest runs. The schema for each tool is built from whatever columns actually exist in the loaded data — a static server manifest can't do that.

2. **Two audiences, one tool call.** The agent gets compact numbers (capped at 1,500 chars). The human gets a full chart. The same tool call, two different outputs, without anything bulky crossing into the model.

3. **One shared workspace.** The human can change the question or narrow the date range while the agent is mid-session. The next tool call reads the new values, because there's only one copy of everything.

4. **Approval before expensive operations.** Running a bootstrap with 2,000+ simulations shows a confirmation card first. The agent is paused until the human clicks approve.

5. **Citations are enforced.** `record_finding` checks every cited step number against the session log. The agent can't claim a result it didn't compute.

---

## Connecting ChatGPT

1. Open ChatGPT and start a new chat.
2. Paste **https://computeopenai.netlify.app/** into the chat — ChatGPT will open it in its browser.
3. Ask a plain research question in plain English. No need to name a tool or dataset.
4. Watch the **Agent** badge in the top right: it goes from 4 to 12 tools when data loads.
5. Results appear live as the agent works. You can edit the question or change the date window at any time — the agent picks it up on the next call.

---

## Momentum in US industry returns — does it survive?

One of the bundled datasets is 49 US industry portfolios, daily, 2015–2025. When you ask **"Does industry momentum survive out of sample and transaction costs?"**, the app automatically:

- Creates a 252-day (12-1) momentum signal on daily returns
- Runs a dollar-neutral backtest split 70/30 chronologically, with transaction costs on turnover
- Runs a Fama-French three-factor regression on returns
- Records a finding and builds a full research report

**The answer the app produces on the 2015–2025 data:**  
The momentum strategy **degrades** out of sample on this period — driven largely by the 2020 COVID momentum crash and the 2022 value/momentum rotation. In-sample Sharpe looks reasonable; out-of-sample it falls significantly. The three-factor regression shows strong market beta (~0.95) and positive loadings on SMB and HML, confirming these are small-cap, value-tilted portfolios rather than a clean momentum factor.

Try it yourself — the backtest chart, regression table, and full report are all generated live in the browser.

---

## Demo prompts for judges

Use a fresh page (click **↺ New** or reload) between prompts so the significance counter resets.

### Finance — momentum
> Does industry momentum survive out of sample and transaction costs?

The app loads the 49-industry daily panel, creates a 252-day momentum signal, runs the backtest, and fits a three-factor regression. The finding states plainly whether momentum survives, with actual CAGR and Sharpe numbers for both periods.

### Biology — species comparison  
> Do Adelie and Gentoo penguins differ in body mass?

Loads the Palmer Penguins dataset, runs an ANOVA comparing body mass across species, then fits a regression on morphological predictors. The conclusion states whether the groups differ and whether the result survives the session-adjusted threshold.

### Climate — explained variance
> How much of global warming since 1880 is explained by CO2?

Loads the annual climate series, fits a regression of temperature anomaly on CO2 concentration. The R² tells you how much variance CO2 explains; the coefficient gives the marginal warming per ppm.

### Astronomy — recovering the Hubble constant
> Fit Hubble's 1929 data and recover the Hubble constant.

24 galaxies, a simple regression of recession velocity on distance. The slope (~450 km/s/Mpc) is Hubble's original estimate — off from the modern ~70 because his distances were calibrated on the wrong Cepheid period-luminosity relation.

---

## Technical notes

- All five datasets are committed as static CSV files. Zero network requests at runtime.
- Stats engine cross-checked against SciPy/NumPy reference implementations (Newey-West HAC, Householder QR, Benjamini-Hochberg FDR).
- The significance threshold tightens in real time as tests accumulate — the agent sees the updated threshold in every result.
- `record_finding` verifies citations against the session log. A finding that cites a step that didn't run is refused.

---

## Submission checklist

- [x] Public repo with MIT licence: https://github.com/CameronJFowler/Compute-OpenAiMCP
- [x] Live public URL: https://computeopenai.netlify.app/
- [x] Working build (`npm run build`, `npm test`)
- [x] WebMCP tool registry — schemas generated from live page state
- [x] Five datasets across four domains
- [x] Dynamic tool surface (4 → 12 → 13 → 14 tools)
- [x] Split results: agent gets numbers, human gets charts
- [x] Shared mutable state — one workspace for both
- [x] Human-in-the-loop approval gates
- [x] Provenance: every step logged, findings must cite source
- [x] Auto-analysis pipeline — runs momentum backtest + factor regression automatically
- [x] Auto-report — `build_report` called at end of pipeline with a real conclusion
- [x] Help page with connection instructions (? button in footer)
- [ ] **Demo video (sub 3 minutes, with audio) — record and link here**

---

## GitHub repo description to set manually

Go to **Settings** on the repo and paste this into the About/Description field:

> A research bench where AI agents and humans share one live workspace. Browser-only, no backend — powered by WebMCP.
