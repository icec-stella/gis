# Project overview: Walmart–LINAC GIS analysis

This repository is a **Node.js web application** (package name `walmart-linac-mapper`) that maps **Walmart stores** and **radiation oncology LINAC centers** across the United States and supports **distance-based coverage analysis**. The goal is to visualize where Walmarts fall relative to LINAC facilities and to quantify “gaps”—for example, how many Walmarts in a state are **not** within a chosen radius (in miles) of **any** LINAC with valid coordinates.

The GitHub remote for this codebase is [icec-stella/gis](https://github.com/icec-stella/gis).

---

## What the product does

1. **Map**  
   - Blue markers: Walmart locations (from `src/data/walmart-locations.json`).  
   - Red markers: LINAC centers (from `src/data/linac-locations.json`).  
   - Base map: OpenStreetMap tiles via [Leaflet](https://leafletjs.com/).  
   - US or state outline: GeoJSON boundaries loaded from [OpenStreetMap Nominatim](https://nominatim.openstreetmap.org/) through the server.

2. **Run analysis**  
   After choosing a state (or “United States”) and a radius, **Run Analysis** zooms the map, draws the boundary, shows relevant controls, and fetches **state-level metrics** from the API.

3. **Metrics**  
   For the selected **state abbreviation** (or `US` for nationwide Walmart set), the server counts:  
   - Walmarts in that state that have **no** LINAC within the radius (invalid Walmart coordinates are counted as “outside”).  
   - Total Walmarts in the state.  
   - LINAC **centers** in the state (`States` matches) and summed **LINAC machines** (`Number of LINACs`).  
   Dashboard and table views show these figures; CSV/JSON export is available from the table modal.

4. **Hide Walmarts**  
   Optionally hides Walmart markers that **are** within the current radius of **any** displayed LINAC marker, emphasizing locations that remain—useful for “gap” visualization. The legend switches to describe those remaining pins.

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

## Repository layout

```
LINAC/
├── server.js              # Express app, APIs, boundary proxy, Haversine math
├── package.json           # Scripts: npm start → node server.js; npm run dev → nodemon
├── public/
│   ├── index.html         # Shell UI: state, radius, buttons, map, modals
│   ├── css/styles.css     # Layout and styling
│   └── js/main.js         # Leaflet map, markers, analysis UX, metrics table
├── src/data/
│   ├── walmart-locations.json   # Walmart records (state, address, lat/lng)
│   └── linac-locations.json     # LINAC records (name, Cities, States, lat/lng, counts)
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

### Distance

`calculateDistance(lat1, lon1, lat2, lon2)` uses the **Haversine** formula with Earth radius **3958.8 miles**, matching the radius slider (miles) in the UI.

### HTTP API (summary)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Serves `public/index.html` |
| GET | `/api/states` | Sorted unique `state` values from Walmart JSON |
| GET | `/api/cities` | Unique `Cities` from `city-centers.json` (empty if file missing) |
| GET | `/api/map-data` | Query: `radius`, `city`, `initial`. Returns `{ walmart, cityCenter, linac }`. Walmarts are always unfiltered; LINACs are filtered to rows with both coordinates; city centers filter when `initial` is not `true` and `city` is set. |
| GET | `/api/metrics` | Query: `state` (abbr or `US`), `radius`. Walmart/LINAC counts as described in “Metrics” above. |
| GET | `/api/state-boundary/:state` | Returns `[{ geojson }]` from Nominatim for `US` or `"StateName, United States"`. |

Static assets (HTML, JS, CSS, images) are served from `public/`.

---

## How the frontend works (`public/js/main.js`)

### Startup (`DOMContentLoaded` → `initializeApp`)

1. **`initializeMap`** – Creates the Leaflet map, OSM layer, legend, fetches `/api/state-boundary/US`, draws the US outline, then **`loadInitialMarkers`**.  
2. **`loadInitialMarkers`** – `GET /api/map-data?initial=true` with cache-busting; clears marker arrays; adds Walmart markers inside the US GeoJSON bounds; adds LINAC markers with US bounding-box validation; wires LINAC click to draw a **radius circle** in meters (`miles × 1609.34`).  
3. **`populateStateDropdown`** – Loads states, prepends “United States” (`US`), default-selects `US`, then calls **`loadInitialMarkers` again** (markers load twice on cold start—worth knowing if optimizing).  
4. **`initializeEventListeners`** – Radius slider, Run Analysis, toggles, dashboard, table view, modals.

### Run Analysis (`updateAnalysis`)

- Requires a selected state (not empty / not `all`).  
- For **`US`**: removes state layer, shows all markers, resets view, reloads US boundary, calls `/api/metrics?state=US&radius=…`.  
- For a **state**: loads boundary via `/api/state-boundary/:state`, fits map (special bounds for Alaska), shows markers, fetches `/api/metrics?state=:abbr&radius=…`.  
- Updates the side **location list** using **point-in-polygon** tests against the state GeoJSON (not just bounding boxes).

### Frontend vs backend metrics

- **Dashboard modal** metrics come from **`/api/metrics`** (server Haversine, per-state Walmart list vs **all** valid LINACs nationwide for distance checks).  
- **Metrics table** (`populateTableData`) downloads **`/api/map-data?initial=true`** and recomputes per-state and US totals **in the browser** with the same Haversine logic—useful for a full comparison column in one sheet; keep slider radius in sync with what you export.

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
2. **Duplicate marker load** – `initializeMap` and `populateStateDropdown` both trigger full marker reloads unless refactored.  
3. **Metric naming** – API field `cityCentersWithinRange` is a **legacy name** in code comments; response value is **LINAC center count for the selected state**, not “within radius.”  
4. **Nominatim and OSM tiles** – Summarized under [OpenStreetMap (OSM)](#openstreetmap-osm); honour usage policies and cache if you scale traffic.  

This document reflects the codebase as wired today: Express + Leaflet SPA, JSON datasets, Haversine-based proximity, **OpenStreetMap tiles + Nominatim boundaries**, and modals for dashboard and exportable metrics tables.
