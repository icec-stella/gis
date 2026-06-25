// Global variables
let map;
let walmartMarkers = [];
let linacMarkers = [];
let hospitalMarkers = [];
let stateLayer;
let usBoundaryLayer;
let legendControl; // Add global reference to legend control
/** Whether per-state OSRM gap classification has been computed for the current state + drive time. */
let gapsComputed = false;
/** OSRM gap pin keys from the latest /api/metrics response (lat,lng at 7 dp). */
let osrmLinacGapPinKeys = null;
let osrmSystemicGapPinKeys = null;
/** Counts + context from the latest gap classification (drive the dynamic legend + popups). */
let gapViableCount = 0;
let gapSystemicCount = 0;
let gapContextMinutes = null;
let gapContextHospMin = null;

/**
 * Fixed hospital backstop drive-time ceiling — must match server.js HOSPITAL_BACKSTOP_MINUTES.
 * Used for table headers / CSV labels that render before any /api/metrics response arrives;
 * live responses also carry it as `metrics.hospitalBackstopMinutes` (preferred where available).
 */
const HOSPITAL_BACKSTOP_MINUTES = 30;

function getDriveTimeMinutes() {
    const el = document.getElementById('max-drive-minutes');
    if (!el) return 60;
    const v = parseFloat(el.value, 10);
    return Number.isFinite(v) ? v : 60;
}

/** Shared dashboard modal grid (LINAC gaps + viable/systemic splits + inventory). */
function formatDashboardCardsHTML(metrics, minutes) {
    const m = metrics || {};
    const hospMin = Number.isFinite(m.hospitalBackstopMinutes) ? m.hospitalBackstopMinutes : HOSPITAL_BACKSTOP_MINUTES;
    return `
        <div class="metric-card">
            <div class="metric-value">${m.walmartsOutsideRange || 0}</div>
            <div class="metric-label">No LINAC within ${minutes} min (OSRM)</div>
        </div>
        <div class="metric-card">
            <div class="metric-value">${m.viableGapWalmarts || 0}</div>
            <div class="metric-label">Viable gap — no LINAC, general acute or critical access hospital ≤ ${hospMin} min (OSRM)</div>
        </div>
        <div class="metric-card">
            <div class="metric-value">${m.systemicGapWalmarts || 0}</div>
            <div class="metric-label">Systemic gap — no LINAC, no general acute or critical access hospital within ${hospMin} min</div>
        </div>
        <div class="metric-card">
            <div class="metric-value">${m.totalWalmarts || 0}</div>
            <div class="metric-label">Total Walmarts in State</div>
        </div>
        <div class="metric-card">
            <div class="metric-value">${m.cityCentersWithinRange || 0}</div>
            <div class="metric-label">LINAC Centers in State</div>
        </div>
        <div class="metric-card">
            <div class="metric-value">${m.linacsWithinRange || 0}</div>
            <div class="metric-label">Total LINACs in State</div>
        </div>
    `;
}

/** Pan/zoom to a point when a location is selected from the map or list (no drive-time circle). */
function flyMapTo(latLng, preferredZoom = 12) {
    if (!map || !latLng) return;
    const z = Math.max(preferredZoom, map.getZoom());
    map.flyTo(latLng, z, { animate: true, duration: 0.35 });
}

const blueMarkerIcon = L.icon({
    iconUrl: '/images/markers/marker-icon-blue.png',
    iconSize: [12, 20],
    iconAnchor: [6, 20],
    popupAnchor: [1, -17]
});

const redMarkerIcon = L.icon({
    iconUrl: '/images/markers/marker-icon-red.png',
    iconSize: [12, 20],
    iconAnchor: [6, 20],
    popupAnchor: [1, -17]
});

const yellowMarkerIcon = L.icon({
    iconUrl: '/images/markers/marker-icon-yellow.png',
    iconSize: [12, 20],
    iconAnchor: [6, 20],
    popupAnchor: [1, -17]
});

// Marker stacking priority (added to Leaflet's latitude-based z-index): systemic gaps on top, hospitals at bottom.
const Z_INDEX_SYSTEMIC = 4000;
const Z_INDEX_GAP = 3000;
const Z_INDEX_WALMART = 2000;
const Z_INDEX_LINAC = 1000;
const Z_INDEX_HOSPITAL = 0;

const greenMarkerIcon = L.icon({
    iconUrl: '/images/markers/marker-icon-green.png',
    iconSize: [12, 20],
    iconAnchor: [6, 20],
    popupAnchor: [1, -17]
});

const orangeMarkerIcon = L.icon({
    iconUrl: '/images/markers/marker-icon-orange.png',
    iconSize: [12, 20],
    iconAnchor: [6, 20],
    popupAnchor: [1, -17]
});

const violetMarkerIcon = L.icon({
    iconUrl: '/images/markers/marker-icon-violet.png',
    iconSize: [12, 20],
    iconAnchor: [6, 20],
    popupAnchor: [1, -17]
});

function escapePopupText(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
}

function pinCoordKey(lat, lng) {
    return `${Number(lat).toFixed(7)},${Number(lng).toFixed(7)}`;
}

function buildLinacGapPinKeySet(pins) {
    const set = new Set();
    if (!Array.isArray(pins)) {
        return set;
    }
    for (const p of pins) {
        if (Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) {
            set.add(pinCoordKey(p.latitude, p.longitude));
        }
    }
    return set;
}

/** Current state of the four map-layer toggles. `gaps` is only effective once gaps are computed. */
function getLayerState() {
    const gapsToggle = document.getElementById('layer-gaps');
    return {
        walmarts: !!document.getElementById('layer-walmarts')?.checked,
        hospitals: !!document.getElementById('layer-hospitals')?.checked,
        linac: !!document.getElementById('layer-linac')?.checked,
        gaps: !!(gapsToggle && gapsToggle.checked && !gapsToggle.disabled && gapsComputed)
    };
}

/**
 * Tag every Walmart marker with its OSRM gap classification from a /api/metrics response.
 * Systemic gaps (no LINAC + no hospital backstop) are a subset of LINAC gaps. The visual
 * representation (icon/visibility) is applied separately by applyLayerVisibility().
 */
function classifyWalmartGaps(metrics) {
    const gapKeys = buildLinacGapPinKeySet(metrics && metrics.linacGapWalmartPins);
    const systemicKeys = buildLinacGapPinKeySet(metrics && metrics.systemicGapWalmartPins);
    osrmLinacGapPinKeys = gapKeys;
    osrmSystemicGapPinKeys = systemicKeys;

    let viable = 0;
    let systemic = 0;
    walmartMarkers.forEach((marker) => {
        const w = marker.walmartData;
        let isSystemic = false;
        let isGap = false;
        if (w) {
            const lat = Number(w.latitude);
            const lng = Number(w.longitude);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                const key = pinCoordKey(lat, lng);
                isSystemic = systemicKeys.has(key);
                isGap = isSystemic || gapKeys.has(key);
            }
        }
        marker._isLinacGap = isGap;
        marker._isSystemicGap = isSystemic;
        if (isGap) {
            if (isSystemic) systemic++; else viable++;
        }
    });

    gapViableCount = viable;
    gapSystemicCount = systemic;
    gapContextMinutes = getDriveTimeMinutes();
    gapContextHospMin = metrics && Number.isFinite(metrics.hospitalBackstopMinutes)
        ? metrics.hospitalBackstopMinutes
        : HOSPITAL_BACKSTOP_MINUTES;
}

/** Popup HTML for a Walmart marker depending on how it is currently being shown. */
function walmartPopupHTML(marker, mode) {
    const w = marker.walmartData || {};
    const addr = [
        w.street_address ? String(w.street_address) : '',
        [w.city, w.state].filter(Boolean).join(', ')
    ].filter(Boolean).map(escapePopupText).join('<br>');
    const name = escapePopupText(w.name || 'Walmart');
    const tail = `${name}${addr ? `<br>${addr}` : ''}`;
    if (mode === 'systemic') {
        return `<strong>Walmart — Systemic gap</strong> (OSRM)<br>No LINAC within ${escapePopupText(gapContextMinutes)} min and no general acute or critical access hospital within ${escapePopupText(gapContextHospMin)} min.<br>${tail}`;
    }
    if (mode === 'gap') {
        return `<strong>Walmart — LINAC gap</strong> (OSRM)<br>No LINAC within ${escapePopupText(gapContextMinutes)} min.<br>${tail}`;
    }
    return `<strong>Walmart</strong><br>${tail}`;
}

/**
 * Apply the current layer-toggle state to all markers. A Walmart that is a gap renders red/violet
 * only while the LINAC Gaps layer is on; otherwise it renders as a plain blue Walmart (or hides).
 */
function applyLayerVisibility() {
    const ls = getLayerState();

    hospitalMarkers.forEach((m) => {
        m.setOpacity(ls.hospitals ? 1 : 0);
        if (!ls.hospitals) m.closePopup();
    });
    linacMarkers.forEach((m) => {
        m.setOpacity(ls.linac ? 1 : 0);
        if (!ls.linac) m.closePopup();
    });

    walmartMarkers.forEach((marker) => {
        let mode = null;
        if (ls.gaps && marker._isLinacGap) {
            mode = marker._isSystemicGap ? 'systemic' : 'gap';
            marker.setIcon(mode === 'systemic' ? violetMarkerIcon : redMarkerIcon);
            marker.setZIndexOffset(mode === 'systemic' ? Z_INDEX_SYSTEMIC : Z_INDEX_GAP);
            marker.setOpacity(1);
        } else if (ls.walmarts) {
            mode = 'walmart';
            marker.setIcon(blueMarkerIcon);
            marker.setZIndexOffset(Z_INDEX_WALMART);
            marker.setOpacity(1);
        } else {
            marker.setOpacity(0);
            marker.closePopup();
        }
        marker._popupMode = mode;
        if (mode) {
            marker.setPopupContent(walmartPopupHTML(marker, mode));
        }
    });
}

/** Discard any computed gap classification (e.g. when state or drive time changes). */
function invalidateGaps() {
    gapsComputed = false;
    osrmLinacGapPinKeys = null;
    osrmSystemicGapPinKeys = null;
    gapViableCount = 0;
    gapSystemicCount = 0;
    walmartMarkers.forEach((m) => {
        m._isLinacGap = false;
        m._isSystemicGap = false;
    });
    const gapsToggle = document.getElementById('layer-gaps');
    if (gapsToggle) {
        gapsToggle.checked = false;
        gapsToggle.disabled = true;
    }
    if (map) {
        applyLayerVisibility();
        updateLegend();
    }
}

// Add state code to name mapping
const stateNames = {
    'AL': 'Alabama',
    'AK': 'Alaska',
    'AZ': 'Arizona',
    'AR': 'Arkansas',
    'CA': 'California',
    'CO': 'Colorado',
    'CT': 'Connecticut',
    'DC': 'District of Columbia',
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
    'WY': 'Wyoming',
    'US': 'United States'
};

// Initialize the map
async function initializeMap() {
    // Check if the map is already initialized
    if (map) {
        // console.warn('Map is already initialized.');
        return;
    }

    try {
        map = L.map('map', {
            preferCanvas: true,
            wheelDebounceTime: 150,
            wheelPxPerZoomLevel: 120,
            zoomSnap: 0.5,
            zoomDelta: 0.5,
        }).setView([39.8283, -98.5795], 4);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(map);

        // Add legend
        legendControl = L.control({ position: 'bottomleft' });
        legendControl.onAdd = function(map) {
            const div = L.DomUtil.create('div', 'legend');
            div.innerHTML = getLegendHTML();
            return div;
        };
        legendControl.addTo(map);

        // Load US boundary and wait for it to complete
        const response = await fetch('/api/state-boundary/US');
        if (!response.ok) {
            throw new Error('Failed to load US boundary');
        }
        const data = await response.json();
        usBoundaryLayer = L.geoJSON(data[0].geojson, {
            style: {
                color: '#0d6efd',
                weight: 2,
                fillOpacity: 0.05
            }
        }).addTo(map);

        // Only load markers after boundary is loaded
        await loadInitialMarkers();
    } catch (error) {
        console.error('Error initializing map:', error);
        hideLoadingOverlay();
    }
}

// Add helper function to validate coordinates
function isValidUSCoordinate(lat, lng) {
    // Rough bounding box for continental US, Alaska, and Hawaii
    const bounds = {
        continental: {
            lat: { min: 24.396308, max: 49.384358 },
            lng: { min: -125.000000, max: -66.934570 }
        },
        alaska: {
            lat: { min: 51.214183, max: 71.365162 },
            lng: { min: -179.148909, max: -130.001476 }
        },
        hawaii: {
            lat: { min: 18.910361, max: 22.236428 },
            lng: { min: -160.236328, max: -154.808349 }
        }
    };

    // Check if coordinates are within any of the US regions
    return (
        // Continental US
        (lat >= bounds.continental.lat.min && lat <= bounds.continental.lat.max &&
         lng >= bounds.continental.lng.min && lng <= bounds.continental.lng.max) ||
        // Alaska
        (lat >= bounds.alaska.lat.min && lat <= bounds.alaska.lat.max &&
         lng >= bounds.alaska.lng.min && lng <= bounds.alaska.lng.max) ||
        // Hawaii
        (lat >= bounds.hawaii.lat.min && lat <= bounds.hawaii.lat.max &&
         lng >= bounds.hawaii.lng.min && lng <= bounds.hawaii.lng.max)
    );
}

// Helper function to create a cacheBusting URL
function createCacheBustingUrl(url) {
    const cacheBuster = Date.now();
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}_=${cacheBuster}`;
}

async function parseJsonOrThrow(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const msg =
            body && typeof body === 'object' && body.message
                ? String(body.message)
                : body && typeof body === 'object' && body.error
                  ? String(body.error)
                  : `HTTP ${response.status}`;
        throw new Error(msg);
    }
    return body;
}

// Update all fetch calls to use cacheBusting
async function fetchWithCacheBusting(url, options = {}) {
    const cacheBustingUrl = createCacheBustingUrl(url);
    const response = await fetch(cacheBustingUrl, {
        ...options,
        headers: {
            ...options.headers,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        }
    });
    return parseJsonOrThrow(response);
}

// Update loadInitialMarkers function
async function loadInitialMarkers() {
    try {
        const response = await fetchWithCacheBusting('/api/map-data?initial=true');
        const data = response;
        
        clearMap();
        
        // Create a counter for loaded markers
        let loadedMarkers = 0;
        const hospitalsRaw = Array.isArray(data.hospital) ? data.hospital : [];
        const totalMarkers = data.walmart.length + data.linac.length + hospitalsRaw.length;

        // Add Walmart markers
        data.walmart.forEach(location => {
            if (!location.latitude || !location.longitude) {
                loadedMarkers++;
                checkLoadingComplete(loadedMarkers, totalMarkers);
                return;
            }

            const latLng = L.latLng(location.latitude, location.longitude);
            
            // Only add marker if within US bounds
            if (usBoundaryLayer && usBoundaryLayer.getBounds().contains(latLng)) {
                const marker = L.marker(latLng, {
                    icon: blueMarkerIcon,
                    zIndexOffset: Z_INDEX_WALMART
                }).addTo(map);

                // Attach source row so the sidebar can bucket by w.state (matches /api/metrics)
                // instead of doing client-side point-in-polygon (which disagreed on border / mislabeled rows).
                marker.walmartData = location;

                marker.bindPopup(`
                    <strong>Walmart</strong><br>
                    ${location.name}<br>
                    ${location.street_address}<br>
                    ${location.city}, ${location.state}
                `);

                walmartMarkers.push(marker);
            }
            loadedMarkers++;
            checkLoadingComplete(loadedMarkers, totalMarkers);
        });

        // Count LINAC entries with missing coordinates
        const missingCoordinates = data.linac.filter(location => 
            !location.Latitude || !location.Longitude || 
            isNaN(location.Latitude) || isNaN(location.Longitude)
        ).length;

        // Count LINAC entries outside US bounds
        const outsideUSBounds = data.linac.filter(location => {
            if (!location.Latitude || !location.Longitude || 
                isNaN(location.Latitude) || isNaN(location.Longitude)) {
                return false;
            }
            return !isValidUSCoordinate(parseFloat(location.Latitude), parseFloat(location.Longitude));
        }).length;

        // Add LINAC markers
        data.linac.forEach(location => {
            if (!location.Latitude || !location.Longitude || 
                isNaN(location.Latitude) || isNaN(location.Longitude)) {
                loadedMarkers++;
                checkLoadingComplete(loadedMarkers, totalMarkers);
                return;
            }

            const latLng = L.latLng(location.Latitude, location.Longitude);
            
            if (isValidUSCoordinate(parseFloat(location.Latitude), parseFloat(location.Longitude)) &&
                (!usBoundaryLayer || usBoundaryLayer.getBounds().contains(latLng))) {
                const marker = L.marker(latLng, {
                    icon: greenMarkerIcon,
                    zIndexOffset: Z_INDEX_LINAC
                }).addTo(map);
                
                // Store the original LINAC data with the marker for side nav access
                marker.linacData = location;
                
                marker.bindPopup(`
                    <strong>LINAC Center</strong><br>
                    ${location['LINAC Name']}
                `);
                
                // Add click event handler for LINAC markers
                marker.on('click', function() {
                    flyMapTo(latLng, 12);
                });

                linacMarkers.push(marker);
            }
            loadedMarkers++;
            checkLoadingComplete(loadedMarkers, totalMarkers);
        });

        hospitalsRaw.forEach((hospital) => {
            const lat = parseFloat(String(hospital.LATITUDE));
            const lon = parseFloat(String(hospital.LONGITUDE));
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                loadedMarkers++;
                checkLoadingComplete(loadedMarkers, totalMarkers);
                return;
            }
            const latLng = L.latLng(lat, lon);
            if (
                isValidUSCoordinate(lat, lon) &&
                (!usBoundaryLayer || usBoundaryLayer.getBounds().contains(latLng))
            ) {
                const marker = L.marker(latLng, {
                    icon: orangeMarkerIcon,
                    zIndexOffset: Z_INDEX_HOSPITAL
                }).addTo(map);
                marker.hospitalData = hospital;
                marker.bindPopup(`
                    <strong>General acute or critical access hospital</strong><br>
                    ${hospital.NAME}<br>
                    ${hospital.CITY}, ${hospital.STATE}
                `);
                marker.on('click', function () {
                    flyMapTo(latLng, 12);
                });
                hospitalMarkers.push(marker);
            }
            loadedMarkers++;
            checkLoadingComplete(loadedMarkers, totalMarkers);
        });

        console.log(
            `[Map] Loaded from /api/map-data: ${data.walmart.length} Walmarts, ${data.linac.length} LINAC rows, general acute & critical access hospitals ${hospitalsRaw.length} (OPEN; markers inside US polygon + bbox)`
        );
        console.log(`Total LINAC Centers displayed on map (red markers): ${linacMarkers.length}`);
        console.log(`Total general acute & critical access hospitals displayed (yellow pins): ${hospitalMarkers.length}`);
        console.log(`LINAC entries with missing/invalid coordinates: ${missingCoordinates}`);
        console.log(`LINAC entries with coordinates outside US bounds: ${outsideUSBounds}`);
    } catch (error) {
        console.error('Error loading initial markers:', error);
        hideLoadingOverlay();
    }
}

// Update checkLoadingComplete function
function checkLoadingComplete(loaded, total) {
    // console.log(`Loading progress: ${loaded}/${total}`);
    if (loaded >= total) {
        // console.log('Loading complete, hiding overlay');
        hideLoadingOverlay();
    }
}

function hideLoadingOverlay() {
    const overlay = document.getElementById('loading-overlay');
    if (!overlay) {
        return;
    }
    overlay.classList.add('fade-out');
    // Remove the overlay from DOM after fade animation
    setTimeout(() => {
        overlay.remove();
    }, 300);
}

// Initialize event listeners
function initializeEventListeners() {
    const driveTimeSlider = document.getElementById('max-drive-minutes');
    const driveTimeValueLabel = document.getElementById('max-drive-minutes-value');
    const stateSelect = document.getElementById('state');
    const analyzeButton = document.getElementById('analyze');

    // Drive time changes invalidate any computed gaps (they are drive-time specific); the user
    // must Run Analysis again to recompute. The other layers are unaffected.
    driveTimeSlider.addEventListener('input', (e) => {
        const minutes = e.target.value;
        driveTimeValueLabel.textContent = minutes;
        console.log(`[Frontend] Max drive time changed to: ${minutes} min`);
        if (gapsComputed) {
            invalidateGaps();
        }
    });

    // Changing the state also invalidates gaps until the next Run Analysis.
    stateSelect.addEventListener('change', () => {
        if (gapsComputed) {
            invalidateGaps();
        }
    });

    // Map layer toggles — pure show/hide, no recompute.
    ['layer-walmarts', 'layer-hospitals', 'layer-linac', 'layer-gaps'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', () => {
                applyLayerVisibility();
                updateLegend();
                updateLocationList();
            });
        }
    });

    // Only update analysis when analyze button is clicked
    analyzeButton.addEventListener('click', updateAnalysis);
    
    // Remove automatic updates on slider and city changes
    // radiusSlider.addEventListener('change', updateAnalysis);
    // citySelect.addEventListener('change', updateAnalysis);

    // Add toggle button listeners
    document.getElementById('walmart-toggle').addEventListener('change', updateLocationList);
    document.getElementById('linac-toggle').addEventListener('change', updateLocationList);

    // Update dashboard button click handler
    document.getElementById('dashboard-button').addEventListener('click', async () => {
        const selectedState = document.getElementById('state').value;
        const minutes = getDriveTimeMinutes();
        
        // Reset the modal content back to the dashboard view
        const modalContent = document.getElementById('dashboard-modal');
        modalContent.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title" id="dashboard-title">Dashboard</h5>
                    <button type="button" class="btn-close" id="close-modal"></button>
                </div>
                <div class="modal-body">
                    <div id="modal-dashboard-metrics" class="dashboard-grid"></div>
                </div>
            </div>
        `;

        // Reattach close button listener
        document.getElementById('close-modal').addEventListener('click', () => {
            document.getElementById('modal-overlay').classList.add('d-none');
            document.getElementById('dashboard-modal').classList.add('d-none');
        });

        const dashboardTitle = document.getElementById('dashboard-title');
        // Update title with selected state
        if (selectedState && selectedState !== 'all') {
            dashboardTitle.textContent = `Dashboard - ${stateNames[selectedState] || selectedState}`;
        } else {
            dashboardTitle.textContent = 'Dashboard';
        }

        // Show loading state in modal
        document.getElementById('modal-dashboard-metrics').innerHTML = `
            <div class="text-center">
                <div class="spinner-border text-primary" role="status">
                    <span class="visually-hidden">Loading...</span>
                </div>
            </div>
        `;
        
        // Show the modal
        document.getElementById('modal-overlay').classList.remove('d-none');
        document.getElementById('dashboard-modal').classList.remove('d-none');

        // Fetch and display metrics for the current state
        try {
            const response = await fetch(
                `/api/metrics?state=${encodeURIComponent(selectedState)}&driveTimeMinutes=${encodeURIComponent(minutes)}`
            );
            const metrics = await parseJsonOrThrow(response);

            document.getElementById('modal-dashboard-metrics').innerHTML = formatDashboardCardsHTML(
                metrics,
                minutes
            );
        } catch (error) {
            console.error('Error fetching metrics:', error);
            const safe = String(error.message || error).replace(/</g, '&lt;');
            document.getElementById('modal-dashboard-metrics').innerHTML = `
                <div class="alert alert-danger m-3" role="alert">${safe}</div>
            `;
            document.getElementById('modal-dashboard-metrics').innerHTML = `
                <div class="alert alert-danger">
                    Error loading metrics. Please try again later.
                </div>
            `;
        }
    });

    document.getElementById('close-modal').addEventListener('click', () => {
        document.getElementById('modal-overlay').classList.add('d-none');
        document.getElementById('dashboard-modal').classList.add('d-none');
    });

    // Close modal when clicking overlay
    document.getElementById('modal-overlay').addEventListener('click', () => {
        document.getElementById('modal-overlay').classList.add('d-none');
        document.getElementById('dashboard-modal').classList.add('d-none');
    });

    // Add table view button listener
    document.getElementById('table-view-button').addEventListener('click', () => {
        document.getElementById('modal-overlay').classList.remove('d-none');
        document.getElementById('dashboard-modal').classList.remove('d-none');
        createMetricsTable();
    });
}

// Update clearMap function
function clearMap() {
    walmartMarkers.forEach((marker) => marker.remove());
    linacMarkers.forEach((marker) => marker.remove());
    hospitalMarkers.forEach((marker) => marker.remove());
    walmartMarkers = [];
    linacMarkers = [];
    hospitalMarkers = [];
}

// Update map markers
function updateMapMarkers(data) {
    const selectedCity = document.getElementById('city').value;

    if (selectedCity && selectedCity !== 'all' && data.cityCenter.length > 0) {
        const selectedLocation = data.cityCenter[0];

        console.log('Selected city center:', selectedLocation);

        const lonRaw = selectedLocation.Longitude != null ? selectedLocation.Longitude : selectedLocation.Longtitude;
        if (!selectedLocation.Latitude || lonRaw == null) {
            console.error('Invalid city center coordinates:', selectedLocation);
            return;
        }

        const lat = parseFloat(selectedLocation.Latitude);
        const lng = parseFloat(lonRaw);
        map.setView([lat, lng], 10);
    }
}

// Update displayMetrics function
function displayMetrics(metrics) {
    // Don't do anything if we're in table view
    const tableViewActive = document.getElementById('metrics-table-body') !== null;
    if (tableViewActive) {
        return;
    }

    // Only update the modal metrics
    const modalMetricsContainer = document.getElementById('modal-dashboard-metrics');
    if (!modalMetricsContainer) {
        return;
    }
    
    if (metrics) {
        const minutes = getDriveTimeMinutes();
        modalMetricsContainer.innerHTML = formatDashboardCardsHTML(metrics, minutes);
    } else {
        modalMetricsContainer.innerHTML = '';
    }
}

// Fetch and populate cities dropdown
async function populateCityDropdown() {
    try {
        const response = await fetch('/api/cities');
        const cities = await response.json();
        
        const citySelect = document.getElementById('city');
        cities.forEach(city => {
            const option = document.createElement('option');
            option.value = city;  // This is correct as it uses the Cities property from LINAC data
            option.textContent = city;
            citySelect.appendChild(option);
        });
    } catch (error) {
        console.error('Error loading cities:', error);
    }
}

// Update dashboard metrics
async function updateDashboardMetrics() {
    try {
        const minutes = getDriveTimeMinutes();
        const state = document.getElementById('state').value;
        
        const response = await fetch(
            `/api/metrics?state=${encodeURIComponent(state)}&driveTimeMinutes=${encodeURIComponent(minutes)}`
        );
        const metrics = await parseJsonOrThrow(response);

        displayMetrics(metrics);
    } catch (error) {
        console.error('Error updating metrics:', error);
        const mEl = document.getElementById('modal-dashboard-metrics');
        if (mEl) {
            const safe = String(error.message || error).replace(/</g, '&lt;');
            mEl.innerHTML = `<div class="alert alert-danger m-3" role="alert">${safe}</div>`;
        }
    }
}

// Update map data
async function updateMapData() {
    try {
        const minutes = getDriveTimeMinutes();
        const city = document.getElementById('city').value;
        
        const response = await fetch(`/api/map-data?driveTimeMinutes=${encodeURIComponent(minutes)}&city=${city}`);
        const data = await response.json();
        
        updateMapMarkers(data);
    } catch (error) {
        console.error('Error updating map:', error);
    }
}

// Add these functions to handle loading states
function showLoading() {
    // Create and show the loading overlay
    const overlay = document.createElement('div');
    overlay.id = 'loading-overlay';
    overlay.innerHTML = `
        <div class="spinner-border text-primary" role="status">
            <span class="visually-hidden">Loading...</span>
        </div>
    `;
    document.body.appendChild(overlay);
}

/**
 * Loading overlay for Run Analysis. A single OSRM request gives no real sub-progress, so the bar
 * eases toward ~95% while the request is in flight and jumps to 100% on completion. Returns a
 * handle with finish() to call once the work is done.
 */
function showAnalysisLoading(note) {
    const existing = document.getElementById('loading-overlay');
    if (existing) existing.remove();

    const message = note || 'Running intensive OSRM drive-time calculations — this can take a minute or two.';

    const overlay = document.createElement('div');
    overlay.id = 'loading-overlay';
    overlay.innerHTML = `
        <div class="analysis-loading text-center">
            <div id="analysis-progress-label" class="analysis-progress-label mb-2">0%</div>
            <div class="progress mb-3" role="progressbar" aria-label="Analysis progress">
                <div id="analysis-progress-bar" class="progress-bar progress-bar-striped progress-bar-animated" style="width: 0%"></div>
            </div>
            <div class="analysis-loading-note text-muted small">${message}</div>
        </div>
    `;
    document.body.appendChild(overlay);

    const bar = overlay.querySelector('#analysis-progress-bar');
    const label = overlay.querySelector('#analysis-progress-label');
    let pct = 0;
    let done = false;

    const timer = setInterval(() => {
        if (done) return;
        // Ease toward 95% (slows as it approaches), then hold until finish().
        pct += Math.max(0.4, (95 - pct) * 0.05);
        if (pct > 95) pct = 95;
        if (bar) bar.style.width = `${pct}%`;
        if (label) label.textContent = `${Math.round(pct)}%`;
    }, 200);

    return {
        finish() {
            if (done) return;
            done = true;
            clearInterval(timer);
            if (bar) bar.style.width = '100%';
            if (label) label.textContent = '100%';
            setTimeout(() => {
                overlay.classList.add('fade-out');
                setTimeout(() => overlay.remove(), 300);
            }, 250);
        }
    };
}

// Update hideLoading function to include a smooth transition
function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.classList.add('fade-out');
        // Remove the overlay from DOM after fade animation
        setTimeout(() => {
            overlay.remove();
        }, 300);
    }
}

// Update populateStateDropdown to set initial US selection
async function populateStateDropdown() {
    try {
        const states = await fetchWithCacheBusting('/api/states');
        
        const stateSelect = document.getElementById('state');
        
        // Add the default "Select State" option
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = 'Select State';
        defaultOption.disabled = true;
        stateSelect.insertBefore(defaultOption, stateSelect.firstChild);
        
        // Add US option
        const usOption = document.createElement('option');
        usOption.value = 'US';
        usOption.textContent = 'United States';
        stateSelect.insertBefore(usOption, stateSelect.firstChild);
        
        // Add all states with full names
        states.forEach(stateCode => {
            const option = document.createElement('option');
            option.value = stateCode;
            option.textContent = stateNames[stateCode] || stateCode; // Fallback to code if name not found
            stateSelect.appendChild(option);
        });

        // Set initial selection to US
        stateSelect.value = 'US';

        // Markers are already loaded in initializeMap → loadInitialMarkers(); do not call again here
    } catch (error) {
        console.error('Error loading states:', error);
    }
}

// Update loadStateBoundary function
async function loadStateBoundary(state) {
    try {
        // Clear existing state boundary
        if (stateLayer) {
            map.removeLayer(stateLayer);
            stateLayer = null;
        }

        const data = await fetchWithCacheBusting(`/api/state-boundary/${state}`);
        
        if (!data || !data[0] || !data[0].geojson) {
            throw new Error('Invalid GeoJSON data received');
        }

        stateLayer = L.geoJSON(data[0].geojson, {
            style: {
                color: '#0d6efd',
                weight: 2,
                fillOpacity: 0.1
            }
        }).addTo(map);
        
        // Special handling for Alaska
        if (state === 'AK') {
            // Custom bounds for Alaska that exclude far western Aleutian Islands
            const akBounds = L.latLngBounds(
                L.latLng(51.214183, -179.148909),
                L.latLng(71.365162, -130.001476)
            );
            map.fitBounds(akBounds, {
                padding: [50, 50],
                maxZoom: 5
            });
        } else {
            map.fitBounds(stateLayer.getBounds(), {
                padding: [50, 50]
            });
        }
        
        return true;
    } catch (error) {
        console.error('Error loading state boundary:', error);
        console.error('Error details:', {
            message: error.message,
            stack: error.stack
        });
        return false;
    }
}

// Update updateAnalysis function to properly filter markers
async function updateAnalysis() {
    const state = document.getElementById('state').value;

    if (!state || state === 'all') {
        // console.log('No state selected');
        document.getElementById('location-list').classList.add('d-none');
        return;
    }

    let progress = null;
    try {
        const loadingNote = state === 'US'
            ? 'Running intensive OSRM drive-time calculations for every state — the nationwide run can take several minutes.'
            : 'Running intensive OSRM drive-time calculations — this can take a minute or two.';
        progress = showAnalysisLoading(loadingNote);

        // A fresh analysis invalidates any previously computed gaps until this one completes.
        gapsComputed = false;

        // Show the "Dashboard" button
        document.getElementById('dashboard-button').classList.remove('d-none');
        // Show the location toggle buttons
        document.getElementById('location-toggle-container').classList.remove('d-none');
        // Show the location list container
        document.getElementById('location-list').classList.remove('d-none');

        // Remove US boundary if it exists
        if (usBoundaryLayer) {
            map.removeLayer(usBoundaryLayer);
            usBoundaryLayer = null;
        }

        const minutes = getDriveTimeMinutes();
        let metrics;

        if (state === 'US') {
            // Clear any existing state boundary
            if (stateLayer) {
                map.removeLayer(stateLayer);
                stateLayer = null;
            }

            // Set view to continental US
            map.setView([39.8283, -98.5795], 4);

            // Add back the US boundary for US view
            const response = await fetch('/api/state-boundary/US');
            if (response.ok) {
                const data = await response.json();
                usBoundaryLayer = L.geoJSON(data[0].geojson, {
                    style: {
                        color: '#0d6efd',
                        weight: 2,
                        fillOpacity: 0.05
                    }
                }).addTo(map);
            }

            const metricsResponse = await fetch(
                `/api/metrics?state=US&driveTimeMinutes=${encodeURIComponent(minutes)}`
            );
            metrics = await parseJsonOrThrow(metricsResponse);
        } else {
            // Load state boundary and wait for result
            const boundaryLoaded = await loadStateBoundary(state);
            if (!boundaryLoaded || !stateLayer) {
                throw new Error('Failed to load state boundary');
            }

            const response = await fetch(
                `/api/metrics?state=${encodeURIComponent(state)}&driveTimeMinutes=${encodeURIComponent(minutes)}`
            );
            metrics = await parseJsonOrThrow(response);
        }

        // Classify gaps, then default the view to LINAC Centers + LINAC Gaps only (Walmarts and
        // Hospitals off, but still available to toggle on). Render everything per the toggles.
        classifyWalmartGaps(metrics);
        gapsComputed = true;
        const gapsToggle = document.getElementById('layer-gaps');
        if (gapsToggle) {
            gapsToggle.disabled = false;
            gapsToggle.checked = true;
        }
        const walmartsToggle = document.getElementById('layer-walmarts');
        if (walmartsToggle) walmartsToggle.checked = false;
        const hospitalsToggle = document.getElementById('layer-hospitals');
        if (hospitalsToggle) hospitalsToggle.checked = false;
        const linacToggle = document.getElementById('layer-linac');
        if (linacToggle) linacToggle.checked = true;

        displayMetrics(metrics);
        applyLayerVisibility();
        updateLegend();
        updateLocationList();

        if (progress) progress.finish();
    } catch (error) {
        console.error('Error updating analysis:', error);
        if (progress) progress.finish();
    }
}

// Update the location list function to only show visible Walmart markers
function updateLocationList() {
    const listContainer = document.getElementById('location-list');
    const showWalmart = document.getElementById('walmart-toggle').checked;
    const selectedState = document.getElementById('state').value;

    listContainer.innerHTML = '';
    let locationsFound = 0;
    
    if (showWalmart) {
        walmartMarkers.forEach(marker => {
            // Bucket by the store's declared state field — matches /api/metrics. Previously used
            // point-in-polygon, which silently disagreed with the dashboard on border / mislabeled rows.
            const isVisuallyPresent = marker.options.opacity !== 0;
            let shouldShow = false;

            if (selectedState === 'US') {
                shouldShow = isVisuallyPresent;
            } else {
                shouldShow = marker.walmartData && marker.walmartData.state === selectedState && isVisuallyPresent;
            }
            
            if (shouldShow) {
                const location = marker.getLatLng();
                const popup = marker.getPopup();
                const content = popup.getContent();
                
                const div = document.createElement('div');
                div.className = 'location-item';
                
                // For LINACs, create custom content that includes the Number of LINACs field
                if (marker.linacData) {
                    div.innerHTML = `
                        <strong>LINAC Center</strong><br>
                        ${marker.linacData['LINAC Name']}<br>
                        Number of LINACs: ${marker.linacData['Number of LINACs']}
                    `;
                } else {
                    div.innerHTML = content;
                }
                
                div.addEventListener('click', () => {
                    flyMapTo(location, 12);
                    marker.openPopup();
                });
                
                listContainer.appendChild(div);
                locationsFound++;
            }
        });
    } else {
        linacMarkers.forEach(marker => {
            // Bucket by the center's States field — matches /api/metrics inventory counts.
            // Previously used point-in-polygon, which disagreed for mislabeled / border rows.
            let shouldShow = false;

            if (selectedState === 'US') {
                shouldShow = true;
            } else {
                shouldShow = marker.linacData && marker.linacData.States === selectedState;
            }
            
            if (shouldShow) {
                const location = marker.getLatLng();
                const popup = marker.getPopup();
                const content = popup.getContent();
                
                const div = document.createElement('div');
                div.className = 'location-item';
                
                // For LINACs, create custom content that includes the Number of LINACs field
                if (marker.linacData) {
                    div.innerHTML = `
                        <strong>LINAC Center</strong><br>
                        ${marker.linacData['LINAC Name']}<br>
                        Number of LINACs: ${marker.linacData['Number of LINACs']}
                    `;
                } else {
                    div.innerHTML = content;
                }
                
                div.addEventListener('click', () => {
                    flyMapTo(location, 12);
                    marker.openPopup();
                });
                
                listContainer.appendChild(div);
                locationsFound++;
            }
        });
    }

    if (locationsFound === 0) {
        const emptyMessage = document.createElement('div');
        emptyMessage.className = 'location-item text-center text-muted';
        emptyMessage.innerHTML = 'None Found';
        listContainer.appendChild(emptyMessage);
    }
}

// Initialize the application
async function initializeApp() {
    // The loading overlay is already visible from the HTML
    await initializeMap();
    initializeEventListeners();
    
    // Ensure dashboard button and location toggle are hidden on initial load
    document.getElementById('dashboard-button').classList.add('d-none');
    document.getElementById('location-toggle-container').classList.add('d-none');
    
    await populateStateDropdown();

    // Apply the default layer toggles (Walmarts + Hospitals + LINAC Centers on, Gaps off) and
    // sync the legend to what is actually visible.
    applyLayerVisibility();
    updateLegend();
}

// Call initialization when the page loads
document.addEventListener('DOMContentLoaded', initializeApp);

// Update createMetricsTable function
function createMetricsTable() {
    const minutes = getDriveTimeMinutes();
    const modalContent = document.getElementById('dashboard-modal');
    modalContent.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h5 class="modal-title">Metrics Table</h5>
                <div>
                    <button type="button" class="btn btn-sm btn-primary me-2" id="download-csv">
                        <i class="fas fa-download"></i> CSV
                    </button>
                    <button type="button" class="btn btn-sm btn-primary me-2" id="download-json">
                        <i class="fas fa-download"></i> JSON
                    </button>
                    <button type="button" class="btn-close" id="close-modal"></button>
                </div>
            </div>
            <div class="modal-body" style="max-height: 80vh; overflow-y: auto;">
                <div class="metrics-table-container">
                    <table class="metrics-table">
                        <thead class="metrics-table-header">
                            <tr>
                                <th>State</th>
                                <th class="text-end">
                                    <div>No LINAC within ${minutes} min (OSRM)</div>
                                    <div class="small text-muted fw-normal mt-1 lh-sm">Incl. bordering states. Cross-border excludes AK, HI &amp; PR LINACs; those rows use in-state LINACs only.</div>
                                </th>
                                <th class="text-end">
                                    <div>Viable gap</div>
                                    <div class="small text-muted fw-normal mt-1 lh-sm">LINAC gap with general acute or critical access hospital within ${HOSPITAL_BACKSTOP_MINUTES} min.</div>
                                </th>
                                <th class="text-end">
                                    <div>Systemic gap</div>
                                    <div class="small text-muted fw-normal mt-1 lh-sm">LINAC gap, no general acute or critical access hospital within ${HOSPITAL_BACKSTOP_MINUTES} min.</div>
                                </th>
                                <th class="text-end">Total<br>Walmarts</th>
                                <th class="text-end">LINAC<br>Centers</th>
                                <th class="text-end">Total<br>LINACs</th>
                            </tr>
                        </thead>
                        <tbody id="metrics-table-body">
                            <tr>
                                <td colspan="7" class="text-center">
                                    <div class="spinner-border text-primary" role="status">
                                        <span class="visually-hidden">Loading...</span>
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;

    // Reattach close button listener
    document.getElementById('close-modal').addEventListener('click', () => {
        document.getElementById('modal-overlay').classList.add('d-none');
        document.getElementById('dashboard-modal').classList.add('d-none');
    });

    // Add download button listeners
    document.getElementById('download-csv').addEventListener('click', downloadMetricsCSV);
    document.getElementById('download-json').addEventListener('click', downloadMetricsJSON);

    // Populate table data
    populateTableData();
}

// Add new function to handle CSV download
function downloadMetricsCSV() {
    const minutes = getDriveTimeMinutes();
    const table = document.querySelector('.metrics-table');
    let csvContent = `State,No LINAC Within ${minutes} Min (OSRM),Viable Gap (General acute or critical access hospital ${HOSPITAL_BACKSTOP_MINUTES} min),Systemic Gap (no hospital within ${HOSPITAL_BACKSTOP_MINUTES} min),Total Walmarts,LINAC Centers,Total LINACs\n`;

    // Get all table rows
    const rows = table.querySelectorAll('tbody tr');
    
    // Convert each row to CSV
    rows.forEach((row) => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 7 || row.id === 'metrics-table-loading-banner') {
            return;
        }
        const rowData = Array.from(cells)
            .map(cell => {
                // Remove commas from numbers and any special characters
                let text = cell.textContent.trim().replace(/,/g, '');
                // If the cell contains numbers, return as is, otherwise wrap in quotes
                return isNaN(text) ? `"${text}"` : text;
            })
            .join(',');
        csvContent += rowData + '\n';
    });

    // Create and trigger download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', `linac-walmart-metrics-${minutes}min-osrm.csv`);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Add new function to handle JSON download
function downloadMetricsJSON() {
    const minutes = getDriveTimeMinutes();
    const table = document.querySelector('.metrics-table');
    const rows = table.querySelectorAll('tbody tr');
    const jsonData = [];
    
    // Convert each row to a JSON object
    rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 7 || row.id === 'metrics-table-loading-banner') {
            return;
        }
        const state = cells[0].textContent.trim();
        const walmartsOutsideRange = parseInt(cells[1].textContent.replace(/,/g, '')) || 0;
        const viableGapWalmarts = parseInt(cells[2].textContent.replace(/,/g, '')) || 0;
        const systemicGapWalmarts = parseInt(cells[3].textContent.replace(/,/g, '')) || 0;
        const totalWalmarts = parseInt(cells[4].textContent.replace(/,/g, '')) || 0;
        const linacCenters = parseInt(cells[5].textContent.replace(/,/g, '')) || 0;
        const totalLinacs = parseInt(cells[6].textContent.replace(/,/g, '')) || 0;

        jsonData.push({
            state,
            walmartsOutsideRange,
            viableGapWalmarts,
            systemicGapWalmarts,
            totalWalmarts,
            linacCenters,
            totalLinacs,
            driveTimeMinutes: parseInt(minutes, 10),
            hospitalBackstopMinutes: HOSPITAL_BACKSTOP_MINUTES
        });
    });
    
    // Create and trigger download
    const jsonString = JSON.stringify(jsonData, null, 2); // Pretty print with 2 spaces
    const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', `linac-walmart-metrics-${minutes}min-osrm.json`);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function metricsTableLoadingRow(doneStates, totalStates) {
    return `
            <tr id="metrics-table-loading-banner">
                <td colspan="7" class="text-center py-2 text-muted bg-light border-bottom">
                    <div class="d-flex flex-column justify-content-center align-items-center gap-1 py-2">
                        <div class="d-flex justify-content-center align-items-center gap-2 flex-wrap">
                            <div class="spinner-border spinner-border-sm text-primary" role="status" aria-hidden="true"></div>
                            <span>Loading state metrics (${doneStates} / ${totalStates})...</span>
                        </div>
                        <small class="text-muted fst-italic">Heads up: this can take 10–15 minutes to finish — it runs intensive OSRM drive-time calculations for every state.</small>
                    </div>
                </td>
            </tr>`;
}

function sumMetricsTotals(metricsList) {
    return metricsList.reduce(
        (acc, m) => ({
            walmartsOutsideRange: acc.walmartsOutsideRange + (m.walmartsOutsideRange || 0),
            viableGapWalmarts: acc.viableGapWalmarts + (m.viableGapWalmarts || 0),
            systemicGapWalmarts: acc.systemicGapWalmarts + (m.systemicGapWalmarts || 0),
            totalWalmarts: acc.totalWalmarts + (m.totalWalmarts || 0),
            cityCentersWithinRange: acc.cityCentersWithinRange + (m.cityCentersWithinRange || 0),
            linacsWithinRange: acc.linacsWithinRange + (m.linacsWithinRange || 0),
            totalHospitals: acc.totalHospitals + (m.totalHospitals || 0)
        }),
        {
            walmartsOutsideRange: 0,
            viableGapWalmarts: 0,
            systemicGapWalmarts: 0,
            totalWalmarts: 0,
            cityCentersWithinRange: 0,
            linacsWithinRange: 0,
            totalHospitals: 0
        }
    );
}

function renderMetricsRow(st, metrics, isStrong) {
    const m = metrics;
    const a = isStrong ? '<strong>' : '';
    const z = isStrong ? '</strong>' : '';
    return `
        <tr${isStrong ? ' class="us-total-row"' : ''}>
            <td>${a}${st}${z}</td>
            <td class="text-end">${a}${(m.walmartsOutsideRange || 0).toLocaleString()}${z}</td>
            <td class="text-end">${a}${(m.viableGapWalmarts || 0).toLocaleString()}${z}</td>
            <td class="text-end">${a}${(m.systemicGapWalmarts || 0).toLocaleString()}${z}</td>
            <td class="text-end">${a}${(m.totalWalmarts || 0).toLocaleString()}${z}</td>
            <td class="text-end">${a}${(m.cityCentersWithinRange || 0).toLocaleString()}${z}</td>
            <td class="text-end">${a}${(m.linacsWithinRange || 0).toLocaleString()}${z}</td>
        </tr>
    `;
}

// Metrics table rows use /api/metrics (OSRM Table on server) — same logic as dashboard, not client Haversine.
async function populateTableData() {
    const tableBody = document.getElementById('metrics-table-body');
    const minutes = getDriveTimeMinutes();
    const CONCURRENCY = 3;

    try {
        const inventoryRes = await fetchWithCacheBusting('/api/hospital-inventory');
        const inventory = inventoryRes.ok ? await inventoryRes.json() : { total: 0, byState: {} };
        const inventoryByState = inventory.byState || {};

        const states = Array.from(document.getElementById('state').options)
            .map((option) => ({ value: option.value, text: option.text }))
            .filter((option) => option.value !== 'all' && option.value !== 'US' && option.value !== '')
            .sort((a, b) => a.text.localeCompare(b.text));

        for (const code of Object.keys(inventoryByState)) {
            if (!states.some((s) => s.value === code)) {
                states.push({ value: code, text: stateNames[code] || code });
            }
        }
        states.sort((a, b) => a.text.localeCompare(b.text));

        const fetchMetrics = (stateCode) =>
            fetchWithCacheBusting(
                `/api/metrics?state=${encodeURIComponent(stateCode)}&driveTimeMinutes=${encodeURIComponent(minutes)}`
            );

        console.log(`[Table] OSRM reachability per state (${minutes} min; cross-border contiguous, AK/HI/PR isolated). US row = sum.`);

        let tableRows = '';
        /** @type {{ walmartsOutsideRange: number, viableGapWalmarts?: number, systemicGapWalmarts?: number, totalWalmarts: number, cityCentersWithinRange: number, linacsWithinRange: number, totalHospitals?: number }[]} */
        const metricsForTotals = [];

        tableBody.innerHTML = metricsTableLoadingRow(0, states.length);

        let doneStates = 0;
        const totalStates = states.length;
        for (let i = 0; i < states.length; i += CONCURRENCY) {
            const slice = states.slice(i, i + CONCURRENCY);
            const batch = await Promise.all(
                slice.map(async (s) => ({
                    state: s,
                    metrics: await fetchMetrics(s.value)
                }))
            );
            doneStates += batch.length;
            for (const { state: st, metrics: m } of batch) {
                tableRows += renderMetricsRow(st.text, m, false);
                metricsForTotals.push(m);
            }

            tableBody.innerHTML =
                metricsTableLoadingRow(doneStates, totalStates) +
                tableRows;
        }

        const usTotals = sumMetricsTotals(metricsForTotals);

        tableBody.innerHTML =
            renderMetricsRow('United States (sum)', usTotals, true) + tableRows;

        const sample = metricsForTotals[0];
        if (sample && !('viableGapWalmarts' in sample)) {
            console.warn(
                '[Table] /api/metrics response missing viableGapWalmarts — restart Node with latest server.js (old process omits gap split). Hard-refresh browser (Ctrl+F5).'
            );
        }

        console.log('[Table] Metrics table ready (US row summed from states).');
    } catch (error) {
        console.error('Error loading table metrics:', error);
        tableBody.innerHTML = `
            <tr>
                <td colspan="7" class="text-center text-danger">
                    Error loading metrics: ${error.message}
                </td>
            </tr>
        `;
    }
}

// Add function to check dataset details
async function checkDatasetDetails() {
    try {
        const response = await fetch('/api/map-data?initial=true');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        
        // Extract information from the response
        const walmartCount = data.walmart ? data.walmart.length : 0;
        const linacCount = data.linac ? data.linac.length : 0;
        
        // Get first and last linac entries to check version
        const firstLinac = data.linac && data.linac.length > 0 ? data.linac[0] : null;
        const lastLinac = data.linac && data.linac.length > 0 ? data.linac[data.linac.length - 1] : null;
        
        console.log('=== Dataset Details ===');
        console.log(`Total Walmart Locations: ${walmartCount}`);
        console.log(`Total LINAC Locations: ${linacCount}`);
        if (firstLinac) {
            console.log('First LINAC Entry:');
            console.log(firstLinac);
        }
        if (lastLinac) {
            console.log('Last LINAC Entry:');
            console.log(lastLinac);
        }
        
        return {
            walmartCount,
            linacCount,
            firstLinac,
            lastLinac
        };
    } catch (error) {
        console.error('Error checking dataset details:', error);
        return null;
    }
}

// Call this function whenever you need to check dataset details
document.addEventListener('DOMContentLoaded', () => {
    // Add this to the existing DOMContentLoaded event listener
    setTimeout(() => {
        checkDatasetDetails();
    }, 1000); // Wait for 1 second after page loads
});

function legendRow(color, label, count) {
    const countLine = (count != null)
        ? `<br><span class="legend-count text-muted">Total Count: ${count.toLocaleString()}</span>`
        : '';
    return `
            <div>
                <img src="/images/markers/marker-icon-${color}.png" alt="${label}">
                <span>${label}${countLine}</span>
            </div>`;
}

/**
 * Dynamic legend: only lists layers actually visible on the map given the current toggle states.
 * Gap entries (which are Walmarts) appear only after a state has been analyzed and the Gaps layer
 * is on, and each is labeled to make clear it is still a Walmart location. For a specific state,
 * each row also shows the total number of pins of that type in the state.
 */
function getLegendHTML() {
    const ls = getLayerState();
    const selectedState = document.getElementById('state')?.value;
    const perState = !!selectedState && selectedState !== 'US' && selectedState !== 'all' && selectedState !== '';

    const walmartCount = perState ? walmartMarkers.filter((m) => m.walmartData && m.walmartData.state === selectedState).length : null;
    const linacCount = perState ? linacMarkers.filter((m) => m.linacData && m.linacData.States === selectedState).length : null;
    const hospitalCount = perState ? hospitalMarkers.filter((m) => m.hospitalData && m.hospitalData.STATE === selectedState).length : null;
    const viableCount = perState ? gapViableCount : null;
    const systemicCount = perState ? gapSystemicCount : null;

    const rows = [];

    if (ls.walmarts) {
        rows.push(legendRow('blue', 'Walmarts', walmartCount));
    }
    if (ls.gaps && gapViableCount > 0) {
        rows.push(legendRow('red', 'Viable LINAC Gaps (Walmarts)', viableCount));
    }
    if (ls.gaps && gapSystemicCount > 0) {
        rows.push(legendRow('violet', 'Systemic LINAC Gaps (Walmarts)', systemicCount));
    }
    if (ls.linac) {
        rows.push(legendRow('green', 'LINAC Centers', linacCount));
    }
    if (ls.hospitals) {
        rows.push(legendRow('orange', 'Hospitals (General Acute &amp; Critical Access)', hospitalCount));
    }

    return rows.join('') || '<div class="text-muted small">No Layers Selected</div>';
}

// Function to update legend
function updateLegend() {
    if (legendControl) {
        // Remove the old legend
        map.removeControl(legendControl);
        
        // Create new legend with updated text
        legendControl = L.control({ position: 'bottomleft' });
        legendControl.onAdd = function(map) {
            const div = L.DomUtil.create('div', 'legend');
            div.innerHTML = getLegendHTML();
            return div;
        };
        legendControl.addTo(map);
    }
}