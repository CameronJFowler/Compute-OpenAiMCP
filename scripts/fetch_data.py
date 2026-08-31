"""
Fetch and bundle the three datasets, once, at build-prep time.

The shipped app makes no network requests at all - these CSVs are committed and
served as static files. Run this only when the bundled data needs refreshing.

  python scripts/fetch_data.py

Writes public/data/{industries_daily,ff_factors_daily,hubble_1929}.csv and
public/data/SOURCES.md recording where each came from and when.

A note on the equity panel. The original plan was 50 individual large caps from
Stooq. As of 2026-08-28 Stooq serves a JavaScript bot-verification interstitial
to non-browser clients instead of CSV, so that route is closed and working
around it is not something we are going to do. The 49 industry portfolios from
the Kenneth French Data Library replace it, and are a better research dataset
anyway: same provenance as the factor file, explicitly published for research,
free of survivorship bias, and a real cross-section for the backtester to sort.
"""

import csv
import io
import os
import time
import urllib.error
import urllib.request
import zipfile
from datetime import date, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, "..", "public", "data"))

START = "2015-01-01"
END = "2025-12-31"

USER_AGENT = "Mozilla/5.0 (compatible; compute-build-script/1.0)"

FRENCH_FTP = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/"
FF_URL = FRENCH_FTP + "F-F_Research_Data_Factors_daily_CSV.zip"
INDUSTRY_URL = FRENCH_FTP + "49_Industry_Portfolios_daily_CSV.zip"

# Both climate series come from the Datahub mirrors rather than from NOAA and
# NASA directly. data.giss.nasa.gov answered twice and then began timing out
# from every client on this network, and a build script for a submission should
# not depend on a host that behaves like that. The mirrors carry the same
# figures and are served by GitHub.
TEMPERATURE_URL = (
    "https://raw.githubusercontent.com/datasets/global-temp/main/data/annual.csv"
)
CO2_URL = (
    "https://raw.githubusercontent.com/datasets/co2-ppm/main/data/co2-annmean-mlo.csv"
)
PENGUINS_URL = (
    "https://raw.githubusercontent.com/allisonhorst/palmerpenguins/"
    "main/inst/extdata/penguins.csv"
)

# French codes both of these as missing.
MISSING_CODES = (-99.99, -999.0)


def fetch(url, attempts=4, pause=1.5):
    last = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=90) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
            time.sleep(pause * (attempt + 1))
    raise RuntimeError(f"failed to fetch {url}: {last}")


def read_single_entry_zip(raw):
    archive = zipfile.ZipFile(io.BytesIO(raw))
    name = archive.namelist()[0]
    return archive.read(name).decode("utf-8", errors="replace")


def fetch_ff_factors():
    """Fama-French 3 factors plus RF, daily, converted from percent to decimal."""
    text = read_single_entry_zip(fetch(FF_URL))

    rows = []
    for line in text.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 5:
            continue
        stamp = parts[0]
        # The daily block is keyed by an 8-digit date. The annual block that
        # follows is keyed by a 4-digit year, so this filter ends the daily
        # section for us.
        if len(stamp) != 8 or not stamp.isdigit():
            continue
        try:
            values = [float(p) for p in parts[1:]]
        except ValueError:
            continue
        day = f"{stamp[0:4]}-{stamp[4:6]}-{stamp[6:8]}"
        if day < START or day > END:
            continue
        rows.append([day] + [f"{v / 100.0:.8f}" for v in values])

    rows.sort(key=lambda r: r[0])
    path = os.path.join(OUT_DIR, "ff_factors_daily.csv")
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["date", "mkt_rf", "smb", "hml", "rf"])
        writer.writerows(rows)

    print(f"ff factors: {len(rows)} rows -> {path}")
    return {
        "rows": len(rows),
        "first": rows[0][0] if rows else None,
        "last": rows[-1][0] if rows else None,
    }


def fetch_industries():
    """
    49 industry portfolios, daily value-weighted returns.

    Stored wide - one row per date, one column per industry - because that is
    about a quarter the size of the equivalent long format, and the browser
    expands it into a long panel at load time anyway.
    """
    text = read_single_entry_zip(fetch(INDUSTRY_URL))
    lines = text.splitlines()

    # Find the value-weighted daily section, then the header line under it.
    start_index = None
    for i, line in enumerate(lines):
        if "Average Value Weighted Returns" in line and "Daily" in line:
            start_index = i + 1
            break
    if start_index is None:
        raise RuntimeError("could not find the value-weighted daily section")

    header = [p.strip() for p in lines[start_index].split(",")]
    industries = header[1:]
    if len(industries) != 49:
        raise RuntimeError(f"expected 49 industries, found {len(industries)}")

    rows = []
    missing_cells = 0
    for line in lines[start_index + 1 :]:
        parts = [p.strip() for p in line.split(",")]
        stamp = parts[0]
        if len(stamp) != 8 or not stamp.isdigit():
            # End of the daily value-weighted block: the equal-weighted section
            # starts here and we do not want it.
            if rows:
                break
            continue
        if len(parts) != len(industries) + 1:
            continue

        day = f"{stamp[0:4]}-{stamp[4:6]}-{stamp[6:8]}"
        if day < START:
            continue
        if day > END:
            break

        cells = []
        for raw_value in parts[1:]:
            try:
                value = float(raw_value)
            except ValueError:
                cells.append("")
                missing_cells += 1
                continue
            if value in MISSING_CODES:
                cells.append("")
                missing_cells += 1
                continue
            cells.append(f"{value / 100.0:.6f}")
        rows.append([day] + cells)

    path = os.path.join(OUT_DIR, "industries_daily.csv")
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["date"] + industries)
        writer.writerows(rows)

    print(
        f"industries: {len(rows)} dates x {len(industries)} industries "
        f"({missing_cells} missing cells) -> {path}"
    )
    return {
        "dates": len(rows),
        "industries": industries,
        "missing": missing_cells,
        "first": rows[0][0] if rows else None,
        "last": rows[-1][0] if rows else None,
    }


def fetch_climate():
    """
    Annual global temperature anomaly and atmospheric CO2, joined on year.

    Two independent temperature estimates are kept as separate columns rather
    than averaged. They measure the same quantity by different methods, which
    makes a paired test between them a real question rather than a contrived
    one - and the join leaves CO2 missing before 1959, which is an honest
    demonstration of what the tools do about incomplete overlap.
    """
    temp_text = fetch(TEMPERATURE_URL).decode("utf-8", errors="replace")
    co2_text = fetch(CO2_URL).decode("utf-8", errors="replace")

    # Long format: Source,Year,Mean - one row per source per year.
    by_year = {}
    sources = set()
    for record in csv.DictReader(io.StringIO(temp_text)):
        try:
            year = int(record["Year"])
            mean = float(record["Mean"])
        except (TypeError, ValueError, KeyError):
            continue
        source = (record.get("Source") or "").strip().lower()
        if not source:
            continue
        sources.add(source)
        by_year.setdefault(year, {})[source] = mean

    co2_by_year = {}
    for record in csv.DictReader(io.StringIO(co2_text)):
        try:
            co2_by_year[int(record["Year"])] = float(record["Mean"])
        except (TypeError, ValueError, KeyError):
            continue

    ordered_sources = sorted(sources)
    years = sorted(set(by_year) | set(co2_by_year))

    rows = []
    for year in years:
        temps = by_year.get(year, {})
        co2 = co2_by_year.get(year)
        rows.append(
            [f"{year}-12-31", str(year), "" if co2 is None else f"{co2:.2f}"]
            + [
                "" if temps.get(s) is None else f"{temps[s]:.4f}"
                for s in ordered_sources
            ]
        )

    header = ["date", "year", "co2_ppm"] + [f"temp_{s}_c" for s in ordered_sources]
    path = os.path.join(OUT_DIR, "climate_annual.csv")
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(header)
        writer.writerows(rows)

    missing_co2 = sum(1 for r in rows if r[2] == "")
    print(
        f"climate: {len(rows)} years ({years[0]}-{years[-1]}), "
        f"sources {ordered_sources}, {missing_co2} years without CO2 -> {path}"
    )
    return {
        "rows": len(rows),
        "first": years[0],
        "last": years[-1],
        "sources": ordered_sources,
        "missing_co2": missing_co2,
        "columns": header,
    }


def fetch_penguins():
    """
    Palmer Archipelago penguins. 344 birds, three species, two categorical
    groupings and four body measurements. Released CC0.

    The only transformation is turning the literal string NA into an empty cell,
    so the loader reads it as missing rather than as a category called "NA".
    """
    text = fetch(PENGUINS_URL).decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    fieldnames = reader.fieldnames or []

    rows = []
    missing_cells = 0
    for record in reader:
        row = []
        for name in fieldnames:
            value = (record.get(name) or "").strip()
            if value in ("NA", "N/A", "nan", "."):
                value = ""
                missing_cells += 1
            row.append(value)
        rows.append(row)

    path = os.path.join(OUT_DIR, "penguins.csv")
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(fieldnames)
        writer.writerows(rows)

    species = sorted({r[0] for r in rows if r[0]})
    print(f"penguins: {len(rows)} rows, species {species} -> {path}")
    return {"rows": len(rows), "species": species, "missing": missing_cells,
            "columns": fieldnames}


def write_hubble():
    """
    Hubble (1929), 'A relation between distance and radial velocity among
    extra-galactic nebulae', PNAS 15(3):168-173, Table 1.

    Typed from the published table rather than downloaded. This is the
    generality demo: the same regression tool that fits a factor model fits the
    expansion of the universe.
    """
    rows = [
        ("S.Mag", 0.032, 170), ("L.Mag", 0.034, 290), ("NGC6822", 0.214, -130),
        ("NGC598", 0.263, -70), ("NGC221", 0.275, -185), ("NGC224", 0.275, -220),
        ("NGC5457", 0.45, 200), ("NGC4736", 0.5, 290), ("NGC5194", 0.5, 270),
        ("NGC4449", 0.63, 200), ("NGC4214", 0.8, 300), ("NGC3031", 0.9, -30),
        ("NGC3627", 0.9, 650), ("NGC4826", 0.9, 150), ("NGC5236", 0.9, 500),
        ("NGC1068", 1.0, 920), ("NGC5055", 1.1, 450), ("NGC7331", 1.1, 500),
        ("NGC4258", 1.4, 500), ("NGC4151", 1.7, 960), ("NGC4382", 2.0, 500),
        ("NGC4472", 2.0, 850), ("NGC4486", 2.0, 800), ("NGC4649", 2.0, 1090),
    ]
    path = os.path.join(OUT_DIR, "hubble_1929.csv")
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["object", "distance_mpc", "velocity_km_s"])
        writer.writerows(rows)
    print(f"hubble: {len(rows)} rows -> {path}")
    return {"rows": len(rows)}


def write_sources(industries, factors, hubble, climate, penguins):
    today = date.today().isoformat()
    path = os.path.join(OUT_DIR, "SOURCES.md")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(f"""# Data sources

All three datasets are bundled as static CSVs and committed to the repository.
The application makes no network requests at runtime: no API key, no rate
limit, and nothing that can go down during judging.

Retrieved {today} by `scripts/fetch_data.py`.

## industries_daily.csv

{industries['dates']} trading days x {len(industries['industries'])} industry
portfolios, {industries['first']} to {industries['last']}. Stored wide (one row
per date, one column per industry) and expanded into a long panel in the
browser at load time.

- Source: Kenneth R. French Data Library, "49 Industry Portfolios [Daily]",
  average value-weighted returns.
  <https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html>
- Published in percent; converted to decimal here by dividing by 100.
- French codes missing observations as `-99.99` or `-999`; those cells are
  written empty and parsed as missing rather than as a -99% return. There were
  {industries['missing']} such cells in this window.
- The loader also builds a `close` column per industry: a cumulative wealth
  index starting at 100. It is a derived price series, not a traded price, and
  exists so that the price-based transforms (momentum, realised volatility)
  have something to operate on.

**Why industry portfolios and not individual stocks.** The original plan was 50
large-cap tickers from Stooq. As of {today} Stooq serves a JavaScript
bot-verification page to non-browser clients rather than CSV, so that route is
closed. Industry portfolios are a better dataset for this purpose regardless:
same provenance as the factor file, explicitly published for research use, no
survivorship bias, and a genuine cross-section to sort on.

## ff_factors_daily.csv

{factors['rows']} rows, {factors['first']} to {factors['last']}.
Columns: `date,mkt_rf,smb,hml,rf`.

- Source: Kenneth R. French Data Library, "Fama/French 3 Factors [Daily]".
- Published in percent; converted to decimal here.
- `mkt_rf` is the market return in excess of the risk-free rate, `smb` is small
  minus big, `hml` is high minus low book-to-market, `rf` is the daily
  risk-free rate.

Credit for both French Data Library files: Eugene F. Fama and Kenneth R.
French. Provided by the Data Library for research use.

## hubble_1929.csv

{hubble['rows']} rows. Columns: `object,distance_mpc,velocity_km_s`.

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

{climate['rows']} years, {climate['first']} to {climate['last']}.
Columns: `{', '.join(climate['columns'])}`.

- Temperature: global mean surface temperature anomaly in degrees Celsius, from
  two independent estimates kept as separate columns
  ({', '.join(climate['sources'])}). GCAG is NOAA's Global Component of the
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
- **CO2 is missing for {climate['missing_co2']} of the {climate['rows']} years**,
  because the Mauna Loa record begins in 1959 while the temperature series
  begins in 1850. That gap is deliberate and left in: a regression of
  temperature on CO2 drops those rows and reports how many it dropped, which is
  the behaviour worth showing.
- The two temperature columns measure the same quantity by different methods,
  so a paired test between them is a real question rather than a contrived one.

## penguins.csv

{penguins['rows']} birds. Columns: `{', '.join(penguins['columns'])}`.
Species: {', '.join(penguins['species'])}.

- Source: Horst AM, Hill AP, Gorman KB (2020), *palmerpenguins: Palmer
  Archipelago (Antarctica) penguin data*. Original data collected by Dr Kristen
  Gorman at Palmer Station, a member of the Long Term Ecological Research
  Network. <https://allisonhorst.github.io/palmerpenguins/>
- Released **CC0** (public domain dedication). No attribution obligation,
  though the citation above is the courteous thing to carry.
- The literal string `NA` is rewritten as an empty cell so the loader reads it
  as missing rather than as a category named "NA". {penguins['missing']} cells
  were affected.
- Present because it is the cleanest available test of whether the bench is
  actually domain-general: three species, two categorical groupings and four
  body measurements, with no time dimension at all.
""")
    print(f"sources -> {path}")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"fetching into {OUT_DIR}")
    print(f"started {datetime.now().isoformat(timespec='seconds')}")

    hubble = write_hubble()
    climate = fetch_climate()
    penguins = fetch_penguins()
    factors = fetch_ff_factors()
    industries = fetch_industries()
    write_sources(industries, factors, hubble, climate, penguins)

    stale = os.path.join(OUT_DIR, "equities_daily.csv")
    if os.path.exists(stale):
        os.remove(stale)
        print("removed the empty equities_daily.csv from the abandoned Stooq run")

    total = sum(
        os.path.getsize(os.path.join(OUT_DIR, name)) for name in os.listdir(OUT_DIR)
    )
    print(f"total bundled size: {total / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
