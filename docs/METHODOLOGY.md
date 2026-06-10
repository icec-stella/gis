# Methodology: Walmart–LINAC Drive-Time Gap Analysis

This document describes — in scientific rather than software-engineering terms — how the figures shown in the application's **metrics table** are computed, plus an optional **supplementary** breakdown of viable LINAC gaps by nearest hospital type (general acute vs. critical access; §10). It is intended for researchers, clinicians, and reviewers who need to understand and reproduce the analysis. It does not describe how the code is structured; for that, see [`PROJECT.md`](./PROJECT.md).

---

## 1. Research question

For every Walmart store location in the United States, the analysis answers two questions:

1. **Radiation oncology reach.** Can a patient at this Walmart drive to a linear accelerator (LINAC) facility within the time window selected by the user (default: 60 minutes)?
2. **Inpatient backstop.** If the answer to (1) is no, can the patient at least drive to a general acute or critical access hospital within **30 minutes** — i.e., is there a hospital that could provide initial diagnosis, stabilization, or non-radiation supportive care nearby, even if specialized radiation therapy is not reachable?

Walmart stores are used as proxies for population access points: they are densely distributed, well-geocoded, sited where people actually live and shop, and they correlate strongly with the medically underserved rural and exurban populations of interest to oncology coverage research. Substituting another point set (e.g., ZIP code centroids or census-block populations) is a straightforward extension but is not done here.

The metrics table reports, for each state and for the United States as a whole, how many Walmart stores fall into each of the resulting categories.

---

## 2. Data sources

Three static datasets drive the analysis. All are loaded fresh from disk on each request and never mutated.

| Dataset | File | Records | Source / notes |
|---|---|---|---|
| Walmart store locations | `src/data/walmart-locations.json` | 4,654 | Includes the contiguous 48, AK, HI, DC, and PR. Fields: name, address, city, state (two-letter), latitude, longitude. |
| LINAC facility locations | `src/data/linac-locations.json` | 2,124 records / ~2,250 machines | Compiled from publicly available radiation oncology facility lists. Fields: facility name, city, state (two-letter), coordinates, and the number of LINAC machines at the site. |
| Hospital locations | `src/data/hospital-locations.json` | 7,596 raw rows | HIFLD-style (Homeland Infrastructure Foundation-Level Data) U.S. hospital inventory. Fields used: NAME, STATE, STATUS, TYPE, LATITUDE, LONGITUDE. |

State coverage is the 50 states plus the District of Columbia (DC) and Puerto Rico (PR). The hospital file contains one row coded as Palau (PW); that row is flagged at startup and excluded from per-state and US results.

---

## 3. Inclusion criteria

### 3.1 Walmart stores

Every row in the Walmart file is included. A store is attributed to the state given in its `state` field — i.e., commercial / corporate state, not the state in which its coordinates happen to fall. This avoids ambiguity for stores located close to state lines and matches how Walmart itself classifies the location.

Stores with missing or invalid coordinates are **kept** in the per-state count and the LINAC-gap count (they obviously cannot reach any facility on a road network), but they are excluded from the viable-vs-systemic split because no drive-time routing is possible. See §6.3.

### 3.2 LINAC centers

All LINAC rows with valid coordinates are eligible to serve as **destinations** for drive-time routing (subject to the cross-border rule in §5.2). State inventory counts (the "LINAC Centers" and "Total LINACs" columns of the table) use a separate match on the `States` field of the LINAC dataset, independent of routing. A center contributes to a state's inventory if and only if its `States` value equals that state's two-letter code.

The LINAC machine count for a facility is taken verbatim from its `Number of LINACs` field. The state-level total is the sum of these values across all centers in the state.

### 3.3 Hospitals

A hospital row is eligible to serve as a routing destination if **all three** of the following hold:

1. **Valid coordinates** — finite latitude and longitude in the legal WGS84 range.
2. **`STATUS = 'OPEN'`** — closed hospitals are excluded. In the source data, 319 of 7,596 rows are coded `CLOSED`.
3. **`TYPE ∈ {GENERAL ACUTE CARE, CRITICAL ACCESS}`** — the two HIFLD facility-care categories that represent inpatient acute care. The eight excluded categories are `PSYCHIATRIC`, `LONG TERM CARE`, `REHABILITATION`, `MILITARY`, `SPECIAL`, `CHILDREN`, `WOMEN`, and `CHRONIC DISEASE`.

After applying all three filters, **5,271 hospitals** are eligible: 4,261 general acute care + 1,010 critical access (counts exclude closed rows, non-eligible `TYPE`s, invalid coordinates, and territory codes with no Walmart footprint: AS, GU, MP, PW, VI). No bed-count threshold is applied — the clinical `TYPE` filter alone determines inpatient-backstop eligibility, and facilities with unreported bed counts (HIFLD's `-999` sentinel) are included on the same basis as any other open acute-care or critical-access hospital.

#### Why the `TYPE` filter rather than NAICS

An earlier version of this analysis used the NAICS economic classifier (`NAICS_CODE = 622110`, "general medical and surgical hospitals") to select eligible hospitals. That filter is too coarse for an oncology backstop question: NAICS 622110 also bundles in 215 military hospitals, 105 psychiatric facilities filed under the general-medical NAICS, 104 children's general hospitals, 54 long-term-care facilities, 33 rehabilitation hospitals, and 18 other specialty facilities (529 rows total) that should not be counted as a general-population emergency or inpatient backstop. Conversely, NAICS 622110 misses 11 hospitals that HIFLD classifies as `GENERAL ACUTE CARE` (for example, OSU James Cancer Hospital, classified under specialty NAICS but operating as acute care). The HIFLD `TYPE` field, while less stable across data vintages, is the correct clinical classifier for this question.

#### Why "critical access" is included

Critical access hospitals (CAH) are a federal Medicare designation for small rural acute-care facilities — typically ≤25 beds, located more than 35 miles from another hospital, with average inpatient lengths of stay under 96 hours. They are explicitly designed to serve as the *only* acute-care backstop for rural populations. Excluding them would systematically under-count backstop access in exactly the rural states where the LINAC-gap question is most policy-relevant.

---

## 4. Drive-time computation

Drive times are computed by the **Project OSRM Table service** (`/table/v1/driving`) over the OpenStreetMap road network using the public demo router at `http://router.project-osrm.org`. OSRM returns a matrix of driving durations in seconds. Each cell `durations[i][j]` is the time, on the real road network, from source point `i` to destination point `j` using the OSRM `driving` profile (car, ignoring traffic).

We use **only the OSRM Table durations** — no straight-line (Haversine) approximation is used at any point in the metrics computation. A radius-based "Hide Walmarts" toggle exists in the user interface for map visualization, but that toggle uses a straight-line heuristic at a fixed 50 mph average speed and is not used in any reported metric.

A duration cell may be returned as `null` when OSRM cannot find a route — for example, when a source and destination are on disconnected road networks (small islands, ferry-only links, etc.). **A `null` cell is treated as "unreachable" and never satisfies the "within range" test.** A Walmart store for which every LINAC column is `null` is therefore classified as a LINAC gap, and similarly for hospitals.

The drive-time matrices are batched and tiled to stay within OSRM URL length and coordinate-count limits of the public router. Successful matrix responses are cached in process memory for 7 days, keyed by the exact coordinate sequence, so repeated identical queries do not re-hit the public service. The cache is invalidated on process restart.

### Limitations of the OSRM demo

The public OSRM demo router is intended for testing and small-scale use. It does not pin an OSRM build, an OSM extract date, or any service-level guarantee. For publication-grade reproducibility, the base URL should be re-pointed at a self-hosted OSRM instance with a recorded OSM extract date and OSRM version. The figures reported here are reproducible up to the OSM extract vintage that the demo router happens to be serving on the day of the run.

---

## 5. Routing rules

### 5.1 Two independent drive-time thresholds

The analysis uses **two distinct drive-time ceilings**, evaluated independently:

| Threshold | Applies to | Default | Configurable |
|---|---|---|---|
| **LINAC reachability** | Walmart → nearest LINAC center | 60 min | Yes, via the slider in the UI (15–180 min) |
| **Hospital backstop** | Walmart → nearest acute / critical access hospital | **30 min** | No (fixed in code) |

The two thresholds answer two different clinical questions, and stretching one does not stretch the other. A user widening the LINAC slider to 180 minutes is asking "how far does a patient *have* to travel for radiation therapy?" — a planning question about specialized care. Asking the same patient to drive three hours for emergency or inpatient care would not be a meaningful backstop, so the hospital threshold remains anchored at 30 minutes regardless of the slider position. The hospital-side analysis is therefore exactly the same whether the LINAC slider is set to 30 minutes or 180 minutes.

### 5.2 Cross-border destination rule (Alaska / Hawaii / Puerto Rico isolation)

Drive-time routing over a connected road network is meaningless for facility pairs that are not on the same road network. The contiguous 48 states and DC share one connected network; Alaska's road network is largely disjoint from the contiguous 48; and Hawaii and Puerto Rico are island networks unreachable by road from the mainland.

We therefore apply the following rule for both LINAC and hospital destination sets:

| Market state (the state the Walmart is in) | Eligible destinations |
|---|---|
| Alaska | LINACs / hospitals **in Alaska only** |
| Hawaii | LINACs / hospitals **in Hawaii only** |
| Puerto Rico | LINACs / hospitals **in Puerto Rico only** |
| Any other state | All LINACs / hospitals **except** those in Alaska, Hawaii, or Puerto Rico |

Continental markets are explicitly allowed to route across state lines — a Walmart in southern Vermont may be closest to a Massachusetts LINAC, and that counts. Only the three isolated-network states / territories above are special-cased.

The market state is determined by the Walmart's `state` field (commercial state), not by the polygon its coordinates happen to fall in. This eliminates ambiguity for stores on or near state lines.

### 5.3 OSRM Table sources and destinations

For each market state, the OSRM Table request is constructed with **every coordinate-valid Walmart store in that state** as sources, and every eligible destination (subject to §5.2) as destinations. OSRM returns the full sources × destinations duration matrix. Large markets are tiled into shards of up to 96 coordinates per HTTP request; the shards are recombined into the full matrix before classification.

---

## 6. Classifying each Walmart store

For a given market state and slider value, every Walmart store in the state passes through a two-step classification.

### 6.1 Step 1 — LINAC reachability

The OSRM matrix from this state's Walmart stores to the eligible LINAC destinations is computed.

For each Walmart store **W** with valid coordinates, define

> *W is **LINAC-within-range*** if there exists at least one column `j` in W's row such that `duration[W][j]` is not null and `duration[W][j] ≤ slider_minutes × 60`.

Otherwise *W is **LINAC-gap***.

Walmart stores with **invalid coordinates** cannot be routed and are classified as **LINAC-gap** by definition.

### 6.2 Step 2 — Hospital backstop (only for LINAC-gap stores with valid coordinates)

For each Walmart store **W** that is LINAC-gap and has valid coordinates, the OSRM matrix from W to the eligible hospital destinations is computed. (Walmart stores that are LINAC-gap but have invalid coordinates are not routed in Step 2.)

> *W is a **viable gap*** if there exists at least one column `k` in W's row such that `duration[W][k]` is not null and `duration[W][k] ≤ 30 × 60`.
>
> Otherwise *W is a **systemic gap***.

Step 2 records only whether **any** eligible hospital is within 30 minutes. It does **not** record which `TYPE` satisfied the test. A separate supplementary breakdown (§10) classifies each **viable** gap by the `TYPE` of the **nearest** hospital among those within 30 minutes.

A LINAC-gap store therefore splits cleanly into one of three categories: **viable gap**, **systemic gap**, or — if its coordinates are invalid and Step 2 cannot be run — neither. The third category is rare in the current data but is reported transparently (see §6.3).

### 6.3 Putting it together

For a market state's total Walmart count *N*, we have the identity

> *N* = (LINAC-within-range) + (LINAC-gap)

and within the LINAC-gap subset

> (LINAC-gap with valid coordinates) = (viable gap) + (systemic gap)
> (LINAC-gap with invalid coordinates) = (LINAC-gap) − (viable gap) − (systemic gap)

The metrics table column **"No LINAC within X min"** reports the full LINAC-gap count (including invalid-coord stores). The columns **"Viable gap"** and **"Systemic gap"** report only the coord-valid LINAC-gap subset. The difference is the number of stores with invalid coordinates, which is small in the current data.

This decomposition is sanity-checked at runtime: the server emits a warning if `viable + systemic ≠ (LINAC-gap) − (invalid-coord LINAC-gap stores)` for any state.

---

## 7. State-level metrics (columns of the table)

For each state, the metrics table reports six numbers plus a row label.

| Column | Definition |
|---|---|
| State | Two-letter state code (or "United States (sum)" for the aggregate row) |
| No LINAC within *X* min | Number of Walmart stores in this state that are LINAC-gap at the user-selected drive time, including stores with invalid coordinates |
| Viable gap | Number of LINAC-gap stores (with valid coordinates) that **do** have a general acute or critical access hospital reachable within 30 minutes |
| Systemic gap | Number of LINAC-gap stores (with valid coordinates) that **do not** have any eligible hospital reachable within 30 minutes |
| Total Walmarts | Total number of Walmart stores attributed to this state (by `state` field) |
| LINAC Centers | Number of LINAC facility records in this state (by `States` field) |
| Total LINACs | Sum of the `Number of LINACs` field across all LINAC centers in this state |

The last three are **inventory counts**, not OSRM-derived. They reflect what is present in the state, not what is reachable.

These six columns do **not** include a general-acute vs. critical-access split. That split is produced only by the offline report described in §10.

---

## 8. National (United States) aggregation

The "United States (sum)" row at the top of the table is computed by running the per-state analysis described in §6 separately for **every state code present in either the Walmart or the LINAC dataset** — a union, to ensure that a state present in one fixture but not the other still contributes its inventory to the national totals — and then summing the per-column results.

The aggregation is **not** a single nationwide OSRM matrix. Each state's Walmarts are routed only against destinations admissible by the cross-border rule in §5.2. This means:

- A Walmart in Texas may route to LINACs and hospitals in Oklahoma, New Mexico, Louisiana, etc.
- A Walmart in Alaska may route only to in-Alaska destinations.
- Hawaii and Puerto Rico Walmarts likewise route only to in-territory destinations.

The per-state results are then summed exactly as you would expect: total LINAC-gap is the sum over states of LINAC-gap, viable gap is the sum of viable gaps, etc. Inventory columns (LINAC Centers, Total LINACs, Total Walmarts) are also straight sums.

The hospital backstop threshold (30 minutes) is unchanged across the aggregation.

---

## 9. Edge cases and null-handling

A few edge cases are worth being explicit about for reviewers.

**Markets with no eligible LINAC destinations.** If a market state has zero coordinate-valid LINACs that pass the cross-border rule (e.g., a hypothetical territory not covered in the LINAC file), every Walmart in that state is classified as LINAC-gap. The Step-2 hospital classification still runs normally for coord-valid stores.

**Markets with no eligible hospital destinations.** If a market state has zero hospitals passing the eligibility filters, every LINAC-gap store with valid coordinates is classified as a **systemic gap** by definition (no possible hospital to be reachable). This is the conservative classification and matches the literal interpretation of the systemic-gap definition.

**Null OSRM cells.** Treated as unreachable, never as "within range." See §4.

**Walmart with invalid coordinates.** Counted in `Total Walmarts` and in `No LINAC within X min`, but excluded from the viable-vs-systemic split. The number of such stores in the current data is small but not zero, and the runtime check in §6.3 surfaces any inconsistency.

**Hospitals coded with state "PW" (Palau) or any other non-recognized code.** Excluded from both per-state and US results by the startup state-code validator. Logged at server start so reviewers can verify exclusions.

**Border stores.** Always attributed to the state in their `state` field, never to the geographic state-polygon their coordinates happen to fall in. The location list in the application UI also follows this rule, so sidebar counts and table counts cannot disagree.

---

## 10. Supplementary analysis: viable-gap backstop by hospital TYPE

Researchers often need to know not only that a LINAC-gap Walmart has **some** hospital backstop within 30 minutes (a **viable gap**), but whether the closest such backstop is **general acute care** or **critical access**. That breakdown is **not** shown in the web metrics table; it is generated by an offline script that reuses the same OSRM rules as §§4–6.

### 10.1 Definition (per viable-gap Walmart)

Fix the LINAC drive-time threshold (the script default is **60 minutes**, matching the application default). Classify stores with Step 1 and Step 2 as in §6. For each store **W** that is a **viable gap** (coord-valid, LINAC-gap, and at least one eligible hospital ≤ 30 minutes):

1. Consider only hospital columns `k` in W's hospital OSRM row where `duration[W][k]` is not null and `duration[W][k] ≤ 30 × 60`.
2. Among those columns, take the one with the **minimum** duration (ties broken by the smallest column index).
3. Assign W the `TYPE` of the hospital in that column: `GENERAL ACUTE CARE` or `CRITICAL ACCESS`.

**Systemic gaps** (no hospital ≤ 30 minutes) are excluded from this TYPE split. **Invalid-coordinate** LINAC-gap stores are excluded because Step 2 does not run for them.

This is a **per-store** count (342 stores at the national default), not a count of unique hospitals. One critical-access hospital may be the nearest backstop for many Walmarts.

### 10.2 National snapshot (60-minute LINAC threshold)

At the default 60-minute LINAC ceiling and 30-minute hospital backstop, the current data vintage yields:

| Category | Count |
|---|---:|
| LINAC-gap Walmarts (all) | 347 |
| Viable gap (any hospital ≤ 30 min) | 342 |
| Systemic gap | 5 |
| Viable — nearest backstop is **general acute care** | 251 (**73.4%** of viable) |
| Viable — nearest backstop is **critical access** | 91 (**26.6%** of viable) |

Critical access is ~19% of the national eligible-hospital inventory (§3.3) but ~27% of nearest backstops among viable gaps, because LINAC gaps cluster in rural markets where CAHs are more often the closest acute facility.

### 10.3 Per-state table and store list

The script writes comma-separated and Markdown tables with one row per state that has at least one LINAC-gap Walmart. Columns:

| Column | Meaning |
|---|---|
| `general_acute` | Viable-gap stores whose nearest ≤30 min hospital is `GENERAL ACUTE CARE` |
| `critical_access` | Viable-gap stores whose nearest ≤30 min hospital is `CRITICAL ACCESS` |
| `viable_total` | `general_acute` + `critical_access` (equals viable gap for that state) |
| `systemic` | LINAC-gap stores with no hospital ≤ 30 min |
| `linac_gaps` | All LINAC-gap stores in the state (includes invalid coords) |

It also emits a line-per-store list of all viable-gap Walmarts (name, city, state, backstop type, nearest hospital name, approximate drive minutes).

**How to reproduce**

```bash
node scripts/gap-backstop-hospital-type.js
```

**Outputs** (under `scripts/output/`):

| File | Contents |
|---|---|
| `gap-backstop-analysis.json` | Full machine-readable results (regenerate CSV/MD without OSRM via `--from-json`) |
| `gap-backstop-by-state.csv` / `.md` | State × TYPE counts |
| `viable-gap-walmarts.csv` | All viable-gap stores with hospital detail |
| `viable-gap-walmart-names.txt` | Human-readable name list |

**Runtime and cache.** The script calls the same public OSRM Table service as the server. OSRM responses are cached **in memory for that Node process** (default TTL 7 days). A new terminal invocation starts with a cold cache (~20–30 minutes for a full national run). The running application server maintains a **separate** in-memory cache; warming one does not warm the other. After `gap-backstop-analysis.json` exists, `node scripts/gap-backstop-hospital-type.js --from-json` rebuilds the CSV/Markdown exports instantly.

**Slider note.** The batch script fixes LINAC time at 60 minutes. Changing the in-app LINAC slider changes which stores are LINAC-gap and therefore changes viable counts and TYPE splits; re-run the script (or add a `driveTimeMinutes` parameter in a future revision) to match a non-default threshold.

### 10.4 Population crosswalk (Census Bureau)

Each viable-gap Walmart carries a `city` and `state` in the fixture data. An offline script joins those city–state pairs to **U.S. Census Bureau population estimates** so reviewers can approximate how many people live in the communities behind the gap list.

**How to reproduce**

```bash
node scripts/viable-gap-census-population.js
```

(Requires `scripts/output/gap-backstop-analysis.json` from §10.3.)

**Primary source:** Census Population Estimates Program file `sub-est2024.csv` (July 1, **2024** place estimates, `POPESTIMATE2024`), downloaded on first run to `scripts/cache/`. Incorporated places and New England towns (`SUMLEV` 162 and 061) are matched to Walmart `city` strings after normalizing Census administrative suffixes (`city`, `town`, `CDP`, etc.). A small set of **CDPs and Puerto Rico municipios** not present in that file use **2020 Decennial Census** counts instead (documented in the script as `manual_2020_census`).

**Outputs** (`scripts/output/`):

| File | Contents |
|---|---|
| `viable-gap-walmarts-with-population.csv` | All 342 stores with census place name + population |
| `viable-gap-cities-population.csv` | **322** unique city–state pairs with population and store count |
| `viable-gap-population-summary.json` | Match statistics and deduplicated population total |

**How to interpret the total.** Summing populations across the **322 unique cities** (~3.87M at the current data vintage) is **not** a precise count of people affected by LINAC gaps: Walmart `city` is mailing-address geography (not a census tract), multiple stores in one city are counted once in the city table, and place population ≠ the full trade-area catchment of each store. It is a useful **order-of-magnitude** crosswalk for policy discussion, not a substitute for census-block or catchment analysis.

### 10.5 Tier 2: drive-time catchment population (tract union)

A stronger offline estimate sums **2020 Census tract populations** for residents within a fixed **OSRM drive-time catchment** of each viable-gap Walmart, then **deduplicates** tracts across stores so each tract is counted once in the national total.

**How to reproduce**

```bash
node scripts/viable-gap-catchment-population.js
```

Optional: `CATCHMENT_MINUTES=30` (default), `CATCHMENT_RADIUS_MILES=40` (Haversine prefilter), `CATCHMENT_STORE_LIMIT=5` (smoke test).

**Method (per store)**

1. Resolve store coordinates from `walmart-locations.json` (read-only join on state / name / city / address).
2. Pre-filter **2020 Census tracts** whose internal point lies within `CATCHMENT_RADIUS_MILES` straight-line of the store (Census Bureau `CenPop2020_Mean_TR.txt`, cached under `scripts/cache/`).
3. OSRM Table from store → candidate tract centroids; include tract if drive time ≤ `CATCHMENT_MINUTES` (default **30**, independent of the hospital backstop threshold).
4. **Union** included tract GEOIDs across all stores; sum tract `POPULATION` once per GEOID.

Puerto Rico stores use **2020 municipio population** fallback (tract file covers only the 50 states + DC).

**Outputs** (`scripts/output/`)

| File | Contents |
|---|---|
| `viable-gap-catchment-summary.json` | Union total, naive overlap sum, tract count, Tier 1 comparison |
| `viable-gap-catchment-by-store.csv` | Per-store tract count and catchment population |
| `viable-gap-catchment-tracts-union.csv` | Deduplicated tract list in the national union |

Original datasets under `src/data/` are never modified; all Tier 2 artifacts live under `scripts/output/` and `scripts/cache/`.

**Remaining gaps vs. publication.** Tract **centroids** approximate reachability (not areal intersection of tract polygons with isochrones). Population is **2020 decennial**, not ACS with margins of error. OSRM uses the public demo router. Block-group areal weighting, self-hosted OSRM, and ACS vintage harmonization are the next hardening steps.

---

## 11. Limitations

A reviewer should weigh the following before drawing conclusions from the figures.

1. **OSRM demo dependency.** The public router has no SLA, and the underlying OSM extract date is not pinned by this application. For publication, the OSRM service should be replaced with a self-hosted instance against a recorded OSM extract.

2. **"Hospital" ≠ "cancer-capable hospital."** The hospital backstop set is a proxy for *any* meaningful acute-care facility. Whether a given general-acute or critical-access hospital can actually provide oncology services, infusion therapy, or emergency cancer care is not encoded in the data and is not tested.

3. **LINAC count vs. operating capacity.** The `Number of LINACs` field is a machine count, not a capacity-adjusted measure. A single LINAC at a critical-access cancer center is counted the same as one of several LINACs at a large academic medical center.

4. **Snapshot, not time series.** All three datasets are static. Hospital openings/closings, LINAC deployments, and Walmart store changes after the data vintage are not reflected.

5. **Population proxy.** Walmart stores are used as population access proxies; this is a deliberate methodological choice driven by data availability and rural-population correlation, but it is not a substitute for census-based population analysis. Areas with Walmart presence and areas without are not analyzed equivalently.

6. **OSRM driving profile.** The `driving` profile uses generic car-routing assumptions: no traffic, no time-of-day variation, and default speed assumptions on each road class. Real travel times will vary.

7. **Filter sensitivity.** The 30-minute hospital backstop ceiling is a policy choice, fixed in code (`HOSPITAL_BACKSTOP_MINUTES`). No bed-count filter is applied to hospitals (see §3.3). The LINAC slider threshold is configurable in the UI; the supplementary TYPE report (§10) defaults to 60 minutes unless the script is re-run at another value.

8. **Nearest-hospital TYPE is not clinical capability.** The supplementary split identifies the closest eligible acute or critical-access facility by drive time, not whether that facility can deliver oncology, infusion, or emergency cancer care (see item 2 above).
