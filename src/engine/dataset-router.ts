/**
 * Dataset routing for a natural-language research question.
 *
 * This is deliberately small, deterministic and inspectable. The agent does
 * the reasoning; this layer removes an avoidable bookkeeping turn where it
 * would otherwise have to translate a plain question into an internal ID.
 */

import type { DatasetManifestEntry } from "../config";

export interface DatasetRoute {
  datasetId: string;
  score: number;
  matchedTerms: string[];
  fallback: boolean;
}

type RouteRule = {
  datasetId: string;
  terms: readonly string[];
};

const ROUTES: readonly RouteRule[] = [
  {
    datasetId: "penguins",
    terms: [
      "penguin", "penguins", "adelie", "gentoo", "chinstrap", "flipper",
      "bill length", "bill depth", "body mass", "body weight", "species",
    ],
  },
  {
    datasetId: "hubble_1929",
    terms: [
      "hubble", "galaxy", "galaxies", "nebula", "nebulae", "astronomy",
      "astronomical", "radial velocity", "megaparsec", "recession velocity",
    ],
  },
  {
    datasetId: "climate_annual",
    terms: [
      "climate", "temperature", "warming", "global warming", "co2", "carbon dioxide",
      "carbon", "emissions", "atmospheric", "mauna loa", "greenhouse",
    ],
  },
  {
    datasetId: "ff_factors_daily",
    terms: [
      "fama french", "fama-french", "factor return", "factor model", "market factor",
      "smb", "hml", "risk free", "risk-free", "book to market", "book-to-market",
    ],
  },
  {
    datasetId: "industries_daily",
    terms: [
      "momentum", "backtest", "backtest", "sharpe", "transaction cost", "portfolio",
      "portfolio return", "industry return", "industry returns", "equity", "equities",
      "stock", "stocks", "trading", "quant", "quantitative", "market beta",
      "out of sample", "out-of-sample", "long short", "long-short", "return", "returns",
    ],
  },
];

const DEFAULT_DATASET_ID = "industries_daily";

function normalise(question: string): string {
  return question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Select the bundled dataset whose domain is most explicit in the question. */
export function routeDataset(question: string): DatasetRoute {
  const text = normalise(question);
  let best: DatasetRoute = {
    datasetId: DEFAULT_DATASET_ID,
    score: 0,
    matchedTerms: [],
    fallback: true,
  };

  for (const route of ROUTES) {
    const matches = route.terms.filter((term) => text.includes(normalise(term)));
    // A more specific multi-word phrase carries more evidence than one token.
    const score = matches.reduce((total, term) => total + (term.includes(" ") ? 3 : 1), 0);
    if (score > best.score) {
      best = { datasetId: route.datasetId, score, matchedTerms: matches, fallback: false };
    }
  }

  return best;
}

/** Guard against a routing table getting out of step with the data manifest. */
export function routedDataset(
  question: string,
  datasets: readonly DatasetManifestEntry[],
): DatasetRoute {
  const route = routeDataset(question);
  if (datasets.some((dataset) => dataset.id === route.datasetId)) return route;
  return { datasetId: datasets[0]?.id ?? DEFAULT_DATASET_ID, score: 0, matchedTerms: [], fallback: true };
}
