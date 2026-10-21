# Walmart-LINAC Analysis Tool

This is a web-based mapping tool that analyzes how far Walmart stores are from LINAC (radiation therapy) centers across the United States, using real road-network drive times. It shows Walmart, LINAC, and hospital locations on an interactive map and identifies coverage gaps: Walmart locations with no LINAC within a chosen drive time.

For architecture and API details see [`docs/PROJECT.md`](docs/PROJECT.md); for how the metrics are defined and computed see [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md).

## Features

-   **Interactive Map**: Displays Walmart stores, LINAC centers, and hospitals (general acute care and critical access) on a map of the United States.
-   **State-based Filtering**: Analyze the whole US or a single state, with its boundary drawn on the map.
-   **Drive-Time Analysis**: Set a maximum drive time (15–180 minutes, default 60) and compute gaps using [OSRM](https://project-osrm.org/) road-network routing — not straight-line distance.
-   **Gap Classification**:
    -   **Viable gaps**: Walmarts with no LINAC in range, but a qualifying hospital within ~30 minutes (a possible host site for a future LINAC).
    -   **Systemic gaps**: Walmarts with neither a LINAC nor a qualifying hospital in range.
-   **Map Layers**: Toggle Walmarts, Hospitals, LINAC Centers, and LINAC Gaps on or off.
-   **Metrics Dashboard and Table**: Per-state statistics, including gap counts and LINAC inventory.
-   **Data Export**: Download the metrics table in CSV and JSON formats.

## Tech Stack

-   **Frontend**: HTML, CSS, JavaScript, [Bootstrap](https://getbootstrap.com/), [Leaflet.js](https://leafletjs.com/)
-   **Backend**: [Node.js](https://nodejs.org/) 22.x, [Express.js](https://expressjs.com/)
-   **Routing**: [OSRM Table service](https://project-osrm.org/docs/v5.24.0/api/#table-service) (public demo server) for drive times
-   **Maps**: [OpenStreetMap](https://www.openstreetmap.org/) tiles, and state boundaries from Nominatim
-   **Data**: Location data is stored in JSON files under `src/data/`.

## Setup and Installation

### Prerequisites

-   **Node.js 22.x**: You'll need Node.js to run the server. If you don't have it, you can [download it here](https://nodejs.org/en/download/).
-   **A Code Editor**: We recommend using a modern code editor like [Cursor](https://cursor.sh/) or [VS Code](https://code.visualstudio.com/) for a better experience.

### Installation

Before you begin, please ensure you have completed the steps in the **Prerequisites** section above.

1.  **Clone the repository:**

    One way to get the code is by using your code editor to clone the repository. In Cursor or VS Code, open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`) and type `Git: Clone`. Paste the following URL when prompted:

    ```
    https://github.com/icec-stella/gis.git
    ```

    Alternatively, you can use the terminal or command prompt:
    ```bash
    git clone https://github.com/icec-stella/gis.git
    cd gis
    ```

2.  **Install dependencies:**

    Run the following command in the root directory of the project:

    ```bash
    npm install
    ```

    `node_modules/` is not committed to the repository; it is always created by `npm install` from `package-lock.json`.

### Running the Application

1.  **Start the server:**

    To start the application, run the following command from the root directory:

    ```bash
    npm start
    ```

    This will start the Node.js server.

2.  **Access the application:**

    Open your web browser, such as Google Chrome or Microsoft Edge, and navigate to:

    ```
    http://localhost:5025
    ```

The app needs an internet connection: drive times come from the public OSRM server, and map tiles and state boundaries come from OpenStreetMap.

### Development

If you plan on making changes to the code, we recommend running the server with `nodemon`. This will automatically restart the server whenever a file is saved, so you don't have to do it manually.

```bash
npm run dev
```

### Tests

```bash
npm test
```

Integration tests check `/api/metrics` for ten representative states against the live OSRM server. They require network access and take around 5 minutes. Set `SKIP_OSRM_METRICS_TESTS=1` to skip them.

## Deployment

The app runs on any Node.js host:

-   **Build Command**: `npm install`
-   **Start Command**: `npm start`
-   **Node version**: 22.x (set by `engines` in `package.json`)
-   **Environment**: set `ALLOWED_IFRAME_DOMAINS` (see [Security](#security)). `PORT` is read from the environment and defaults to 5025.

## Security

This application includes several security features to protect against abuse and ensure safe operation:

- **Content Security Policy (CSP)**: Restricts resource loading to trusted sources, preventing XSS attacks and unauthorized resource access
- **Rate Limiting**: Limits requests to 100 per minute per IP address to prevent abuse and DDoS attacks
- **Iframe Domain Restrictions**: Controlled by the `ALLOWED_IFRAME_DOMAINS` environment variable. If it is not set, the app can be embedded on **any** site, so set it in production (e.g. `https://iceccancer.org https://*.iceccancer.org`)
- **Security Headers**: Includes `X-Content-Type-Options` and `X-Frame-Options` headers for additional browser-level protection

### Environment Variables

All are optional.

- `PORT`: Server port (default: `5025`)
- `ALLOWED_IFRAME_DOMAINS`: Space-separated list of sites allowed to embed the app in an iframe (default: `*`, any site)
- `OSRM_MAX_COORDS_PER_REQUEST`: Max coordinates per OSRM request; larger queries are split (default: `96`, range 40–140)
- `OSRM_CACHE_ENABLED`: In-memory cache of OSRM responses (default: on)
- `OSRM_CACHE_TTL_SECONDS`: How long cached OSRM responses are kept (default: 7 days)
- `OSRM_CACHE_MAX_KEYS`: Optional cap on the number of cached OSRM responses
- `US_METRICS_STATE_CONCURRENCY`: How many states are computed in parallel for US-wide metrics (default: `4`, max 24)

## How to Use

1.  **Select a State**: Use the dropdown menu on the left to choose the United States or a single state.

2.  **Set the Drive Time**: Use the slider to set the maximum drive time in minutes.

3.  **Run Analysis**: Click "Run Analysis". The map zooms to the selection, and LINAC gaps are shown as viable (hospital within ~30 minutes) or systemic (no hospital in range). The legend shows the count for each layer.

4.  **Toggle Layers**: Use the **Map Layers** checkboxes to show or hide Walmarts, Hospitals, LINAC Centers, and LINAC Gaps.

5.  **View Metrics**: Click "Dashboard" for a summary of the selected area, or "View Table" for per-state metrics.

6.  **Download Data**: From the table view, you can download the metrics in CSV or JSON format.

## Data Sources

The application uses the following data files located in `src/data/`:

-   `walmart-locations.json`: Contains the locations of Walmart stores.
-   `linac-locations.json`: Contains the locations of LINAC facilities and their number of LINAC machines.
-   `hospital-locations.json`: Hospital records (HIFLD). Open hospitals with type General Acute Care or Critical Access are used as possible LINAC host sites.

## Analysis Scripts

Offline reports in `scripts/` (run with `node scripts/<name>.js`). Generated files go to `scripts/output/`, which is not committed. See [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) §10 for details.

-   `gap-backstop-hospital-type.js`: For each viable-gap Walmart, the type of its nearest qualifying hospital (general acute vs critical access).
-   `viable-gap-census-population.js`: Viable-gap Walmarts matched to Census city population (requires the output of `gap-backstop-hospital-type.js`).
-   `viable-gap-catchment-population.js`: Population within 30-minute drive-time areas around viable-gap Walmarts.
-   `linac-gaps-nearest-hospital.js`: LINAC-gap Walmarts with their nearest qualifying hospital and drive time, for one state or the whole US (`--state`, `--linac-minutes`).
-   `texas-linac-gaps-nearest-hospital.js`: Texas-only version of the above.
-   `compare-linac-hospital-overlap.js`: How many LINAC centers overlap (by location or name) with hospitals in the hospital dataset.
