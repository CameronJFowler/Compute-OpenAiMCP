# Data sources

All three datasets are bundled as static CSVs and committed to the repository.
The application makes no network requests at runtime: no API key, no rate
limit, and nothing that can go down during judging.

Retrieved 2026-08-31 by `scripts/fetch_data.py`.

## industries_daily.csv

2766 trading days x 49 industry
portfolios, 2015-01-02 to 2025-12-31. Stored wide (one row
per date, one column per industry) and expanded into a long panel in the
browser at load time.

- Source: Kenneth R. French Data Library, "49 Industry Portfolios [Daily]",
  average value-weighted returns.
  <https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html>
- Published in percent; converted to decimal here by dividing by 100.
- French codes missing observations as `-99.99` or `-999`; those cells are
  written empty and parsed as missing rather than as a -99% return. There were
  0 such cells in this window.
- The loader also builds a `close` column per industry: a cumulative wealth
  index starting at 100. It is a derived price series, not a traded price, and
  exists so that the price-based transforms (momentum, realised volatility)
  have something to operate on.

**Why industry portfolios and not individual stocks.** The original plan was 50
large-cap tickers from Stooq. As of 2026-08-31 Stooq serves a JavaScript
bot-verification page to non-browser clients rather than CSV, so that route is
closed. Industry portfolios are a better dataset for this purpose regardless:
same provenance as the factor file, explicitly published for research use, no
survivorship bias, and a genuine cross-section to sort on.

## ff_factors_daily.csv

2766 rows, 2015-01-02 to 2025-12-31.
Columns: `date,mkt_rf,smb,hml,rf`.

- Source: Kenneth R. French Data Library, "Fama/French 3 Factors [Daily]".
- Published in percent; converted to decimal here.
- `mkt_rf` is the market return in excess of the risk-free rate, `smb` is small
  minus big, `hml` is high minus low book-to-market, `rf` is the daily
  risk-free rate.

Credit for both French Data Library files: Eugene F. Fama and Kenneth R.
French. Provided by the Data Library for research use.

## hubble_1929.csv

24 rows. Columns: `object,distance_mpc,velocity_km_s`.

- Source: Edwin Hubble, "A relation between distance and radial velocity among
  extra-galactic nebulae", *Proceedings of the National Academy of Sciences*
  15(3):168-173, 1929, Table 1.
- Typed from the published table. Public domain: published in 1929, far outside
  any surviving copyright term.
- Present as a generality check. The same `run_regression` and
  `hypothesis_test` tools that fit a factor model fit `v = H0 * d` here, and
  recover Hubble's original constant of roughly 450 km/s/Mpc - about seven
  times the modern value, because his distance ladder was wrong.

## climate_annual.csv

177 years, 1850 to 2026.
Columns: `date, year, co2_ppm, temp_gcag_c, temp_gistemp_c`.

- Temperature: global mean surface temperature anomaly in degrees Celsius, from
  two independent estimates kept as separate columns
  (gcag, gistemp). GCAG is NOAA's Global Component of the
  Climate at a Glance series; GISTEMP is NASA GISS.
- CO2: annual mean atmospheric carbon dioxide in parts per million, Mauna Loa
  Observatory, NOAA Global Monitoring Laboratory.
- Both retrieved from the Datahub mirrors on GitHub
  (`datasets/global-temp`, `datasets/co2-ppm`) rather than from NOAA and NASA
  directly. `data.giss.nasa.gov` answered twice and then began timing out from
  every client on this network, and a build script for a submission should not
  depend on a host that behaves that way. The mirrors carry the same figures.
- Underlying data are works of the US federal government and are in the public
  domain; the Datahub packages carry the Open Data Commons Public Domain
  Dedication and License (PDDL).
- **CO2 is missing for 110 of the 177 years**,
  because the Mauna Loa record begins in 1959 while the temperature series
  begins in 1850. That gap is deliberate and left in: a regression of
  temperature on CO2 drops those rows and reports how many it dropped, which is
  the behaviour worth showing.
- The two temperature columns measure the same quantity by different methods,
  so a paired test between them is a real question rather than a contrived one.

## penguins.csv

344 birds. Columns: `species, island, bill_length_mm, bill_depth_mm, flipper_length_mm, body_mass_g, sex, year`.
Species: Adelie, Chinstrap, Gentoo.

- Source: Horst AM, Hill AP, Gorman KB (2020), *palmerpenguins: Palmer
  Archipelago (Antarctica) penguin data*. Original data collected by Dr Kristen
  Gorman at Palmer Station, a member of the Long Term Ecological Research
  Network. <https://allisonhorst.github.io/palmerpenguins/>
- Released **CC0** (public domain dedication). No attribution obligation,
  though the citation above is the courteous thing to carry.
- The literal string `NA` is rewritten as an empty cell so the loader reads it
  as missing rather than as a category named "NA". 19 cells
  were affected.
- Present because it is the cleanest available test of whether the bench is
  actually domain-general: three species, two categorical groupings and four
  body measurements, with no time dimension at all.
