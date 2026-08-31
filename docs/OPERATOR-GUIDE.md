# Compute operator guide

This guide is intentionally outside the application interface. The page itself
is for conducting research; this file is for running, demonstrating, deploying,
or judging it.

## What Compute is

Compute is a browser-based research workspace shared by a person and an agent.
It keeps the active question, dataset, sample window, results, findings, and
testing record in one local workspace. A result is only actionable if it can
be traced to the step that produced it.

The project has depth for quantitative research—HAC regression, a
look-ahead-free cross-sectional backtest, and stationary-block bootstrap—while
also supporting climate, astronomy, and biology datasets. Finance is a strong
use case, not the boundary of the product.

## Connect an agent through WebMCP

WebMCP is browser capability, not a server connection. The page registers its
tools directly in the browser whenever a compatible host is present.

### ChatGPT in-app browser

1. Open the deployed Compute URL from a ChatGPT conversation.
2. Ask a plain-language research question; do not name a tool.
3. When the page header changes from `Session local` to `Session live`, the
   agent browser has discovered the page's tool surface.

### Chromium testing browser

1. Run `npm run dev` from the repository root. `localhost` is a secure context.
2. Use a Chromium build with WebMCP enabled. In Chrome, open `chrome://flags`,
   search for `webmcp`, enable the matching testing flag, then relaunch.
3. Open `http://localhost:5180` and ask the agent a research question.

### Success criteria

- The header says `Session live`.
- Loading a dataset changes the action count from 4 to 12.
- Creating a feature changes it again.
- Agent-produced results appear in the workspace and in the session record.
- An expensive bootstrap presents an approval card instead of running silently.

## Demo prompts

Use a fresh page for each demo so the testing ledger stays legible.

### Quantitative research

> Is there a momentum effect in US industry returns, and does it survive out of sample and transaction costs?

### Biology

> Do Adelie and Gentoo penguins differ in body mass? Show whether the difference survives the session-adjusted threshold.

### Climate

> Load the climate data. How much of the variation in global temperature is explained by CO2, and how many years were excluded?

## Deployment

GitHub Pages is configured in `.github/workflows/deploy.yml`. In the GitHub
repository, open **Settings → Pages**, choose **GitHub Actions** as the source,
then wait for the workflow to finish. The expected public URL is:

`https://cameronjfowler.github.io/Compute-OpenAiMCP/`

The build is host-agnostic. Netlify, Vercel, Cloudflare Pages, and GitHub Pages
all work. `DEPLOY_BASE` handles the GitHub Pages subpath and ensures bundled
datasets load from the deployed app path rather than the domain root.

## Development checks

```powershell
npm test
npm run build
npm run dev
```

`?dev=1` opens a developer-only tool console. It is for testing the browser
surface when an agent host is not available; it is not part of the normal user
experience or the demo.

## Architecture notes

- `src/webmcp/host.ts` locates `document.modelContext` first and uses the older
  `navigator.modelContext` spelling only as a compatibility fallback.
- `src/webmcp/registry.ts` serialises registry updates and uses an
  `AbortController` per tool registration. This avoids duplicate registrations
  while the active schema changes.
- `src/state/workspace.ts` is the single state object for user input and tool
  calls. The question and sample window record whether they were last changed
  by the agent or the person.
- `src/engine/` contains the numerical implementation. Tests compare core
  statistics with fixtures generated from SciPy and NumPy.

## Challenge checklist

- [x] Public repository with MIT licence
- [x] Working static build and documented run instructions
- [x] WebMCP tool registry with schemas generated from active page state
- [ ] Live public URL
- [ ] Verify one real agent call in a compatible browser
- [ ] Public sub-three-minute demo video with audio
- [ ] Devpost submission text and URL
