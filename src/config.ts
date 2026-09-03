/** Product name. Change it here and it changes everywhere. */
export const APP_NAME = "Compute";

/** Where the running app points anyone who wants to attach an agent. */
export const OPERATOR_GUIDE_URL =
  "https://github.com/CameronJFowler/Compute-OpenAiMCP/blob/main/docs/OPERATOR-GUIDE.md";

export const APP_TAGLINE =
  "A statistical research bench. Browser-only, no backend, powered by WebMCP.";

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
  /**
   * Per-column meaning, surfaced by describe_dataset.
   *
   * Held in the manifest rather than in the loader so that adding a dataset is
   * a single entry here and never a code change. The loader used to carry
   * Hubble's column notes in an `if`, which worked exactly once.
   */
  columnNotes?: Record<string, string>;
  /**
   * What is wrong with this data, in its own words.
   *
   * build_report used to carry one hardcoded list written for the equity panel,
   * so a report about penguins asserted that "the industry portfolio returns
   * are value-weighted index returns". A generated report that states falsehoods
   * about its own data is worse than one with no limitations section, and it
   * contradicts the only thing this project claims: that the write-up is
   * assembled from what actually happened.
   */
  limitations?: string[];
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
    limitations: [
      "Industry portfolio returns are value-weighted index returns, not tradeable instruments. A real implementation would face borrow costs, capacity limits and market impact that no backtest here models.",
      "`close` is a wealth index reconstructed from `ret`, not a traded price. Treat any price-based transform as a construction rather than a market observation.",
    ],
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
    limitations: [
      "Factor returns are constructed long-short portfolios, not instruments that can be held. Loading on a factor is not the same as being able to capture it.",
    ],
  },
  {
    id: "climate_annual",
    name: "Global temperature and atmospheric CO2, annual, 1850-2026",
    domain: "climate",
    file: "/data/climate_annual.csv",
    layout: "series",
    description:
      "Annual global mean surface temperature anomaly from two independent estimates, alongside atmospheric CO2 measured at Mauna Loa. 177 rows, one per year.",
    semanticNote:
      "temp_gcag_c and temp_gistemp_c are degrees Celsius relative to a twentieth-century baseline, produced by NOAA and NASA respectively. They estimate the same physical quantity by different methods, so a paired test between them asks a real question. co2_ppm is parts per million and is MISSING before 1959, when the Mauna Loa record begins - a regression using it drops those years and reports how many.",
    columnNotes: {
      year: "Calendar year, as a number, so it can be used as a regressor for a linear trend.",
      co2_ppm:
        "Annual mean atmospheric CO2 in parts per million, Mauna Loa Observatory. Missing before 1959.",
      temp_gcag_c:
        "Global mean surface temperature anomaly, degrees Celsius. NOAA Global Component of Climate at a Glance.",
      temp_gistemp_c:
        "Global mean surface temperature anomaly, degrees Celsius. NASA GISS Surface Temperature Analysis.",
    },
    limitations: [
      "CO2 is missing before 1959, so any regression involving it is fitted on the 1959-onward overlap only, whatever the stated window.",
      "The two temperature series share input observations and are not independent estimates. Agreement between them is weaker evidence than it appears.",
      "Annual global means say nothing about any particular place or season.",
    ],
  },
  {
    id: "penguins",
    name: "Palmer Archipelago penguins: 344 birds, three species",
    domain: "biology",
    file: "/data/penguins.csv",
    layout: "cross_section",
    description:
      "Body measurements for 344 penguins of three species across three islands, with sex and study year. No time dimension: a plain cross-section with categorical groupings.",
    semanticNote:
      "species, island and sex are categorical; bill_length_mm, bill_depth_mm, flipper_length_mm and body_mass_g are measurements in millimetres and grams. To compare groups, pass group_column to hypothesis_test - for example body_mass_g split by species between Adelie and Gentoo. A handful of birds are missing measurements or sex.",
    columnNotes: {
      species: "Adelie, Chinstrap or Gentoo.",
      island: "Biscoe, Dream or Torgersen.",
      sex: "male or female; missing for a few birds.",
      bill_length_mm: "Length of the bill along the culmen, millimetres.",
      bill_depth_mm: "Depth of the bill, millimetres.",
      flipper_length_mm: "Flipper length, millimetres.",
      body_mass_g: "Body mass, grams.",
      year: "Study year, 2007 to 2009.",
    },
    limitations: [
      "344 birds from three islands of one archipelago over three seasons. Nothing here generalises to penguins elsewhere or to other years.",
      "Sex and a few measurements are missing for some birds; tests drop those rows rather than impute them.",
    ],
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
      "Regressing velocity_km_s on distance_mpc estimates Hubble's constant. Hubble got roughly 450 km/s/Mpc; the modern value is near 70, because his distance calibration was wrong.",
    columnNotes: {
      object: "Galaxy or nebula identifier as Hubble labelled it.",
      distance_mpc: "Distance in megaparsecs, from Hubble's own calibration.",
      velocity_km_s: "Radial velocity in km/s, positive meaning recession.",
    },
    limitations: [
      "24 objects, and Hubble's distance calibration is now known to be wrong by roughly a factor of seven. Fitting this recovers what he measured, not the expansion rate of the universe.",
      "No uncertainty on the distances is published with the table, so the standard errors describe scatter about the fit and nothing else.",
    ],
  },
];

export function datasetDomains(): string[] {
  return [...new Set(DATASETS.map((d) => d.domain))].sort();
}

export function findDataset(id: string): DatasetManifestEntry | undefined {
  return DATASETS.find((d) => d.id === id);
}

export const DATASET_IDS = DATASETS.map((d) => d.id);
