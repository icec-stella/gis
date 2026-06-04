# Project overview: Walmart–LINAC GIS analysis

This repository is a **Node.js web application** (package name `walmart-linac-mapper`) that maps **Walmart stores** and **radiation oncology LINAC centers** across the United States and supports **drive-time coverage analysis** via the **OSRM Table service** (road network). The goal is to visualize where Walmart stores fall relative to LINAC facilities and to quantify “gaps”—for example, how many Walmart stores in a state have **no** eligible LINAC within a **maximum drive time** on real roads (**default 60 minutes**), per the rules in [OSRM Table service](#osrm-table-service).

The GitHub remote for this codebase is [icec-stella/gis](https://github.com/icec-stella/gis).

---

## What the product does

1. **Map**  
   - Blue markers: Walmart locations (from `src/data/walmart-locations.json`).  
   - Red markers: LINAC centers (from `src/data/linac-locations.json`).  
   - Base map: OpenStreetMap tiles via [Leaflet](https://leafletjs.com/).  
   - US or state outline: GeoJSON boundaries loaded from [OpenStreetMap Nominatim](https://nominatim.openstreetmap.org/) through the server.

2. **Run analysis**  
   After choosing a state (or “United States”), **max drive time (minutes)** for OSRM, and **Run Analysis**, the app zooms the map, draws the boundary, shows relevant controls, and fetches **state-level metrics** from the API (`/api/metrics`).

3. **Metrics**  
   Gap counts use **OSRM Table driving durations** only (see [OSRM Table service](#osrm-table-service)). For each **state abbreviation** (`state` query) or `US` (aggregated from per-state OSRM runs), the API reports:  
   - **Walmart “gap” count:** Walmart stores in that **store’s state** (`w.state`) that have **no** eligible LINAC destination with drive time **≤** the chosen ceiling (stores with invalid coordinates are counted here).  
   - **Total Walmart stores** in that state.  
   - **LINAC inventory (not OSRM-derived):** count of LINAC **centers** in the state (`States` equals state) and summed **LINAC machines** (`Number of LINACs`).  
   Dashboard and table views pull these figures from **`/api/metrics`**; CSV/JSON export reads the rendered metrics table.

4. **Hide Walmarts**  
   Optionally hides Walmart markers that are within an **approximate straight-line radius** (~50 mph heuristic from the slider minutes) of **any** displayed LINAC marker—**not** OSRM-accurate; useful only for exploratory map thinning. Metrics remain OSRM-backed.

---

## Tech stack

| Layer | Technology |
|--------|------------|
| Server | Express 4, CORS, JSON body parsing, static files from `public/` |
| Frontend | Vanilla JavaScript, Bootstrap 5 (CDN), Leaflet 1.7 (CDN) |
| Data | Static JSON under `src/data/` |
| Geocoding / boundaries | Server-side HTTPS requests to Nominatim (axios); User-Agent `LINAC-App/1.0` |

Dependencies also include packages that are not central to runtime behavior described here (for example some are unused in `server.js`); the effective stack above is what drives the app.

---

## OpenStreetMap (OSM)

The app depends on **OpenStreetMap in two separate ways**. Both are implemented in code; this section pulls them into one place so nothing is buried under “Leaflet” or “Nominatim” alone.

### 1. Map tiles (browser → OSM tile servers)

- **Where:** `public/js/main.js` adds a Leaflet `tileLayer` with URL `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png` and attribution `© OpenStreetMap contributors`.
- **What you see:** The shaded street map behind markers.
- **CSP:** `server.js` allows those tiles in Content-Security-Policy under `img-src` for `https://*.tile.openstreetmap.org` and `https://tile.openstreetmap.org`.
- **Note:** Raster tiles are a **CDN-style** workload; OSMF publishes [_tile usage guidelines_](https://operations.osmfoundation.org/policies/tiles/). For heavy traffic, projects often switch to commercial tile providers or self-hosted caches while keeping OSM attribution as required by the license.

### 2. Nominatim search API (browser → your server → Nominatim)

- **Where:** `server.js` route `GET /api/state-boundary/:state` uses axios to call  
  `https://nominatim.openstreetmap.org/search`  
  with `format=json`, `polygon_geojson=1`, and `countrycodes=us` (and for country-wide, `featuretype=country`). It picks the administrative `boundary` result and returns GeoJSON.
- **What you see:** The blue US outline on first load and the state outlines after **Run Analysis**.
- **CSP:** The **browser** does not call Nominatim directly for boundaries; only the Node server does. Client fetches `/api/state-boundary/...` on the **same origin**, so CSP `connect-src` includes `'self'` and also explicitly allows `https://nominatim.openstreetmap.org` (consistent if any client-side code ever called it).
- **Policy:** Respect the [Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/) (acceptable use, rate limits, identifying `User-Agent`—the server sends `LINAC-App/1.0`). For production scale, cache boundary GeoJSON server-side instead of querying Nominatim on every state change.

Together: **tiles = OSM raster**; **outlines = OSM-derived geometry via Nominatim**. Store locations themselves come from local JSON files, not from OSM search.

---

## OSRM Table service

**Metrics and gap counts** are computed only from Project OSRM Table (see subsections below).

Walmart-vs-LINAC **gap counts** (`walmartsOutsideRange` vs `within`) come **only** from the **Project OSRM Table** service wired in **`server.js`** (`linacRowsForDriveTimeOsrm`, `computeMetricsForStateAbbrev`, `getDriveTimes`, `getDriveTimesSingle`). There is **no** Haversine fallback for those counts.

### API surface and versioning

Project OSRM documents its HTTP API as a **v5-style** surface with paths such as **`/route/v1`**, **`/table/v1`**, and **`/nearest/v1`**—see the [OSRM HTTP API / Table service](http://project-osrm.org/docs/v5.24.0/api/#table-service) for the full parameter reference (this app uses the subset listed below).

This repository hard-codes:

- **Base URL:** `http://router.project-osrm.org/table/v1/driving`  
  - **`table/v1`** — Table service revision segment in the path.  
  - **`driving`** — routing **profile** (car, not foot/bike).  
- **Important:** `router.project-osrm.org` is a **public demo**; the app does **not** pin an OSRM build, graph extract date, or contract SLAs. For publication-grade reproducibility, replace the base URL with a **self-hosted** or vendor OSRM instance and record that stack version.

### HTTP request (single Table call)

One matrix request is built in **`getDriveTimesSingle`**:

1. **Method:** `GET` via axios, **`timeout: 120000`** (ms).
2. **URL path after the base:**  
   `/{lon0},{lat0};{lon1},{lat1};…;{lon_{S+D-1}},{lat_{S+D-1}}`  
   - **Order:** every **Walmart (source)** coordinate appears **first** (indices **0 … S−1**), then every **LINAC (destination)** coordinate (indices **S … S+D−1**), where **S** = `sourceRows.length`, **D** = `destRows.length`.  
   - **Axis order per pair:** **longitude, latitude** (OSRM convention).  
   - **Precision:** each coordinate is serialized as **`Number(value.toFixed(5))`** (five decimal places).
3. **Query string (fixed triple):**
   - **`sources=`** — semicolon-separated indices **`0;1;…;S-1`** (every source row in the matrix).  
   - **`destinations=`** — semicolon-separated indices **`S;S+1;…;S+D-1`** (every destination column).  
   - **`annotations=duration`** — request **travel-time** matrix only (cell values are **seconds**). Distance annotations are **not** requested.

Example shape (abbreviated):

`GET …/table/v1/driving/lon₀,lat₀;…;lon_{S+D-1},lat_{S+D-1}?sources=0;…;S-1&destinations=S;…;S+D-1&annotations=duration`

### Response validation

The client accepts the response only when:

- HTTP status is **200**;  
- JSON **`code`** is **`'Ok'`**;  
- **`durations`** is an **`S × D`** array aligned with **`sources`** / **`destinations`**.

Otherwise axios still resolves but **`getDriveTimesSingle` throws**. **`GET /api/metrics`** catches failures and responds **503** with `{ error: 'Drive-time routing unavailable', message }`.

Successful **`durations[i][j]`** values are finite **seconds**, or **`null`** (see below).

### How `null` cells affect metrics

Per OSRM, a Table cell may be **`null`** when no route duration is returned for that pair.

For each Walmart (**source**) row **`i`**, **`computeMetricsForStateAbbrev`** sets **within ceiling** iff **any** destination column **`j`** satisfies:

`durationsMatrix[i][j] != null && durationsMatrix[i][j] <= driveTimeThresholdSeconds`

So **`null` never counts as “within range.”** A store with **all** columns **`null`** is treated like a **gap** (outside), alongside stores with all finite times above the ceiling.

Sharding (**`getDriveTimes`** when **`S + D`** exceeds **`OSRM_MAX_COORDINATES_PER_REQUEST`**): partial results are merged into a full matrix prefilled with **`null`**. For each shard cell **`val`**, the merge does **`if (val == null) continue`**. If overlapping shards ever wrote multiple finite candidates for one **`(i,j)`**, the code keeps the **smaller** finite value (**`min`**), never replacing a known finite duration with **`null`**.

### Drive-time ceiling (seconds)

**`driveTimeThresholdSeconds`** for **`/api/metrics`** (**`computeMetricsForStateAbbrev`**):

- Prefer **`driveTimeMinutes`** (`parseFloat`; if non-finite, **60**): threshold = **`minutes * 60`**.  
- Else if legacy **`radius`** (miles) is set: **`(miles / 50) * 3600`** (fixed **50 mph** display proxy only).  
- Else default **`3600`** (60 minutes).

### Batching and cache (operational detail)

- **`OSRM_MAX_COORDS_PER_REQUEST`:** parsed from env (default **96**), clamped **[40, 140]** — max **coordinate strings** (**S + D**) in one GET path. Larger problems are tiled; see **`getDriveTimes`** in **`server.js`**.  
- **In-memory Table cache (`node-cache`):** optional (**`OSRM_CACHE_ENABLED`** default on). Cache key **`sha256`** of **`coordPathSegment|sourcesParam|destParam`**; TTL **`OSRM_CACHE_TTL_SECONDS`** (default seven days); optional cap **`OSRM_CACHE_MAX_KEYS`**.  
- **US aggregates:** **`state=US`** runs **the same OSRM semantics per Walmart state** (`w.state`), in parallel batches of **`US_METRICS_STATE_CONCURRENCY`** (default **4**, max **24**)—no single national Table matrix.

### Alaska / Hawaii / Puerto Rico destination rule

Constant **`OSRM_BORDER_ISOLATED_STATES = new Set(['AK','HI','PR'])`**. Function **`linacRowsForDriveTimeOsrm(marketStateAbbr, linacLocations)`** decides which LINAC rows are **Table destinations** (columns) for a given **market** (the **`state`** query / each state in US aggregation):

| Market state **`marketStateAbbr`** | LINAC destinations included |
|------------------------------------|-----------------------------|
| **`AK`**, **`HI`**, or **`PR`** | Only rows with **valid coords** **`and`** **`States === marketStateAbbr`** (within that territory only). |
| Any **other** state (incl. every state summed for **`US`**) | All **valid-coord** LINAC rows **except** those whose `States` field is **AK**, **HI**, or **PR** — cross-border driving is allowed versus other states’ LINACs; isolated territories are excluded as unreachable road-network anchors for mainland gap tests. |

**Sources** remain always Walmart stores **`w.state === marketStateAbbr`**; only the **destination LINAC set** changes by this rule.

### Hospitals (second Table matrix, map layer)

Dataset **`src/data/hospital-locations.json`**: eligible hospitals are **`STATUS` OPEN**, **`TYPE`** ∈ { **`GENERAL ACUTE CARE`**, **`CRITICAL ACCESS`** } (HIFLD facility-care categories), with valid **`LATITUDE`** / **`LONGITUDE`**. The previous filter used **`NAICS_CODE`** **622110** ("general medical and surgical"), but that code is too coarse — it also bundles in children's general, military general, women's, and chronic-disease hospitals. The TYPE-based filter is the precise oncology-backstop set. No bed-count threshold is applied. Net eligible: **5,271** hospitals (4,261 general acute + 1,010 critical access; see [`METHODOLOGY.md`](./METHODOLOGY.md) §3.3). They appear in **`/api/map-data`** as **`hospital`** and on the map as **yellow tear-drop pins** (`marker-icon-yellow.png`), matching Walmart/LINAC icon sizing.

Metrics: **`viableGapWalmarts`** and **`systemicGapWalmarts`** split **LINAC-gap** Walmart locations that have **valid store coordinates**. After the LINAC **`durationsMatrix`** classification (slider-driven `driveTimeThresholdSeconds`), **`getDriveTimes(LINAC-gap stores × hospital destinations)`** runs using a **separate, fixed** **`HOSPITAL_BACKSTOP_THRESHOLD_SECONDS`** = **30 min × 60** — independent of the LINAC slider. Rationale: emergency / inpatient backstop care is only clinically meaningful within a tight time-on-road window, so widening the LINAC search should not also widen what counts as a "reachable hospital." The minute value is returned in each `/api/metrics` response as **`hospitalBackstopMinutes`**, mirrored on the frontend as a constant for table headers that render pre-response. **`hospitalRowsForDriveTimeOsrm`** applies the **identical AK / HI / PR destination isolation** rule on **`h.STATE`**. Rows with **`walmartsOutsideRange`** solely due to **invalid Walmart coordinates** appear **only** in **`walmartsOutsideRange`**; they are **not** included in **`viableGapWalmarts + systemicGapWalmarts`** (that sum equals LINAC-gap count among coord-valid stores in the market state).

---

## Repository layout

```
LINAC/
├── server.js              # Express app, APIs, Nominatim proxy, OSRM Table integration
├── package.json           # Scripts: npm start → node server.js; npm run dev → nodemon
├── public/
│   ├── index.html         # Shell UI: state, radius, buttons, map, modals
│   ├── css/styles.css     # Layout and styling
│   ├── js/main.js         # Leaflet map, markers, analysis UX, metrics table
│   └── images/markers/    # Pin sprites (blue Walmart, red LINAC, yellow hospital)
├── src/data/
│   ├── walmart-locations.json   # Walmart records (state, address, lat/lng)
│   ├── linac-locations.json     # LINAC records (name, Cities, States, lat/lng, counts)
│   └── hospital-locations.json  # HIFLD-style hospitals (optional; OPEN, TYPE ∈ {GENERAL ACUTE CARE, CRITICAL ACCESS}, valid coords)
├── scripts/
│   ├── gap-backstop-hospital-type.js   # Offline OSRM report: viable-gap × nearest hospital TYPE (see METHODOLOGY §10)
│   └── output/                         # Generated CSV/MD/JSON (not committed by default)
├── docs/
│   ├── METHODOLOGY.md      # Scientific methodology (metrics + supplementary TYPE report)
│   └── PROJECT.md          # This file
└── README.md               # Setup, security notes, usage
```

**Note:** `server.js` also loads `./src/data/city-centers.json` for `/api/cities` and optional city filtering in `/api/map-data`. That file is **not present** in a minimal checkout; loads fail gracefully (`[]`). The current `public/index.html` does **not** expose a city `<select>` (though `main.js` still contains `populateCityDropdown` / `updateMapData` wired to `#city`). Treat city-center flow as **server-supported but UI-incomplete** unless you add the file and markup.

---

## How the backend works (`server.js`)

### Middleware and ops

- **CORS**: enabled globally.  
- **Rate limiting**: 100 requests per IP per minute (`express-rate-limit`).  
- **Security headers**: Content-Security-Policy allows OSM tiles/CDNs used by the app; `ALLOWED_IFRAME_DOMAINS` defaults to `*` if unset (`frame-ancestors` and related frame behavior follow that).  
- **Caching**: Responses get `Cache-Control: no-store` via middleware.  
- **Port**: `process.env.PORT` or **5025** locally.

### Data loading

`loadDataFromFile(path)` reads JSON synchronously on each relevant request—simple and always fresh on read, suitable for modest file sizes.

### HTTP API (summary)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Serves `public/index.html` |
| GET | `/api/states` | Sorted unique `state` values from Walmart JSON |
| GET | `/api/cities` | Unique `Cities` from `city-centers.json` (empty if file missing) |
| GET | `/api/map-data` | Query: `radius`, `city`, `initial`. Returns **`{ walmart, cityCenter, linac, hospital }`**. Hospitals: **OPEN**, **TYPE ∈ {GENERAL ACUTE CARE, CRITICAL ACCESS}**, valid coords; Walmarts unfiltered; LINACs filtered to coord-valid rows. |
| GET | `/api/metrics` | Query: **`state`**, **`driveTimeMinutes`** (or legacy **`radius`**) — controls **LINAC** reachability only. Adds **`viableGapWalmarts`** / **`systemicGapWalmarts`** using OSRM to **OPEN hospitals with `TYPE` ∈ {GENERAL ACUTE CARE, CRITICAL ACCESS}**, evaluated at a **fixed 30-min** ceiling (returned as **`hospitalBackstopMinutes`**), regardless of the LINAC slider. **`systemicGapWalmartPins`**: **`{ latitude, longitude, name, … }[]`** aligned with **`systemicGapWalmarts`** for a single **`state`**; for **`state=US`**, **`[]`** (no merged pins). Used on the map for **Systemic gap (OSRM)** markers. |
| GET | `/api/state-boundary/:state` | Returns `[{ geojson }]` from Nominatim for `US` or `"StateName, United States"`. |

Static assets (HTML, JS, CSS, images) are served from `public/`.

---

## How the frontend works (`public/js/main.js`)

### Startup (`DOMContentLoaded` → `initializeApp`)

1. **`initializeMap`** – Creates the Leaflet map, OSM layer, legend, fetches `/api/state-boundary/US`, draws the US outline, then **`loadInitialMarkers`**.  
2. **`loadInitialMarkers`** – `GET /api/map-data?initial=true` with cache-busting; clears marker arrays; adds Walmart markers inside the US GeoJSON bounds; LINAC (**red**) and general acute & critical access hospital (**yellow**, same pin shape as WAL/LINAC) with US bounding-box validation; marker clicks **pan/zoom** the map.  
3. **`populateStateDropdown`** – Loads states, prepends “United States” (`US`), default-selects `US`. Markers load from **`initializeMap`** (not from the dropdown handler).  
4. **`initializeEventListeners`** – Drive-time slider, Run Analysis, toggles, dashboard, table view, modals.

### Run Analysis (`updateAnalysis`)

- Requires a selected state (not empty / not `all`).  
- For **`US`**: removes state layer, shows all markers, resets view, reloads US boundary, calls **`/api/metrics?state=US&driveTimeMinutes=…`**.  
- For a **state**: loads boundary via **`/api/state-boundary/:state`**, fits map (special bounds for Alaska), shows markers, calls **`/api/metrics?state=:abbr&driveTimeMinutes=…`**.  
- Updates the side **location list** using **point-in-polygon** tests against the state GeoJSON (not just bounding boxes).

### Frontend vs backend metrics

- **Dashboard modal** and **metrics table** both load figures from **`/api/metrics`** with the same **`driveTimeMinutes`** query string—**OSRM Table** on the server, including the AK/HI/PR destination rule ([OSRM Table service](#osrm-table-service)).  
- **Hide Walmarts** still uses **great-circle** distance on the map (Leaflet `distanceTo` with a **~50 mph** heuristic from the slider minutes)—**not** OSRM; do not equate that toggle with the API gap count.

### Marker visibility

- **Hide Walmarts**: For each Walmart, if any LINAC marker is within the radius (Leaflet `distanceTo`, converted from meters to miles), the Walmart marker opacity is set to 0.  
- Lists and legends respect `walmartsHidden` and the LINAC/Walmart toggle.

---

## Data models (JSON)

**Walmart** (`walmart-locations.json`):  

- Key fields used in code: `state`, `name`, `street_address`, `city`, `latitude`, `longitude`.

**LINAC** (`linac-locations.json`):  

- Key fields: `LINAC Name`, `Cities`, `States` (state abbreviation), `Latitude`, `Longitude`, `Number of LINACs` (summed for machine counts).

Coordinate fields appear in mixed casing (`latitude`/`longitude` vs `Latitude`/`Longitude`); the codebase follows that split consistently.

---

## Configuration and deployment

- **`PORT`** – Set by hosts such as Render; locally defaults to 5025 (`http://localhost:5025`).  
- **`ALLOWED_IFRAME_DOMAINS`** – CSP `frame-ancestors`; omit or use `*` for permissive embedding; restrict in production if embedding only on known sites.  

The standalone README outlines install (`npm install`), run (`npm start` / `npm run dev`), and user-facing behavior.

---

## Design notes and caveats

1. **`city-centers.json` and `#city`** – Backend and JS anticipate city-level filtering; default UI/repo may not include both pieces—see Repository layout.  
2. **Map “Hide Walmarts” vs OSRM gaps** – The hide toggle approximates proximity on the sphere; **`/api/metrics`** gaps are strictly **drive-time OSRM**.  
3. **Metric naming** – API field **`cityCentersWithinRange`** is a **legacy name**; response value is **LINAC center count for the selected state**, not OSRM reachability-in-range. **`linacsWithinRange`** similarly names **summed LINAC machines in state**, not “within threshold.”  
4. **Nominatim and OSM tiles** – Summarized under [OpenStreetMap (OSM)](#openstreetmap-osm); honour usage policies and cache if you scale traffic.  
5. **OSRM demo dependency** – See [OSRM Table service](#osrm-table-service); swap to your own routing stack for repeatable study runs.

This document reflects the codebase as wired today: Express + Leaflet SPA, JSON datasets, **OSRM Table drive times** for published gap metrics (**OpenStreetMap tiles + Nominatim boundaries**, optional map-only great-circle thinning), and modals for dashboard and exportable metrics tables.
