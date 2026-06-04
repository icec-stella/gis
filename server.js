const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const https = require('https');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');

// Minimal startup logging
console.log('\n=== LINAC Analysis Server ===');

const app = express();

// Use PORT from environment variable (Render sets this) or default to 5025 for local development
const PORT = process.env.PORT || 5025;

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting to prevent abuse
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // limit each IP to 100 requests per minute
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: 'Too many requests from this IP, please try again later.'
});

// Apply rate limiting to all requests
app.use(limiter);

// Enhanced security headers with Content Security Policy
app.use((req, res, next) => {
  // Get allowed iframe domains from environment variable, default to allowing all for testing
  // Set ALLOWED_IFRAME_DOMAINS in Render dashboard to restrict embedding (e.g., "https://icecancer.org https://*.icecancer.org")
  const allowedIframeDomains = process.env.ALLOWED_IFRAME_DOMAINS || '*';
  
  // Build Content Security Policy
  const cspDirectives = [
    "default-src 'self'",
    "img-src 'self' data: https://*.tile.openstreetmap.org https://tile.openstreetmap.org",
    "script-src 'self' https://cdn.jsdelivr.net https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com",
    "font-src 'self' https://cdn.jsdelivr.net https://unpkg.com",
    "connect-src 'self' https://nominatim.openstreetmap.org https://cdn.jsdelivr.net https://unpkg.com",
    `frame-ancestors ${allowedIframeDomains}`
  ];
  
  res.setHeader('Content-Security-Policy', cspDirectives.join('; '));
  
  // Additional security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // X-Frame-Options based on iframe restrictions
  res.setHeader('X-Frame-Options', allowedIframeDomains === '*' ? 'ALLOWALL' : 'DENY');
  
  next();
});

app.use(express.static('public'));

// Add stronger cache control headers for all responses
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Expires', '-1');
    res.set('Pragma', 'no-cache');
    next();
});

/**
 * Load + parse JSON, cached per absolute path keyed on the file's mtimeMs.
 * Re-reads only when the file changes on disk — preserves edit-and-refresh dev UX
 * without re-parsing multi-megabyte fixtures on every request.
 */
const _jsonFileCache = new Map(); // filePath -> { mtimeMs, parsed }

function loadDataFromFile(relPath, opts) {
    const optional = !!(opts && opts.optional);
    const filePath = path.join(__dirname, String(relPath).replace(/^\.\/+/, ''));
    try {
        const stat = fs.statSync(filePath);
        const cached = _jsonFileCache.get(filePath);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
            return cached.parsed;
        }
        const data = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(data);
        _jsonFileCache.set(filePath, { mtimeMs: stat.mtimeMs, parsed });
        return parsed;
    } catch (error) {
        if (optional && error && error.code === 'ENOENT') {
            return [];
        }
        console.error(`Error loading data from ${filePath}:`, error);
        return [];
    }
}

function parseGeoNumber(v) {
    if (v == null) return NaN;
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    const s = String(v).trim();
    if (s === '') return NaN;
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
}

function isValidLonLat(lat, lon) {
    return (
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180
    );
}

function linacRowHasValidCoords(linac) {
    const lat = parseGeoNumber(linac.Latitude);
    const lon = parseGeoNumber(linac.Longitude);
    return isValidLonLat(lat, lon);
}

function walmartRowHasValidCoords(w) {
    const lat = parseGeoNumber(w.latitude);
    const lon = parseGeoNumber(w.longitude);
    return isValidLonLat(lat, lon);
}

/** Lightweight pin for systemic-gap visualization (validated coords). */
function walmartGeoPinForApi(w) {
    const lat = parseGeoNumber(w.latitude);
    const lon = parseGeoNumber(w.longitude);
    if (!isValidLonLat(lat, lon)) {
        return null;
    }
    return {
        latitude: lat,
        longitude: lon,
        name: w.name != null ? String(w.name) : '',
        street_address: w.street_address != null ? String(w.street_address) : '',
        city: w.city != null ? String(w.city) : '',
        state: w.state != null ? String(w.state) : ''
    };
}

/**
 * OSRM routing for “nearest LINAC” reachability across state lines for the contiguous / connected road network.
 * Alaska, Hawaii, and Puerto Rico are excluded when the **market** state is mainland: distances to those centers cannot
 * represent plausible sub-hour contiguous driving tests. Markets in AK, HI, or PR use **in-state** LINACs only.
 */
const OSRM_BORDER_ISOLATED_STATES = new Set(['AK', 'HI', 'PR']);

function linacRowsForDriveTimeOsrm(marketStateAbbr, linacLocations) {
    if (OSRM_BORDER_ISOLATED_STATES.has(marketStateAbbr)) {
        return linacLocations.filter((l) => linacRowHasValidCoords(l) && l.States === marketStateAbbr);
    }
    return linacLocations.filter(
        (l) => linacRowHasValidCoords(l) && !OSRM_BORDER_ISOLATED_STATES.has(l.States)
    );
}

function hospitalRowHasValidCoords(h) {
    const lat = parseGeoNumber(h.LATITUDE);
    const lon = parseGeoNumber(h.LONGITUDE);
    return isValidLonLat(lat, lon);
}

/**
 * HIFLD facility-care categories eligible as oncology backstop destinations: general acute care
 * + critical access (rural acute care under the federal CAH designation). NAICS 622110 was the
 * previous filter but is too coarse — it lumps in children's general, military general, women's,
 * and chronic-disease hospitals under "general medical & surgical."
 */
const ELIGIBLE_HOSPITAL_TYPES = new Set(['GENERAL ACUTE CARE', 'CRITICAL ACCESS']);

/** Pacific / Caribbean territories in HIFLD with no Walmart footprint — excluded from hospital inventory. */
const EXCLUDED_HOSPITAL_TERRITORY_STATES = new Set(['AS', 'GU', 'MP', 'PW', 'VI']);

function hospitalEligibleType(h) {
    return ELIGIBLE_HOSPITAL_TYPES.has(String(h.TYPE ?? '').trim().toUpperCase());
}

function hospitalTerritoryExcluded(h) {
    return EXCLUDED_HOSPITAL_TERRITORY_STATES.has(String(h.STATE ?? '').trim().toUpperCase());
}

/** Hospitals used for routing + map: OPEN + (general acute care | critical access) + valid coords; no excluded territories. */
function hospitalRowEligibleRoute(h) {
    return (
        !hospitalTerritoryExcluded(h) &&
        hospitalRowHasValidCoords(h) &&
        String(h.STATUS || '').toUpperCase() === 'OPEN' &&
        hospitalEligibleType(h)
    );
}

/** OPEN general acute + critical access hospitals in a state (excludes CLOSED and other TYPEs). */
function hospitalCountForState(stateAbbr, hospitals) {
    if (!Array.isArray(hospitals)) return 0;
    return hospitals.filter((h) => h.STATE === stateAbbr && hospitalRowEligibleRoute(h)).length;
}

/** Distinct STATE codes for eligible hospitals (excludes territory codes with no Walmart footprint). */
function hospitalStateCodesFromFile(hospitals) {
    if (!Array.isArray(hospitals)) return [];
    return [...new Set(hospitals.filter(hospitalRowEligibleRoute).map((h) => h.STATE).filter(Boolean))].sort();
}

/** Same AK / HI / PR destination isolation as LINAC Table anchors. */
function hospitalRowsForDriveTimeOsrm(marketStateAbbr, hospitals) {
    const eligible = hospitals.filter(hospitalRowEligibleRoute);
    if (OSRM_BORDER_ISOLATED_STATES.has(marketStateAbbr)) {
        return eligible.filter((h) => h.STATE === marketStateAbbr);
    }
    return eligible.filter((h) => !OSRM_BORDER_ISOLATED_STATES.has(h.STATE));
}

function geoLatLonFromRow(row) {
    const lat = parseGeoNumber(
        row.latitude != null ? row.latitude : row.Latitude != null ? row.Latitude : row.LATITUDE
    );
    const lon = parseGeoNumber(
        row.longitude != null ? row.longitude : row.Longitude != null ? row.Longitude : row.LONGITUDE
    );
    return { lat, lon };
}

// Add state abbreviation mapping
const stateMapping = {
    'US': 'United States',
    'AL': 'Alabama',
    'AK': 'Alaska',
    'AZ': 'Arizona',
    'AR': 'Arkansas',
    'CA': 'California',
    'CO': 'Colorado',
    'CT': 'Connecticut',
    'DE': 'Delaware',
    'FL': 'Florida',
    'GA': 'Georgia',
    'HI': 'Hawaii',
    'ID': 'Idaho',
    'IL': 'Illinois',
    'IN': 'Indiana',
    'IA': 'Iowa',
    'KS': 'Kansas',
    'KY': 'Kentucky',
    'LA': 'Louisiana',
    'ME': 'Maine',
    'MD': 'Maryland',
    'MA': 'Massachusetts',
    'MI': 'Michigan',
    'MN': 'Minnesota',
    'MS': 'Mississippi',
    'MO': 'Missouri',
    'MT': 'Montana',
    'NE': 'Nebraska',
    'NV': 'Nevada',
    'NH': 'New Hampshire',
    'NJ': 'New Jersey',
    'NM': 'New Mexico',
    'NY': 'New York',
    'NC': 'North Carolina',
    'ND': 'North Dakota',
    'OH': 'Ohio',
    'OK': 'Oklahoma',
    'OR': 'Oregon',
    'PA': 'Pennsylvania',
    'RI': 'Rhode Island',
    'SC': 'South Carolina',
    'SD': 'South Dakota',
    'TN': 'Tennessee',
    'TX': 'Texas',
    'UT': 'Utah',
    'VT': 'Vermont',
    'VA': 'Virginia',
    'WA': 'Washington',
    'WV': 'West Virginia',
    'WI': 'Wisconsin',
    'WY': 'Wyoming'
};

// Add reverse state mapping (full name to abbreviation)
const reverseStateMapping = Object.entries(stateMapping).reduce((acc, [abbr, full]) => {
    if (abbr !== 'US') {  // Skip the US mapping
        acc[full.toUpperCase()] = abbr;
    }
    return acc;
}, {});

// Basic route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

// API Routes
app.get('/api/cities', (req, res) => {
    const cityCenters = loadDataFromFile('./src/data/city-centers.json', { optional: true });
    const cities = [...new Set(cityCenters.map(location => location.Cities))].sort();
    res.json(cities);
});

app.get('/api/map-data', (req, res) => {
    const walmartLocations = loadDataFromFile('./src/data/walmart-locations.json');
    const cityCenters = loadDataFromFile('./src/data/city-centers.json', { optional: true });
    const linacLocations = loadDataFromFile('./src/data/linac-locations.json');
    const hospitalLocations = loadDataFromFile('./src/data/hospital-locations.json', { optional: true });
    const hospitalsForClient = Array.isArray(hospitalLocations)
        ? hospitalLocations.filter(hospitalRowEligibleRoute)
        : [];

    console.log(
        `[Server] Loading fresh data: ${walmartLocations.length} Walmarts, ${linacLocations.length} LINACs, ${hospitalsForClient.length} OPEN general acute & critical access hospitals (TYPE-filtered, valid coords)`
    );
    console.log(`[Server] First LINAC entry: ${JSON.stringify(linacLocations[0]).substring(0, 200)}`);
    console.log(`[Server] Last LINAC entry: ${JSON.stringify(linacLocations[linacLocations.length-1]).substring(0, 200)}`);
    
    const radius = parseFloat(req.query.radius) || 35;
    const city = req.query.city;
    const isInitialLoad = req.query.initial === 'true';

    // Always send all Walmart locations
    let filteredWalmarts = walmartLocations;
    
    // Filter city centers and LINAC locations based on city
    let filteredCityCenters = cityCenters;
    let filteredLinacs = linacLocations.filter(linacRowHasValidCoords);

    if (!isInitialLoad && city && city !== 'all') {
        filteredCityCenters = cityCenters.filter(location => location.Cities === city);
    }

    const result = {
        walmart: filteredWalmarts,
        cityCenter: filteredCityCenters,
        linac: filteredLinacs,
        hospital: hospitalsForClient
    };

    res.json(result);
});

/**
 * Hospital backstop reachability uses a fixed 30-minute drive-time ceiling, independent of the
 * user-selected LINAC slider. Rationale: emergency / inpatient backstop care is only clinically
 * meaningful within a tight time-on-road window — widening the LINAC search to 120+ min should
 * not also widen what counts as a "reachable hospital." Mirrored on the frontend as a JS const
 * (returned in the /api/metrics response so dashboard / pin / popup labels stay in sync).
 */
const HOSPITAL_BACKSTOP_MINUTES = 30;
const HOSPITAL_BACKSTOP_THRESHOLD_SECONDS = HOSPITAL_BACKSTOP_MINUTES * 60;

/** Parallel US aggregation batches (avoid OSRM/demo overload); each batch still small vs one national matrix. */
const US_METRICS_STATE_CONCURRENCY = Math.min(
    24,
    Math.max(1, Number.parseInt(process.env.US_METRICS_STATE_CONCURRENCY || '4', 10) || 4)
);

/**
 * Drive-time “gap” counts (first column): OSRM toward LINAC rows that honor cross-state borders —
 * continental markets see all LINAC anchors except AK/HI/PR; isolated markets see only in-state LINACs.
 * Inventory totals (stores / LINAC centers / LINAC counts) remain state-scoped in the caller.
 */
async function computeMetricsForStateAbbrev(
    stateAbbr,
    walmartLocations,
    linacLocations,
    hospitalLocations,
    driveTimeThresholdSeconds,
    AVG_DRIVE_MPH
) {
    const stateWalmarts = walmartLocations.filter((w) => w.state === stateAbbr);
    const validLinacsForOsrmDest = linacRowsForDriveTimeOsrm(stateAbbr, linacLocations);
    const walmartsWithCoordsForOsrm = stateWalmarts.filter(walmartRowHasValidCoords);

    const needsOsrm = validLinacsForOsrmDest.length > 0 && walmartsWithCoordsForOsrm.length > 0;

    let durationsMatrix = null;
    if (needsOsrm) {
        durationsMatrix = await getDriveTimes(walmartsWithCoordsForOsrm, validLinacsForOsrmDest);
    }

    const radiusMilesForDisplay = (driveTimeThresholdSeconds / 3600) * AVG_DRIVE_MPH;

    console.log(
        `[Server] Calculating metrics for state ${stateAbbr}: drive-time threshold ${Math.round(driveTimeThresholdSeconds)}s (~${radiusMilesForDisplay.toFixed(1)} mi at ${AVG_DRIVE_MPH} mph map approx only)`
    );
    console.log(
        `[Server] State has ${stateWalmarts.length} Walmart locations; ${validLinacsForOsrmDest.length} LINAC rows in OSRM destination set (cross-border except AK/HI/PR isolated)`
    );

    let walmartsOutsideCount = 0;
    let walmartsWithinCount = 0;
    let walmartsInvalidCount = 0;

    if (needsOsrm) {
        console.log(`[Server] Reachability OSRM threshold ${driveTimeThresholdSeconds}s (any qualifying anchor column)`);
    }

    const hospitals = Array.isArray(hospitalLocations) ? hospitalLocations : [];
    const validHospDestOsrm = hospitalRowsForDriveTimeOsrm(stateAbbr, hospitals);
    console.log(
        `[Server] Hospitals in OSRM destination set (OPEN general acute & critical access + border rule): ${validHospDestOsrm.length}`
    );

    const linacGapWalmartsValidCoords = [];
    let rowIndex = 0;
    for (const walmart of stateWalmarts) {
        if (!walmartRowHasValidCoords(walmart)) {
            walmartsOutsideCount++;
            walmartsInvalidCount++;
            continue;
        }

        let isWithinRange = false;

        if (needsOsrm) {
            const row = durationsMatrix[rowIndex];
            rowIndex += 1;
            isWithinRange = Array.isArray(row) && row.some(
                (seconds) => seconds != null && seconds <= driveTimeThresholdSeconds
            );
        }

        if (!isWithinRange) {
            walmartsOutsideCount++;
            linacGapWalmartsValidCoords.push(walmart);
        } else {
            walmartsWithinCount++;
        }
    }

    let viableGapWalmarts = 0;
    let systemicGapWalmarts = 0;
    const systemicGapWalmartPins = [];

    function pushPinForGapWalmart(w) {
        const pin = walmartGeoPinForApi(w);
        if (pin != null) {
            systemicGapWalmartPins.push(pin);
        }
    }

    if (linacGapWalmartsValidCoords.length > 0) {
        if (validHospDestOsrm.length === 0) {
            systemicGapWalmarts = linacGapWalmartsValidCoords.length;
            linacGapWalmartsValidCoords.forEach(pushPinForGapWalmart);
        } else {
            // Hospital backstop uses its own fixed threshold (HOSPITAL_BACKSTOP_THRESHOLD_SECONDS),
            // NOT the slider-driven LINAC threshold. Two clinically distinct questions.
            const hospDurations = await getDriveTimes(linacGapWalmartsValidCoords, validHospDestOsrm);
            for (let gi = 0; gi < linacGapWalmartsValidCoords.length; gi++) {
                const row = hospDurations[gi];
                const nearHospital =
                    Array.isArray(row) &&
                    row.some((seconds) => seconds != null && seconds <= HOSPITAL_BACKSTOP_THRESHOLD_SECONDS);
                if (nearHospital) {
                    viableGapWalmarts += 1;
                } else {
                    systemicGapWalmarts += 1;
                    pushPinForGapWalmart(linacGapWalmartsValidCoords[gi]);
                }
            }
        }
    }

    const stateLinacs = linacLocations.filter((center) => center.States === stateAbbr);
    const totalCenters = stateLinacs.length;
    let totalLinacs = 0;
    stateLinacs.forEach((center) => {
        totalLinacs += parseInt(center['Number of LINACs'], 10) || 0;
    });

    const totalHospitals = hospitalCountForState(stateAbbr, hospitals);

    console.log(`[Server] Metrics results (${stateAbbr}): ${walmartsOutsideCount} Walmarts outside range, ${walmartsWithinCount} within range, ${walmartsInvalidCount} invalid coordinates`);
    console.log(`[Server] State ${stateAbbr} has ${totalCenters} LINAC centers with ${totalLinacs} total LINACs`);

    console.log(
        `[Server] Gap split (${stateAbbr}): viable ${viableGapWalmarts}, systemic ${systemicGapWalmarts} (LINAC-gap valid-coord stores; OSRM ≤ ${HOSPITAL_BACKSTOP_MINUTES} min to nearest general acute or critical access hospital)`
    );

    const gapValid = viableGapWalmarts + systemicGapWalmarts;
    const linacOutsideValid = Math.max(0, walmartsOutsideCount - walmartsInvalidCount);
    if (gapValid !== linacOutsideValid) {
        console.warn(
            `[Server] Gap split sanity (${stateAbbr}): viable+systemic=${gapValid}, linac-outside-valid=${linacOutsideValid}`
        );
    }

    return {
        walmartsOutsideRange: walmartsOutsideCount,
        viableGapWalmarts,
        systemicGapWalmarts,
        systemicGapWalmartPins,
        totalWalmarts: stateWalmarts.length,
        cityCentersWithinRange: totalCenters,
        linacsWithinRange: totalLinacs,
        totalHospitals,
        hospitalBackstopMinutes: HOSPITAL_BACKSTOP_MINUTES
    };
}

app.get('/api/metrics', async (req, res) => {
    const walmartLocations = loadDataFromFile('./src/data/walmart-locations.json');
    const linacLocations = loadDataFromFile('./src/data/linac-locations.json');
    const hospitalLocations = loadDataFromFile('./src/data/hospital-locations.json', { optional: true });

    console.log(
        `[Server] Metrics API - Loading data: ${walmartLocations.length} Walmarts, ${linacLocations.length} LINACs, hospitals file ${Array.isArray(hospitalLocations) ? hospitalLocations.length : 0} rows`
    );

    const stateAbbr = req.query.state;
    const AVG_DRIVE_MPH = 50;

    /** Prefer driveTimeMinutes (true OSRM ceiling). Legacy ?radius= miles uses 50 mph proxy. Default 60 min. */
    let driveTimeThresholdSeconds;
    const dmRaw = req.query.driveTimeMinutes;
    const radiusRaw = req.query.radius;
    if (dmRaw != null && dmRaw !== '') {
        const dm = parseFloat(dmRaw);
        const minutes = Number.isFinite(dm) ? dm : 60;
        driveTimeThresholdSeconds = minutes * 60;
    } else if (radiusRaw != null && radiusRaw !== '') {
        const radiusMiles = parseFloat(radiusRaw);
        const miles = Number.isFinite(radiusMiles) ? radiusMiles : 35;
        driveTimeThresholdSeconds = (miles / AVG_DRIVE_MPH) * 3600;
    } else {
        driveTimeThresholdSeconds = 3600;
    }

    if (!stateAbbr || stateAbbr === '') {
        return res.status(400).json({ error: 'Missing state', message: 'Query parameter state is required (e.g. CA or US).' });
    }

    /** National row: sum state-level metrics (same OSRM semantics as single-state queries). No single huge Table call. */
    if (stateAbbr === 'US') {
        // Union of state codes across both fixtures so inventory in states with no Walmarts
        // (or vice versa) still rolls into the national totals.
        const codes = [...new Set([
            ...walmartLocations.map((w) => w.state),
            ...linacLocations.map((l) => l.States)
        ].filter(Boolean))].sort();
        const totals = {
            walmartsOutsideRange: 0,
            viableGapWalmarts: 0,
            systemicGapWalmarts: 0,
            systemicGapWalmartPins: [],
            totalWalmarts: 0,
            cityCentersWithinRange: 0,
            linacsWithinRange: 0,
            totalHospitals: 0,
            hospitalBackstopMinutes: HOSPITAL_BACKSTOP_MINUTES
        };

        console.log(
            `[Server] US metrics — aggregating ${codes.length} state-level OSRM runs (parallelism ${US_METRICS_STATE_CONCURRENCY})`
        );

        try {
            for (let i = 0; i < codes.length; i += US_METRICS_STATE_CONCURRENCY) {
                const chunk = codes.slice(i, i + US_METRICS_STATE_CONCURRENCY);
                const chunkResults = await Promise.all(
                    chunk.map((code) =>
                        computeMetricsForStateAbbrev(
                            code,
                            walmartLocations,
                            linacLocations,
                            hospitalLocations,
                            driveTimeThresholdSeconds,
                            AVG_DRIVE_MPH
                        )
                    )
                );
                for (const m of chunkResults) {
                    totals.walmartsOutsideRange += m.walmartsOutsideRange;
                    totals.viableGapWalmarts += m.viableGapWalmarts || 0;
                    totals.systemicGapWalmarts += m.systemicGapWalmarts || 0;
                    totals.totalWalmarts += m.totalWalmarts;
                    totals.cityCentersWithinRange += m.cityCentersWithinRange;
                    totals.linacsWithinRange += m.linacsWithinRange;
                }
            }
            totals.totalHospitals = Array.isArray(hospitalLocations)
                ? hospitalLocations.filter(hospitalRowEligibleRoute).length
                : 0;
            console.log('[Server] US aggregate metrics computed from state sums.');
            return res.json(totals);
        } catch (err) {
            console.error('[Server] OSRM metrics failed (US aggregate):', err.message || err);
            return res.status(503).json({
                error: 'Drive-time routing unavailable',
                message: err.message || String(err)
            });
        }
    }

    try {
        const result = await computeMetricsForStateAbbrev(
            stateAbbr,
            walmartLocations,
            linacLocations,
            hospitalLocations,
            driveTimeThresholdSeconds,
            AVG_DRIVE_MPH
        );
        return res.json(result);
    } catch (err) {
        console.error('[Server] OSRM metrics failed:', err.message || err);
        return res.status(503).json({
            error: 'Drive-time routing unavailable',
            message: err.message || String(err)
        });
    }
});

app.get('/api/states', (req, res) => {
    const walmartLocations = loadDataFromFile('./src/data/walmart-locations.json');
    const hospitalLocations = loadDataFromFile('./src/data/hospital-locations.json', { optional: true });

    // Walmart-driven analysis states, plus any hospital-only territories in the fixture.
    const statesFromData = [
        ...new Set([
            ...walmartLocations.map((location) => location.state),
            ...hospitalStateCodesFromFile(hospitalLocations)
        ].filter(Boolean))
    ].sort();

    res.json(statesFromData);
});

/** Eligible hospital inventory: OPEN + general acute / critical access (+ valid coords), grouped by STATE. */
app.get('/api/hospital-inventory', (req, res) => {
    const hospitals = loadDataFromFile('./src/data/hospital-locations.json', { optional: true });
    if (!Array.isArray(hospitals)) {
        return res.json({ total: 0, byState: {} });
    }
    const byState = {};
    let total = 0;
    for (const h of hospitals) {
        if (!hospitalRowEligibleRoute(h)) continue;
        const code = h.STATE;
        if (!code) continue;
        byState[code] = (byState[code] || 0) + 1;
        total += 1;
    }
    res.json({ total, byState });
});

/**
 * State / country administrative boundaries from Nominatim are effectively immutable; cache them
 * aggressively so repeat Run-Analysis clicks don't re-hit the Nominatim API (usage-policy risk
 * + slow UX). Only successful lookups are cached — failures retry on next request.
 */
const STATE_BOUNDARY_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
const stateBoundaryCache = new NodeCache({ stdTTL: STATE_BOUNDARY_TTL_SEC, useClones: false });

app.get('/api/state-boundary/:state', async (req, res) => {
    const state = req.params.state;
    const cacheKey = String(state || '').toUpperCase();

    const cachedGeojson = cacheKey ? stateBoundaryCache.get(cacheKey) : undefined;
    if (cachedGeojson !== undefined) {
        return res.json([{ geojson: cachedGeojson }]);
    }

    let stateName = stateMapping[state] || state;

    try {
        // Special case for US
        if (state === 'US') {
            stateName = 'United States';
            const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=United States&format=json&polygon_geojson=1&countrycodes=us&featuretype=country`;
            
            const response = await axios.get(nominatimUrl, {
                headers: {
                    'User-Agent': 'LINAC-App/1.0',
                    'Accept': 'application/json'
                }
            });
            
            const nominatimData = response.data;
            
            if (!nominatimData || nominatimData.length === 0) {
                return res.status(404).json({ error: 'US Boundary not found' });
            }
            
            const boundaryData = nominatimData.find(item => 
                item.class === 'boundary' && 
                item.type === 'administrative' && 
                item.geojson
            );
            
            if (!boundaryData || !boundaryData.geojson) {
                return res.status(404).json({ error: 'US Boundary not found' });
            }

            stateBoundaryCache.set(cacheKey, boundaryData.geojson);
            return res.json([{ geojson: boundaryData.geojson }]);
        }

        // For individual states, use Nominatim instead of Overpass for more reliable results
        const fullStateName = stateName;
        const stateQuery = `${fullStateName}, United States`;
        const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(stateQuery)}&format=json&polygon_geojson=1&countrycodes=us`;

        console.log(`[Server] Fetching boundary for state: ${state} (${fullStateName}) — cache miss`);
        
        const response = await axios.get(nominatimUrl, {
            headers: {
                'User-Agent': 'LINAC-App/1.0',
                'Accept': 'application/json'
            }
        });
        
        const nominatimData = response.data;
        
        if (!nominatimData || nominatimData.length === 0) {
            console.error(`[Server] No boundary found for state: ${state}`);
            return res.status(404).json({ error: 'Boundary not found' });
        }
        
        // Find the administrative boundary for the state
        const boundaryData = nominatimData.find(item => 
            item.class === 'boundary' && 
            item.type === 'administrative' &&
            item.geojson
        );
        
        if (!boundaryData || !boundaryData.geojson) {
            console.error(`[Server] No valid boundary data found for state: ${state}`);
            return res.status(404).json({ error: 'Boundary not found' });
        }

        stateBoundaryCache.set(cacheKey, boundaryData.geojson);
        return res.json([{ geojson: boundaryData.geojson }]);
    } catch (error) {
        console.error('Error fetching state boundary:', error);
        res.status(500).json({ error: 'Failed to fetch state boundary' });
    }
});

// -----------------------------------------------------------------------------
// OSRM Table API — drive durations (metrics use this exclusively; no Haversine fallback).
// -----------------------------------------------------------------------------
const OSRM_TABLE_BASE_URL = 'http://router.project-osrm.org/table/v1/driving';

/**
 * Max coordinates encoded in ONE Table GET URL path. Official OSRM allows ~100; nginx on the public
 * demo often returns **414 URI Too Long** well before coordinate-count limits — keep shards small.
 * Override with OSRM_MAX_COORDS_PER_REQUEST (clamp 40–140; try raising only if your host allows long URIs).
 */
const _envMaxCoords = Number.parseInt(process.env.OSRM_MAX_COORDS_PER_REQUEST || '96', 10);
const OSRM_MAX_COORDINATES_PER_REQUEST = Number.isFinite(_envMaxCoords)
    ? Math.min(140, Math.max(40, _envMaxCoords))
    : 96;

const OSRM_CACHE_ENABLED = !/^0|false|no$/i.test(String(process.env.OSRM_CACHE_ENABLED || '1'));
const OSRM_CACHE_TTL_SEC = Number.parseInt(process.env.OSRM_CACHE_TTL_SECONDS || '604800', 10); // default 7d
/** Omit or `-1`: no max (needed for nationwide OSRM shards). Set OSRM_CACHE_MAX_KEYS to cap keys if memory is tight. */
const _envOsrmMaxKeys = process.env.OSRM_CACHE_MAX_KEYS;
let OSRM_CACHE_MAX_KEYS = -1;
if (_envOsrmMaxKeys != null && String(_envOsrmMaxKeys).trim() !== '') {
    const n = Number.parseInt(String(_envOsrmMaxKeys), 10);
    if (Number.isFinite(n) && n > 0) {
        OSRM_CACHE_MAX_KEYS = Math.min(n, 10_000_000);
    }
}

/** In-memory OSRM Table response cache (per coordinate batch); avoids repeat HTTP for identical shards. */
const osrmTableCache = new NodeCache({
    stdTTL: OSRM_CACHE_TTL_SEC,
    maxKeys: OSRM_CACHE_MAX_KEYS,
    useClones: false
});

function buildOsrmTableCacheKey(coordPathSegment, sourcesParam, destParam) {
    return crypto
        .createHash('sha256')
        .update(`${coordPathSegment}|${sourcesParam}|${destParam}`, 'utf8')
        .digest('hex');
}

/**
 * Single OSRM Table call: durations[i][j] = seconds from source i to destination j (or null).
 * Coordinates path uses lon,lat (OSRM order). Walmart JSON uses latitude/longitude (lowercase);
 * LINAC JSON uses Latitude/Longitude; hospital JSON LATITUDE/LONGITUDE — unified via geoLatLonFromRow.
 */
async function getDriveTimesSingle(sourceRows, destRows) {
    const coords = [];

    for (let i = 0; i < sourceRows.length; i++) {
        const w = sourceRows[i];
        const { lat, lon } = geoLatLonFromRow(w);
        if (!isValidLonLat(lat, lon)) {
            throw new Error(`Invalid source coordinates at index ${i}`);
        }
        coords.push(`${Number(lon.toFixed(5))},${Number(lat.toFixed(5))}`);
    }

    for (let j = 0; j < destRows.length; j++) {
        const dest = destRows[j];
        const { lat, lon } = geoLatLonFromRow(dest);
        if (!isValidLonLat(lat, lon)) {
            throw new Error(`Invalid destination coordinates at index ${j}`);
        }
        coords.push(`${Number(lon.toFixed(5))},${Number(lat.toFixed(5))}`);
    }

    const coordPathSegment = coords.join(';');
    const numSources = sourceRows.length;
    const sourcesParam = [...Array(numSources).keys()].join(';');
    const destParam = [...Array(destRows.length).keys()].map((k) => numSources + k).join(';');
    const url = `${OSRM_TABLE_BASE_URL}/${coordPathSegment}?sources=${sourcesParam}&destinations=${destParam}&annotations=duration`;

    const cacheKey = buildOsrmTableCacheKey(coordPathSegment, sourcesParam, destParam);
    if (OSRM_CACHE_ENABLED) {
        const hit = osrmTableCache.get(cacheKey);
        if (hit !== undefined) {
            return hit;
        }
    }

    const res = await axios.get(url, { timeout: 120000, validateStatus: () => true });
    const data = res.data;

    if (res.status !== 200 || !data || data.code !== 'Ok' || !Array.isArray(data.durations)) {
        throw new Error(`OSRM Table error (${res.status}): ${data && data.code ? data.code : 'invalid body'}`);
    }

    const { durations } = data;
    if (durations.length !== numSources) {
        throw new Error('OSRM durations row dimension mismatch');
    }
    for (let r = 0; r < durations.length; r++) {
        if (!Array.isArray(durations[r]) || durations[r].length !== destRows.length) {
            throw new Error('OSRM durations column dimension mismatch');
        }
    }

    if (OSRM_CACHE_ENABLED) {
        try {
            osrmTableCache.set(cacheKey, durations);
        } catch (err) {
            console.warn('[OSRM] Table cache write failed — metrics OK, cache skipped:', err.message || err);
        }
    }

    return durations;
}

/**
 * Build full duration matrix sources × destinations, batching to respect OSRM_MAX_COORDINATES_PER_REQUEST.
 * Tile when sources+destinations exceed OSRM_MAX_COORDINATES_PER_REQUEST (URL-safe for public demo),
 * preserving min duration where a grid cell is accidentally covered twice.
 */
async function getDriveTimes(sources, destinations) {
    if (sources.length === 0) {
        return [];
    }
    if (destinations.length === 0) {
        return [];
    }

    const MAX = OSRM_MAX_COORDINATES_PER_REQUEST;
    const nRows = sources.length;
    const nCols = destinations.length;

    if (nRows + nCols <= MAX) {
        return await getDriveTimesSingle(sources, destinations);
    }

    const matrix = sources.map(() => new Array(nCols).fill(null));

    /** Keep source shards small — longitudes/latitudes in the URL add up faster than counting coordinates. */
    const sShardCap = Math.min(36, MAX - 1);
    const sShard = Math.min(Math.max(1, nRows), sShardCap);
    const dShard = Math.min(nCols, MAX - sShard);

    for (let si = 0; si < nRows; si += sShard) {
        const sPart = sources.slice(si, si + sShard);
        for (let dj = 0; dj < nCols; dj += dShard) {
            const dPart = destinations.slice(dj, dj + dShard);
            if (sPart.length + dPart.length > MAX) {
                throw new Error('OSRM shard geometry error');
            }
            const sub = await getDriveTimesSingle(sPart, dPart);
            for (let i = 0; i < sPart.length; i++) {
                for (let j = 0; j < dPart.length; j++) {
                    const val = sub[i][j];
                    if (val == null) continue;
                    const prev = matrix[si + i][dj + j];
                    if (prev == null || val < prev) {
                        matrix[si + i][dj + j] = val;
                    }
                }
            }
        }
    }

    return matrix;
}

// Start the server when launched directly (`node server.js`), not when required by tests.
module.exports = {
    app,
    getDriveTimes,
    loadDataFromFile,
    linacRowsForDriveTimeOsrm,
    linacRowHasValidCoords,
    walmartRowHasValidCoords,
    hospitalRowsForDriveTimeOsrm,
    hospitalRowEligibleRoute,
    hospitalCountForState,
    hospitalStateCodesFromFile,
    hospitalEligibleType,
    HOSPITAL_BACKSTOP_MINUTES,
    HOSPITAL_BACKSTOP_THRESHOLD_SECONDS,
    geoLatLonFromRow
};

/**
 * Startup-time check: flag any state-like code in the data files that isn't a recognized
 * 2-letter abbreviation. Catches cases like `States: "Kentucky"` that silently drop inventory
 * from per-state and US-aggregate metrics.
 */
const RECOGNIZED_STATE_CODES = new Set([
    ...Object.keys(stateMapping).filter((c) => c !== 'US'),
    'DC', 'PR', 'VI', 'GU', 'MP', 'AS'
]);

function warnOnUnknownStateCodes() {
    const walmarts = loadDataFromFile('./src/data/walmart-locations.json');
    const linacs = loadDataFromFile('./src/data/linac-locations.json');
    const hospitals = loadDataFromFile('./src/data/hospital-locations.json', { optional: true });

    const seen = new Map(); // code -> [sources]
    const note = (code, src) => {
        if (code == null || code === '') return;
        if (!RECOGNIZED_STATE_CODES.has(code)) {
            if (!seen.has(code)) seen.set(code, new Set());
            seen.get(code).add(src);
        }
    };
    walmarts.forEach((w) => note(w.state, 'walmart-locations.json:state'));
    linacs.forEach((l) => note(l.States, 'linac-locations.json:States'));
    if (Array.isArray(hospitals)) {
        hospitals.forEach((h) => note(h.STATE, 'hospital-locations.json:STATE'));
    }

    if (seen.size === 0) {
        console.log('[Data] State codes validated — all values are recognized 2-letter codes.');
        return;
    }
    for (const [code, sources] of seen) {
        console.warn(
            `[Data] Unrecognized state code ${JSON.stringify(code)} found in ${[...sources].join(', ')} — this row will be dropped from per-state and US metrics.`
        );
    }
}

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`[OSRM] Table batch size (coordinates per GET): ${OSRM_MAX_COORDINATES_PER_REQUEST}`);
        if (OSRM_CACHE_ENABLED) {
            const maxKeysLabel =
                OSRM_CACHE_MAX_KEYS === -1 ? 'maxKeys unlimited' : `maxKeys ${OSRM_CACHE_MAX_KEYS}`;
            console.log(
                `[OSRM] Table cache enabled — TTL ${OSRM_CACHE_TTL_SEC}s, ${maxKeysLabel} (env: OSRM_CACHE_ENABLED, OSRM_CACHE_TTL_SECONDS, OSRM_CACHE_MAX_KEYS)`
            );
        } else {
            console.log('[OSRM] Table cache disabled (OSRM_CACHE_ENABLED=0|false)');
        }
        if (process.env.PORT) {
            console.log(`Ready for iframe embedding on Render`);
        }
        warnOnUnknownStateCodes();
    });
}
