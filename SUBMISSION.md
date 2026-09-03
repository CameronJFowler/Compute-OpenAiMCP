# Compute — WebMCP Hackathon Submission

**Tagline:** A statistical research bench where AI agents and humans share one live workspace. Browser-only, no backend, powered by WebMCP.

**Live URL:** https://computeopenai.netlify.app/
**Repository:** https://github.com/CameronJFowler/Compute-OpenAiMCP

---

## What it does

Compute is a browser-based statistical research workbench that exposes a full analysis toolkit to AI agents via WebMCP — no server, no API key, no data leaving the browser. An agent and a human share one workspace: the same hypothesis, the same dataset, the same sample window. When an agent runs a regression, the numbers go to the agent and the chart renders in the browser for the human to inspect. Every tool call is logged, and findings must cite the step that produced them.

Five real datasets are bundled as static files (climate, biology, astronomy, and two finance datasets), with 14 tools available at peak — a number that grows dynamically as datasets are loaded, features are engineered, and backtests are registered.

---

## Why WebMCP specifically — not a headless MCP server

Compute has five structural properties that require tools to live inside the page next to a human interface. A headless server cannot do any of them:

1. **Dynamic tool surface.** The tool count starts at 4 (explore-only) and grows to 12 when a dataset loads, 13 when a feature is created, and 14 when a backtest is registered. The schema returned by each tool call reflects the actual columns and entities in the loaded data. Tools that reference the page's live state cannot exist outside the page.

2. **Split results: numbers to the agent, charts in the browser.** When `run_regression` or `run_backtest` executes, structured numbers are returned to the agent while Chart.js renders the corresponding visualization in the browser for the human. Splitting results between two consumers — agent and page — is a WebMCP primitive.

3. **Shared mutable state.** The human can change the research question, narrow the sample window, or edit the hypothesis while the agent is mid-session. The next tool call reads the updated value because there is only one copy of it. Shared mutable state between a person and an agent is the core WebMCP thesis; it cannot be emulated by a server with no awareness of the page.

4. **Human-in-the-loop approval gates.** Stationary-block bootstrap with more than 2,000 simulations renders an approval card in the browser instead of running silently. The agent is blocked until the human approves. This gate is enforced by the same state object the agent writes to; it can only work when the tool is inside the page.

5. **Provenance and trust.** Every tool call is appended to a session log. `record_finding` requires a `supporting_steps` list: the agent must cite the logged steps that support its claim. The log is in the page, visible to the human, and the citation check runs inside the tool. A headless server has no ground truth to check against.

---

## How to connect ChatGPT

1. Open ChatGPT and start a new conversation.
2. Paste this URL into the chat to open it in ChatGPT's browser:
   `https://computeopenai.netlify.app/`
3. Ask a plain-language research question — do not name a tool or dataset. For example:
   - *"Is there a momentum effect in US industry returns?"*
   - *"Do Adelie and Gentoo penguins differ in body mass?"*
   - *"How much of global temperature variation is explained by CO2?"*
4. Watch the **Agent** indicator in the top-right header. The capability count jumps from 4 to 12 when the agent loads a dataset, then to 13 and 14 as features and backtests are created.
5. Results appear in the workspace as the agent calls tools. You can edit the hypothesis or narrow the sample window between calls — the agent reads the updated state on its next call.

### Local testing (Chrome + WebMCP flag)

1. `npm run dev` from the repository root.
2. Open `chrome://flags`, search for `webmcp`, enable it, relaunch Chrome.
3. Open `http://localhost:5180` and ask a research question.
4. Add `?dev=1` to the URL to open the developer tool console for testing without a live agent.

---

## Demo script for judges

Use a fresh page for each prompt so the testing ledger stays legible.

### Finance: momentum
> Is there a momentum effect in US industry returns, and does it survive out of sample and transaction costs?

Expected path: agent calls `list_datasets` → `load_dataset` (tool count: 4→12) → `create_feature` (→13) → `run_backtest` (→14) → `run_regression` with HAC standard errors → `hypothesis_test` with session-adjusted threshold → `record_finding` citing steps.

### Biology: species comparison
> Do Adelie and Gentoo penguins differ in body mass? Show whether the difference survives the session-adjusted significance threshold.

Expected path: `load_dataset` (penguins) → `describe_dataset` → `hypothesis_test` with `group_column=species` → `record_finding`.

### Climate: regression with missing data
> Load the climate data. How much of the variation in global temperature is explained by CO2, and how many years were excluded because CO2 data was missing?

Expected path: `load_dataset` (climate_annual) → `run_regression` (agent receives the count of dropped rows) → `hypothesis_test` → `record_finding`.

### Astronomy: historical constant recovery
> Fit Hubble's original 1929 data and report what value of the Hubble constant he recovered. Why does it differ from the modern value?

Expected path: `load_dataset` (hubble_1929) → `run_regression` on distance vs velocity → `record_finding` citing the ~450 km/s/Mpc result and noting the distance calibration error.

---

## Technical highlights

- **No backend.** All five datasets are committed as static CSV files under `public/data/`. The app makes zero network requests at runtime — no API key, no rate limit, nothing that goes down during judging.
- **Stats engine verified against SciPy/NumPy.** `scripts/make_fixtures.py` generates `tests/fixtures/fixtures.json` from Python references; the TypeScript test suite asserts against those numbers. Covered: t/F/chi-squared distributions, Newey-West HAC covariance, Householder QR regression, Benjamini-Hochberg FDR control.
- **Session-adjusted significance.** Every `hypothesis_test` call increments the session counter. The Bonferroni-adjusted threshold and Benjamini-Hochberg discovery count are returned in every result, so the agent is required to reason about multiple testing.
- **Tool schema reflects live page state.** `list_datasets` returns the names of currently-available columns. `load_dataset` updates the schema of downstream tools (summarize, filter, feature engineering) to reflect the actual data. An agent that asks for a column that does not exist gets a typed error, not a silent failure.
- **Reproducibility.** `scripts/fetch_data.py` documents exactly how the bundled datasets were sourced, why 49 Fama-French industry portfolios replaced the original plan for individual stocks (Stooq now serves a bot-check page to non-browser clients), and records the retrieval date in `public/data/SOURCES.md`.

---

## Devpost submission checklist

- [x] Submitted at https://webmcp.devpost.com/
- [x] Public repository with MIT licence: https://github.com/CameronJFowler/Compute-OpenAiMCP
- [x] Live public URL: https://computeopenai.netlify.app/
- [x] Working static build (`npm run build`, `npm test`)
- [x] WebMCP tool registry with schemas generated from active page state
- [x] Five bundled datasets across four domains (climate, biology, astronomy, finance)
- [x] Dynamic tool surface (4 → 12 → 13 → 14 tools)
- [x] Split results: numbers to agent, charts in browser
- [x] Shared mutable state: human and agent share one workspace
- [x] Human-in-the-loop approval gates (bootstrap threshold)
- [x] Provenance: every call logged, findings must cite steps
- [ ] Public demo video (sub 3 minutes with audio) — record and link here
