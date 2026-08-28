/** Product name. Change it here and it changes everywhere. */
export const APP_NAME = "Compute";

export const APP_TAGLINE =
  "A quantitative research bench that a human and an agent operate together.";

/** Significance level before any session adjustment. */
export const DEFAULT_ALPHA = 0.05;

/** Bootstrap simulations above this count require a human click. */
export const APPROVAL_SIMULATION_THRESHOLD = 2000;

export const MAX_SIMULATIONS = 20000;

/** Chronological in-sample fraction. Deliberately not user-settable. */
export const IN_SAMPLE_FRACTION = 0.7;

export const TRADING_DAYS_PER_YEAR = 252;

/** Hard cap on the text a tool returns to the agent. */
export const MAX_RESULT_CHARS = 1500;

export interface DatasetManifestEntry {
  id: string;
  name: string;
  domain: string;
  file: string;
  /** Layout the parser should expect. */
  layout: "panel_wide" | "series" | "cross_section";
  description: string;
  /** Shown to the agent so it knows what the columns mean before loading. */
  semanticNote: string;
}

/**
 * The bundled datasets. list_datasets reads straight from this, so adding a
 * dataset is a one-entry change and the agent's tool surface follows.
 */
export const DATASETS: DatasetManifestEntry[] = [
  {
    id: "industries_daily",
    name: "49 US industry portfolios, daily, 2015-2025",
    domain: "finance",
    file: "/data/industries_daily.csv",
    layout: "panel_wide",
    description:
      "Daily value-weighted returns for 49 US industry portfolios, 2766 trading days. A panel: one row per industry per trading day, 135,534 rows. The Fama-French factors are joined on by date, so market, size and value controls are available without loading a second dataset.",
    semanticNote:
      "ret is the daily value-weighted return in decimal. close is a cumulative wealth index starting at 100, derived from ret, so that price-based transforms (momentum, realised_vol) have something to work on - it is not a traded price. mkt_rf, smb, hml and rf are the Fama-French daily factors, identical across every industry on a given date, so use them as controls and never as a cross-sectional signal.",
  },
  {
    id: "ff_factors_daily",
    name: "Fama-French 3 factors, daily",
    domain: "finance",
    file: "/data/ff_factors_daily.csv",
    layout: "series",
    description:
      "Daily market, size and value factor returns plus the risk-free rate. A single time series, one row per trading day.",
    semanticNote:
      "mkt_rf is the market return in excess of the risk-free rate; smb is small minus big; hml is high minus low book-to-market; rf is the daily risk-free rate. All in decimal, converted from the published percentages. Use these as controls so a result is not just repackaged market beta.",
  },
  {
    id: "hubble_1929",
    name: "Hubble 1929: 24 extra-galactic nebulae",
    domain: "astronomy",
    file: "/data/hubble_1929.csv",
    layout: "cross_section",
    description:
      "Distance in megaparsecs and radial velocity in km/s for 24 galaxies, from Hubble's original 1929 paper. 24 rows, no time dimension.",
    semanticNote:
      "Regressing velocity_km_s on distance_mpc estimates Hubble's constant. Hubble got roughly 450 km/s/Mpc; the modern value is near 70, because his distance calibration was wrong. The dataset is here to show that the tools are not finance-specific.",
  },
];

export function findDataset(id: string): DatasetManifestEntry | undefined {
  return DATASETS.find((d) => d.id === id);
}

export const DATASET_IDS = DATASETS.map((d) => d.id);
